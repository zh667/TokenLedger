import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
	DEFAULT_QUOTA_PER_UNIT,
	LEVELS,
	NewApiClient,
	normalizeRow,
	quotaToMoney,
	readQuotaUnits,
	summarizeRows,
	verifyCharge
} from "../src/adapters/newapi.js";
import { inputTotal } from "../src/usage.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/newapi.json", import.meta.url), "utf8"));
const UNITS = readQuotaUnits(FIXTURE.status);
const ROWS = FIXTURE.logSelf.data.items;

test("quota units come from the site, not from a constant", () => {
	assert.equal(UNITS.quotaPerUnit, 500_000);
	assert.equal(UNITS.pricePerUnit, 7.3);
	assert.equal(UNITS.displayCurrency, "CNY");
	assert.equal(readQuotaUnits({ data: {} }).quotaPerUnit, DEFAULT_QUOTA_PER_UNIT);
	assert.equal(readQuotaUnits({ data: {} }).pricePerUnit, undefined);
});

test("quota, USD and display currency stay three separate facts", () => {
	const money = quotaToMoney(14_383_915, UNITS);
	assert.equal(money.quota, 14_383_915);
	assert.equal(money.usd, 28.76783);
	assert.equal(money.display, 210.005159);
	assert.equal(money.currency, "CNY");
});

test("a site that publishes no price yields a null display amount, not zero", () => {
	const money = quotaToMoney(500_000, { quotaPerUnit: 500_000 });
	assert.equal(money.usd, 1);
	assert.equal(money.display, null, "zero here would read as 'this cost nothing'");
	assert.equal(money.currency, undefined);
});

test("the billing formula reproduces a real charged row exactly", () => {
	// (12416 - 11776 + 11776*1 + 149*6) * 2.5 * 0.35 = 11646.25 -> 11646
	const v = verifyCharge(ROWS[0]);
	assert.equal(v.verifiable, true);
	assert.equal(v.expectedQuota, 11_646);
	assert.equal(v.chargedQuota, 11_646);
	assert.equal(v.delta, 0);
});

test("the formula also reproduces a real row with no cache hits", () => {
	// (12371 + 215*6) * 2.5 * 0.35 = 11953.375 -> 11953
	const v = verifyCharge(ROWS[1]);
	assert.equal(v.expectedQuota, 11_953);
	assert.equal(v.delta, 0);
});

test("an overcharge is detected as a positive delta", () => {
	const tampered = { ...ROWS[1], quota: ROWS[1].quota + 500 };
	const v = verifyCharge(tampered);
	assert.equal(v.verifiable, true);
	assert.equal(v.delta, 500, "this is the whole point of the tool");
});

test("a cache discount is honoured rather than ignored", () => {
	const other = JSON.parse(ROWS[0].other);
	// (12416 - 11776 + 11776*0.1 + 149*6) * 2.5 * 0.35 = (640 + 1177.6 + 894) * 0.875
	const discountedQuota = Math.round((640 + 1177.6 + 894) * 2.5 * 0.35);
	const discounted = {
		...ROWS[0],
		quota: discountedQuota,
		other: JSON.stringify({ ...other, cache_ratio: 0.1 })
	};
	const v = verifyCharge(discounted);
	assert.equal(v.consistent, true);
	assert.equal(v.variant, "openai");
	assert.equal(v.expectedQuota, discountedQuota);
	assert.ok(discountedQuota < 11_646, "a cache discount must reduce the expected charge");
});

test("the fallback convention is flagged so it cannot masquerade as strong evidence", () => {
	// With cache_ratio 1 the openai convention and the prompt-only fallback are
	// arithmetically identical, so this row matches its declared convention.
	const declared = verifyCharge(ROWS[0]);
	assert.equal(declared.consistent, true);
	assert.equal(declared.matchedDeclared, true);

	// A Claude-semantic row whose charge ignores its recorded cache tokens can
	// only be explained by the fallback, and says so.
	const fallbackOnly = {
		quota: 588,
		prompt_tokens: 5,
		completion_tokens: 46,
		other: JSON.stringify({
			cache_ratio: 0.1,
			cache_tokens: 63,
			claude: true,
			completion_ratio: 5,
			group_ratio: 1,
			model_price: -1,
			model_ratio: 2.5
		})
	};
	const v = verifyCharge(fallbackOnly);
	assert.equal(v.consistent, true);
	assert.equal(v.variant, "prompt-only");
	assert.equal(v.matchedDeclared, false, "declared anthropic, explained only by the fallback");
});

test("a charge no convention reproduces is reported unexplained, not as theft", () => {
	const tampered = { ...ROWS[0], quota: 99_999 };
	const v = verifyCharge(tampered);
	assert.equal(v.verifiable, true);
	assert.equal(v.consistent, false);
	assert.equal(v.variant, null);
	assert.equal(v.reason, "no known pricing convention reproduces this charge");
	assert.equal(v.candidates.length, 3, "every convention's figure is shown so a human can judge");
});

