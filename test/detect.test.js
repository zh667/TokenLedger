import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { GENERIC, PROBE_PATHS, detectRelaySoftware, scoreFingerprint } from "../src/adapters/detect.js";
import { Sub2ApiClient, normalizeUsage } from "../src/adapters/sub2api.js";
import { LEVELS } from "../src/adapters/newapi.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/sub2api.json", import.meta.url), "utf8"));

// Both tables were measured against live deployments on 2026-08-14.
const NEWAPI_STATUSES = {
	"/api/status": 200,
	"/v1/usage": 404,
	"/api/usage/token": 401,
	"/api/log/self": 401,
	"/api/v1/usage": 404,
	"/api/data/self": 401
};
const SUB2API_STATUSES = {
	"/api/status": 404,
	"/v1/usage": 401,
	"/api/usage/token": 404,
	"/api/log/self": 404,
	"/api/v1/usage": 401,
	"/api/data/self": 404
};

test("the two live signatures are recognized from status codes alone", () => {
	const a = scoreFingerprint(NEWAPI_STATUSES);
	assert.equal(a.software, "newapi");
	assert.equal(a.confidence, 1);
	assert.equal(a.billingAvailable, true);

	const b = scoreFingerprint(SUB2API_STATUSES);
	assert.equal(b.software, "sub2api");
	assert.equal(b.confidence, 1);
});

test("an unknown relay degrades to generic rather than being guessed into an adapter", () => {
	const result = scoreFingerprint({
		"/api/status": 404,
		"/v1/usage": 404,
		"/api/usage/token": 404,
		"/api/log/self": 404,
		"/api/v1/usage": 404
	});
	assert.equal(result.software, GENERIC.software);
	assert.equal(result.billingAvailable, false);
	assert.ok(result.reason.includes("no known relay program"));
});

test("negative evidence is load-bearing — a required route alone is not enough", () => {
	// /v1/usage present would satisfy sub2api's requirement, but /api/status
	// present contradicts its absent list, so it must not match.
	const both = { "/api/status": 200, "/v1/usage": 200, "/api/usage/token": 200 };
	const result = scoreFingerprint(both);
	assert.notEqual(result.software, "sub2api");
});

test("a transport failure is not scored as absence", () => {
	// 0 means "we could not tell". It must not satisfy an `absent` test, which
	// would let a dead network invent a confident identification.
	const result = scoreFingerprint({
		"/api/status": 0,
		"/v1/usage": 0,
		"/api/usage/token": 0,
		"/api/log/self": 0,
		"/api/v1/usage": 0
	});
	assert.equal(result.software, GENERIC.software);
});

test("a partial match reports fractional confidence rather than rounding up", () => {
	const partial = { ...NEWAPI_STATUSES, "/api/log/self": 404, "/api/data/self": 404 };
	const result = scoreFingerprint(partial);
	assert.equal(result.software, "newapi");
	assert.ok(result.confidence < 1, `expected reduced confidence, got ${result.confidence}`);
	assert.ok(result.confidence > 0.5);
});

test("detectRelaySoftware probes unauthenticated and never sends a credential", async () => {
	const seen = [];
	const result = await detectRelaySoftware("https://relay.example.com/", {
		fetch: async (url, init) => {
			seen.push({ url: String(url), headers: init.headers });
			const path = new URL(url).pathname;
			return { status: SUB2API_STATUSES[path] ?? 404 };
		}
	});
	assert.equal(result.software, "sub2api");
	assert.equal(result.origin, "https://relay.example.com");
	assert.equal(seen.length, PROBE_PATHS.length);
	for (const call of seen) {
		assert.equal(call.headers.authorization, undefined, "identification must not require a key");
	}
});

// --- Sub2API adapter --------------------------------------------------------

test("Sub2API reports real currency, so no quota conversion is applied", () => {
	const fact = normalizeUsage(FIXTURE.usage);
	assert.equal(fact.currency, "USD");
	assert.equal(fact.balance.amount, 4.76803348);
	assert.equal(fact.balance.currency, "USD");
});