test("an Anthropic-semantic row needs the Anthropic convention", () => {
	// Real shape: prompt_tokens excludes cache, cache creation is its own bucket.
	// (54 + 8533*0.1 + 118*1.25 + 85*5) * 2.5 * 0.21 = 776.895 -> 777
	const anthropic = {
		quota: 777,
		prompt_tokens: 54,
		completion_tokens: 85,
		other: JSON.stringify({
			cache_creation_ratio: 1.25,
			cache_creation_tokens: 118,
			cache_ratio: 0.1,
			cache_tokens: 8533,
			cache_write_tokens: 118,
			claude: true,
			completion_ratio: 5,
			group_ratio: 0.21,
			model_price: -1,
			model_ratio: 2.5,
			usage_semantic: "anthropic"
		})
	};
	const v = verifyCharge(anthropic);
	assert.equal(v.consistent, true);
	assert.equal(v.variant, "anthropic");
	assert.equal(v.matchedDeclared, true);
	assert.equal(v.expectedQuota, 777);

	const asOpenai = v.candidates.find((c) => c.variant === "openai");
	assert.ok(asOpenai.quota < 0, "scoring an Anthropic row as OpenAI inverts the arithmetic");
});

test("per-call flat pricing is reported unverifiable, never silently passed", () => {
	const other = JSON.parse(ROWS[1].other);
	const flat = { ...ROWS[1], other: JSON.stringify({ ...other, model_price: 0.02 }) };
	const v = verifyCharge(flat);
	assert.equal(v.verifiable, false);
	assert.equal(v.expectedQuota, null);
	assert.equal(v.delta, null, "a null delta must not be mistaken for agreement");
	assert.equal(v.reason, "per-call flat price");
});

test("a row with no ratio detail is unverifiable", () => {
	assert.equal(verifyCharge({ quota: 10, other: "" }).verifiable, false);
	assert.equal(verifyCharge({ quota: 10, other: "not json" }).verifiable, false);
	assert.equal(verifyCharge({ quota: 10, other: '{"cache_tokens":0}' }).reason, "no model_ratio");
});

test("prompt_tokens is the whole prompt side and must be split, not compared raw", () => {
	const row = normalizeRow(ROWS[0], UNITS);
	assert.equal(row.promptTokens, 12_416);
	assert.equal(row.cachedTokens, 11_776);
	assert.equal(row.uncachedPromptTokens, 640);

	// The DSH-side equivalent: inputTokens excludes cache, so the comparable
	// figure is inputTotal(), not inputTokens.
	const dshBuckets = { inputTokens: 640, cacheReadTokens: 11_776, cacheWriteTokens: 0, outputTokens: 149 };
	assert.equal(inputTotal(dshBuckets), row.promptTokens, "this equality is what makes reconciliation possible");
	assert.notEqual(dshBuckets.inputTokens, row.promptTokens, "comparing these directly is the classic false discrepancy");
});

test("normalized rows carry day, model, money and verification", () => {
	const row = normalizeRow(ROWS[0], UNITS, { utcOffsetMinutes: 480 });
	// 1786634961 is 2026-08-13 15:29:21Z, i.e. 23:29 Beijing — still the 13th.
	assert.equal(row.day, "2026-08-13");
	assert.equal(row.model, "gpt-5.6-sol");
	assert.equal(row.completionTokens, 149);
	assert.equal(row.currency, "CNY");
	assert.equal(row.verification.delta, 0);
	assert.equal(row.at, 1_786_634_961_000);
});

test("the day bucket follows the requested timezone across a boundary", () => {
	// The recorded rows sit at 23:29 Beijing, which does not cross a day
	// boundary, so the offset is exercised with a crafted 20:00Z instead.
	const crossing = { ...ROWS[0], created_at: Date.parse("2026-08-13T20:00:00Z") / 1000 };
	assert.equal(normalizeRow(crossing, UNITS, { utcOffsetMinutes: 0 }).day, "2026-08-13");
	assert.equal(
		normalizeRow(crossing, UNITS, { utcOffsetMinutes: 480 }).day,
		"2026-08-14",
		"a relay's day boundary is a reporting choice, not a fact"
	);
});

test("summarizeRows groups by day and model and keeps unverified rows visible", () => {
	const other = JSON.parse(ROWS[1].other);
	const rows = [
		normalizeRow(ROWS[0], UNITS, { utcOffsetMinutes: 480 }),
		normalizeRow(ROWS[1], UNITS, { utcOffsetMinutes: 480 }),
		normalizeRow({ ...ROWS[1], other: JSON.stringify({ ...other, model_price: 1 }) }, UNITS, {
			utcOffsetMinutes: 480
		})
	];
	const summary = summarizeRows(rows);
	assert.equal(summary.length, 1, "same day, same model");
	const day = summary[0];
	assert.equal(day.requests, 3);
	assert.equal(day.promptTokens, 12_416 + 12_371 * 2);
	assert.equal(day.cachedTokens, 11_776);
	assert.equal(day.unverifiedRequests, 1);
	assert.equal(day.quotaDelta, null, "one unverifiable row makes the day's delta unknowable, not zero");
});

test("a fully verifiable day reports a real delta", () => {
	const rows = [ROWS[0], ROWS[1]].map((r) => normalizeRow(r, UNITS, { utcOffsetMinutes: 480 }));
	const [day] = summarizeRows(rows);
	assert.equal(day.unverifiedRequests, 0);
	assert.equal(day.quotaDelta, 0);
});

// --- client behaviour, against the fixture rather than the network ----------

const fakeFetch = (routes) => async (url) => {
	const path = new URL(url).pathname;
	const body = routes[path];
	if (body === undefined) return { ok: false, status: 404, json: async () => ({ success: false, message: "no route" }) };
	return { ok: true, status: 200, json: async () => body };
};

const client = (routes, mode = "pat") =>
	new NewApiClient({
		origin: "https://relay.example.com",
		userId: 1,
		getCredential: async () => ({ mode, value: "secret-value" }),
		fetch: fakeFetch(routes)
	});

test("the client sends the credential as a header and never in the URL", async () => {
	let seen;
	const c = new NewApiClient({
		origin: "https://relay.example.com",
		userId: 7,
		getCredential: async () => ({ mode: "pat", value: "sk-secret" }),
		fetch: async (url, init) => {
			seen = { url: String(url), headers: init.headers };
			return { ok: true, status: 200, json: async () => FIXTURE.status };
		}
	});
	await c.units();
	assert.equal(seen.url.includes("sk-secret"), false, "a key in a query string leaks into proxy logs");
	assert.equal(seen.headers.authorization, "Bearer sk-secret");
	assert.equal(seen.headers["new-api-user"], "7");
});

test("summary is labelled summary — cumulative totals cannot support a window", async () => {
	const c = client({ "/api/user/self": FIXTURE.userSelf });
	const summary = await c.summary(UNITS);
	assert.equal(summary.level, LEVELS.SUMMARY);
	assert.equal(summary.used.quota, 14_383_915);
	assert.equal(summary.used.display, 210.005159);
	assert.equal(summary.remaining.quota, 85_616_085);
	assert.equal(summary.requestCount, 1925);
});

test("aggregate rows are labelled aggregate and keep the site's combined token count as-is", async () => {
	const c = client({ "/api/data/self": FIXTURE.dataSelf });
	const agg = await c.aggregate({ from: 0, to: 2e12, utcOffsetMinutes: 480 }, UNITS);
	assert.equal(agg.level, LEVELS.AGGREGATE);
	assert.equal(agg.rows.length, 3);
	assert.equal(agg.rows[0].combinedTokens, 1_221_884);
	assert.equal(agg.rows[0].requests, 102);
	assert.equal(agg.rows[0].quota, 1_105_612);
	assert.equal(Object.hasOwn(agg.rows[0], "promptTokens"), false, "the endpoint never says how it combined them");
});

test("key mode reads the token-scoped log, PAT mode the account log", async () => {
	const routes = { "/api/log/self": FIXTURE.logSelf, "/api/log/token": FIXTURE.logSelf };
	let path;
	const spy = (mode) =>
		new NewApiClient({
			origin: "https://relay.example.com",
			userId: 1,
			getCredential: async () => ({ mode, value: "v" }),
			fetch: async (url) => {
				path = new URL(url).pathname;
				return { ok: true, status: 200, json: async () => routes[path] };
			}
		});
	await spy("pat").requests({ from: 0, to: 2e12 }, UNITS);
	assert.equal(path, "/api/log/self");
	await spy("key").requests({ from: 0, to: 2e12 }, UNITS);
	assert.equal(path, "/api/log/token");
});

test("a failed call raises rather than returning an empty window", async () => {
	const c = client({});
	await assert.rejects(() => c.summary(UNITS), /failed: 404/);
});

test("only consumption logs are requested — login and top-up rows carry no tokens", async () => {
	let query;
	const c = new NewApiClient({
		origin: "https://relay.example.com",
		userId: 1,
		getCredential: async () => ({ mode: "pat", value: "v" }),
		fetch: async (url) => {
			query = new URL(url).searchParams;
			return { ok: true, status: 200, json: async () => FIXTURE.logSelf };
		}
	});
	await c.requests({ from: 1_000_000, to: 2_000_000 }, UNITS);
	assert.equal(query.get("type"), "2");
	assert.equal(query.get("start_timestamp"), "1000");
	assert.equal(query.get("end_timestamp"), "2000");
});