test("list price and actually-deducted cost are kept apart", () => {
	const fact = normalizeUsage(FIXTURE.usage);
	assert.equal(fact.total.listCost, 0.33138075);
	assert.equal(fact.total.actualCost, 0.231966525);
	assert.notEqual(fact.total.listCost, fact.total.actualCost, "a 30% gap that must never be collapsed");
});

test("Sub2API input_tokens excludes cache, the opposite of New API", () => {
	const fact = normalizeUsage(FIXTURE.usage);
	assert.equal(fact.total.inputTokens, 0);
	assert.equal(fact.total.cacheReadTokens, 325_024);
	assert.equal(fact.total.cacheWriteTokens, 17_107);
	// The comparable prompt-side figure is the sum, matching DSH's inputTotal().
	assert.equal(fact.total.promptTokens, 342_131);
});

test("our bucket reading reproduces the site's own total_tokens", () => {
	// An independent check that promptTokens is assembled correctly: the site
	// publishes total_tokens and never says how it is composed.
	const fact = normalizeUsage(FIXTURE.usage);
	assert.equal(fact.total.promptTokens + fact.total.outputTokens, fact.total.reportedTotalTokens);
	assert.equal(fact.total.reportedTotalTokens, 344_609);
});

test("an empty daily_usage is reported as summary-only, not as an empty period", () => {
	const fact = normalizeUsage(FIXTURE.usage);
	assert.equal(fact.level, LEVELS.SUMMARY);
	assert.equal(fact.window, null);
	assert.deepEqual(fact.capabilities, {
		perRequest: false,
		perModel: false,
		perDay: false,
		recomputable: false,
		windowed: false
	});
});

test("a deployment that does populate daily_usage upgrades its own capability", () => {
	const withDaily = {
		...FIXTURE.usage,
		daily_usage: [{ date: "2026-08-13", requests: 2, input_tokens: 10, output_tokens: 5, cost: 0.01 }]
	};
	const fact = normalizeUsage(withDaily);
	assert.equal(fact.capabilities.perDay, true);
	assert.equal(fact.daily[0].day, "2026-08-13");
	assert.equal(fact.daily[0].listCost, 0.01);
});

test("a missing cost is null rather than zero", () => {
	const fact = normalizeUsage({ unit: "USD", usage: { total: { requests: 1 } } });
	assert.equal(fact.total.listCost, null);
	assert.equal(fact.total.actualCost, null);
	assert.equal(fact.total.requests, 1);
});

test("the client sends the key as a header and rejects a query-string form", async () => {
	let seen;
	const client = new Sub2ApiClient({
		origin: "https://relay.example.com",
		getCredential: async () => ({ mode: "key", value: "sk-secret" }),
		fetch: async (url, init) => {
			seen = { url: String(url), headers: init.headers };
			return { ok: true, status: 200, json: async () => FIXTURE.usage };
		}
	});
	const fact = await client.usage();
	assert.equal(seen.url.includes("sk-secret"), false);
	assert.equal(seen.headers.authorization, "Bearer sk-secret");
	assert.equal(fact.balance.amount, 4.76803348);
});

test("an invalid key surfaces as an error, not as a zero balance", async () => {
	const client = new Sub2ApiClient({
		origin: "https://relay.example.com",
		getCredential: async () => ({ mode: "key", value: "bad" }),
		fetch: async () => ({ ok: false, status: 401, json: async () => ({ message: "unauthorized" }) })
	});
	await assert.rejects(() => client.usage(), /failed: 401/);
});

test("key validity and plan are carried, since an exhausted key still answers 200", () => {
	const fact = normalizeUsage(FIXTURE.usage);
	assert.equal(fact.keyValid, true);
	assert.equal(fact.plan.name, "钱包余额");
	assert.equal(fact.plan.mode, "unrestricted");
	assert.equal(normalizeUsage({ ...FIXTURE.usage, isValid: false }).keyValid, false);
});
