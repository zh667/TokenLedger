/**
 * Vendors that sell a plan rather than a balance.
 *
 * These payloads have no published schema, and the readers were written
 * defensively on purpose. Every test below names the specific way a naive
 * reader loses the card — usually silently, because an empty list is not an
 * error and a blank card looks like an account with nothing in it.
 *
 * Nothing here touches the network. What WAS checked live, with an invalid
 * Bearer and a control path that does not exist:
 *
 *   GET https://opencode.ai/zen/go/v1/usage      -> 401 JSON  (404 -> HTML)
 *   GET https://api.kimi.com/coding/v1/usages    -> 401 JSON  (404 -> JSON 404)
 *   GET https://api.minimax.io/v1/token_plan/remains -> 200 + base_resp 1004
 *   GET https://api.minimax.io/v1/nope-404       -> 404 "404 page not found"
 *
 * The MiniMax pair is the important one: a real 404 beside a 200-that-means-no
 * is what makes the host fallback safe to attempt at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SCHEMES, readBalance } from "../src/balance.js";
import { OPENCODE_GO } from "../src/subscriptions.js";

const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);

/** Serve one body to every request. */
const serve = (body) => async () => ({ ok: true, json: async () => body });

/** Serve a different body per URL, and record what was asked for. */
function router(routes) {
	const seen = [];
	const fetch = async (url, init) => {
		seen.push({ url, authorization: init?.headers?.authorization });
		const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
		if (hit === undefined) return { ok: false, status: 404 };
		const answer = hit[1];
		if (typeof answer === "function") return answer();
		return { ok: true, json: async () => answer };
	};
	return { fetch, seen };
}

const read = (scheme, origin, fetch, extra = {}) =>
	readBalance({ scheme, origin, apiKey: "k", now: NOW, fetch, ...extra });

// --- OpenCode Go ---------------------------------------------------------------

test("opencode-go reads its three rolling windows", async () => {
	const result = await read(
		"opencode-go",
		"https://opencode.ai",
		serve({ usage: { rolling: { percent: 4, resetInSec: 3600 }, weekly: { percent: 4 }, monthly: { percent: 2 } } })
	);
	assert.equal(result.fetched, true);
	assert.equal(result.plan, "Go");
	assert.deepEqual(result.windows, [
		{ kind: "session", usedPercent: 4, resetsAt: "2026-08-17T13:00:00.000Z" },
		{ kind: "weekly", usedPercent: 4 },
		{ kind: "monthly", usedPercent: 2 }
	]);
});

test("opencode-go accepts the payload flat as well as under `usage`", async () => {
	const result = await read("opencode-go", "https://opencode.ai", serve({ rolling: { percent: 11 } }));
	assert.deepEqual(result.windows, [{ kind: "session", usedPercent: 11 }]);
});

test("opencode-go falls back to counts when no percentage is sent", async () => {
	const result = await read("opencode-go", "https://opencode.ai", serve({ usage: { weekly: { used: 250, limit: 1000 } } }));
	assert.deepEqual(result.windows, [{ kind: "weekly", usedPercent: 25 }]);
});

test("a response with no recognisable windows says which fields were missing", async () => {
	// The failure a blank card cannot express. Without this the user reports
	// "it shows nothing" and there is no way to tell a wrong field name from an
	// expired plan.
	const result = await read("opencode-go", "https://opencode.ai", serve({ usage: { somethingElse: {} } }));
	assert.equal(result.fetched, true);
	assert.equal("windows" in result, false, "not an empty list");
	assert.match(result.reason, /rolling/);
});

test("the local OpenCode key is used only when the route carries none", async () => {
	const auth = JSON.stringify({ "opencode-go": { type: "api", key: "  local-key  " } });
	const deps = { readFile: async () => auth, homedir: () => "/home/someone" };

	const withRoute = router({ usage: { usage: { rolling: { percent: 1 } } } });
	await read("opencode-go", "https://opencode.ai", withRoute.fetch, deps);
	assert.equal(withRoute.seen[0].authorization, "Bearer k", "a configured key is never second-guessed");

	const withoutRoute = router({ usage: { usage: { rolling: { percent: 1 } } } });
	await readBalance({ scheme: "opencode-go", origin: "https://opencode.ai", now: NOW, fetch: withoutRoute.fetch, ...deps });
	assert.equal(withoutRoute.seen[0].authorization, "Bearer local-key", "trimmed, and used");
});

test("every way the local key file can fail reads as 'no credential'", async () => {
	// The file is not ours and may change shape without notice. It must never be
	// able to turn a working panel into an error.
	const failures = [
		{ readFile: async () => { throw new Error("ENOENT"); } },
		{ readFile: async () => "not json at all" },
		{ readFile: async () => JSON.stringify({ "opencode-go": { type: "oauth", key: "x" } }) },
		{ readFile: async () => JSON.stringify({ "opencode-go": { type: "api", key: "   " } }) },
		{ readFile: async () => JSON.stringify({ somethingElse: 1 }) }
	];
	for (const deps of failures) {
		assert.equal(await OPENCODE_GO.localCredential({ ...deps, homedir: () => "/home/someone" }), undefined);
		const result = await readBalance({
			scheme: "opencode-go",
			origin: "https://opencode.ai",
			fetch: () => assert.fail("no request may be made without a key"),
			homedir: () => "/home/someone",
			...deps
		});
		assert.equal(result.reason, "no-credential");
	}
});

// --- Kimi For Coding -----------------------------------------------------------

test("kimi reads the first usable rate limit and the weekly counter", async () => {
	const result = await read(
		"kimi",
		"https://api.kimi.com",
		serve({
			data: {
				plan: "Kimi For Coding Pro",
				limits: [{ detail: { note: "no counters here" } }, { detail: { limit: 100, remaining: 40, resetTime: "2026-08-17T14:00:00Z" } }],
				usage: { limit: 1000, remaining: 250 }
			}
		})
	);
	assert.equal(result.plan, "Kimi For Coding Pro");
	assert.deepEqual(result.windows, [
		{ kind: "session", usedPercent: 60, resetsAt: "2026-08-17T14:00:00.000Z" },
		{ kind: "weekly", usedPercent: 75 }
	]);
});

test("kimi tolerates the limits list being flat rather than wrapped in `detail`", async () => {
	const result = await read("kimi", "https://api.kimi.com", serve({ limits: [{ limit: 10, remaining: 1 }] }));
	assert.deepEqual(result.windows, [{ kind: "session", usedPercent: 90 }]);
});

// --- MiniMax -------------------------------------------------------------------

/** One `model_remains` entry, in the shape the endpoint documents nowhere. */
const remains = (over = {}) => ({
	model_name: "general",
	current_interval_status: 1,
	current_interval_remaining_percent: 96,
	current_weekly_status: 1,
	current_weekly_remaining_percent: 40,
	...over
});

test("minimax turns remaining percentages into used ones", async () => {
	const result = await read("minimax", "https://api.minimax.io", serve({ model_remains: [remains()] }));
	assert.deepEqual(result.windows, [
		{ kind: "session", usedPercent: 4 },
		{ kind: "weekly", usedPercent: 60 }
	]);
});

test("minimax finds the chat entry when it is named after the model", async () => {
	// Older payloads called the resource group `general`. Newer ones use the
	// model name. Matching only `general` loses every window on a new account,
	// with no error anywhere.
	const result = await read("minimax", "https://api.minimax.io", serve({ model_remains: [remains({ model_name: "MiniMax-M3" })] }));
	assert.equal(result.windows.length, 2);
});

test("minimax keeps a window whose status is exhausted or unlimited", async () => {
	// Status decides HOW a window renders, never WHETHER it renders. Requiring
	// status 1 hides the window in exactly the two states worth seeing.
	const spent = await read(
		"minimax",
		"https://api.minimax.io",
		serve({ model_remains: [remains({ current_weekly_status: 2, current_weekly_remaining_percent: undefined })] })
	);
	assert.deepEqual(spent.windows.at(-1), { kind: "weekly", usedPercent: 100 });

	const unmetered = await read(
		"minimax",
		"https://api.minimax.io",
		serve({ model_remains: [remains({ current_weekly_status: 3, current_weekly_remaining_percent: undefined })] })
	);
	assert.deepEqual(unmetered.windows.at(-1), { kind: "weekly", unlimited: true });
});

test("minimax reads camelCase payloads as well as snake_case ones", async () => {
	const result = await read(
		"minimax",
		"https://api.minimax.io",
		serve({ model_remains: [{ modelName: "MiniMax-M3", currentIntervalRemainingPercent: 30 }] })
	);
	assert.deepEqual(result.windows, [{ kind: "session", usedPercent: 70 }]);
});

test("minimax counters are only trusted when the total is above zero", async () => {
	// Current payloads zero the counters and report percentages instead. A total
	// of zero means "not reported here", and dividing by it says "spent".
	const zeroed = await read(
		"minimax",
		"https://api.minimax.io",
		serve({ model_remains: [remains({ current_interval_remaining_percent: undefined, current_interval_total_count: 0, current_interval_usage_count: 0 })] })
	);
	assert.equal(zeroed.windows.some((w) => w.kind === "session"), false);

	const real = await read(
		"minimax",
		"https://api.minimax.io",
		serve({ model_remains: [remains({ current_interval_remaining_percent: undefined, current_interval_total_count: 200, current_interval_usage_count: 50 })] })
	);
	assert.deepEqual(real.windows[0], { kind: "session", usedPercent: 25 });
});

test("minimax refuses with a 200, and the envelope catches it", async () => {
	const result = await read(
		"minimax",
		"https://api.minimax.io",
		serve({ base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key" } })
	);
	assert.equal(result.fetched, false);
	assert.equal(result.reason, "upstream-1004");
});

test("minimax tries its sibling host on a 404, and only on a 404", async () => {
	// A 404 or a non-JSON reply means this host does not serve the route. A 401,
	// a 403 or a 429 is a real answer — retrying it elsewhere cannot improve on
	// it, and against a rate limiter it turns one refusal into two.
	const found = router({
		"api.minimax.io": () => ({ ok: false, status: 404 }),
		"www.minimax.io": { model_remains: [remains()] }
	});
	const result = await read("minimax", "https://api.minimax.io", found.fetch);
	assert.equal(result.fetched, true);
	assert.deepEqual(found.seen.map((r) => new URL(r.url).hostname), ["api.minimax.io", "www.minimax.io"]);

	for (const status of [401, 403, 429]) {
		const refused = router({ "api.minimax.io": () => ({ ok: false, status }) });
		const answer = await read("minimax", "https://api.minimax.io", refused.fetch);
		assert.equal(answer.reason, `http-${status}`);
		assert.equal(refused.seen.length, 1, `a ${status} is an answer, not a reason to ask elsewhere`);
	}
});

test("minimax moves on when a host answers something that is not JSON", async () => {
	const html = router({
		"api.minimaxi.com": () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } }),
		"www.minimaxi.com": { model_remains: [remains()] }
	});
	assert.equal((await read("minimax", "https://api.minimaxi.com", html.fetch)).fetched, true);
	assert.equal(html.seen.length, 2);
});

test("a host with no sibling reports the failure rather than inventing one", async () => {
	const result = await read("minimax", "https://minimax.example", async () => ({ ok: false, status: 404 }));
	assert.equal(result.reason, "http-404");
});

test("non-JSON from a scheme with nowhere else to look is its own reason", async () => {
	const result = await read("kimi", "https://api.kimi.com", async () => ({
		ok: true,
		json: async () => { throw new SyntaxError("Unexpected token <"); }
	}));
	assert.equal(result.reason, "invalid-response", "distinct from a timeout and from an unreachable host");
});

// --- Z.ai / 智谱 ----------------------------------------------------------------

const zaiQuota = {
	data: {
		limits: [
			{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 1000, remaining: 960, nextResetTime: "2026-08-17T17:00:00Z" },
			{ type: "TOKENS_LIMIT", unit: 6, number: 1, usage: 50000, remaining: 10000 },
			{ type: "TIME_LIMIT", usage: 30, remaining: 12 }
		]
	}
};

test("zai reads its coding plan alongside its wallet, because an account can hold both", async () => {
	const { fetch } = router({
		"/api/paas/v4/balance": { data: { total_balance: 100, available_balance: 64 } },
		"/api/monitor/usage/quota/limit": zaiQuota,
		"/api/biz/subscription/list": { data: [{ product_name: "GLM Coding Max" }] }
	});
	const result = await read("zai", "https://api.z.ai", fetch);
	assert.equal(result.total, 64, "the wallet is still read");
	assert.equal(result.plan, "GLM Coding Max");
	assert.deepEqual(result.windows, [
		{ kind: "session", minutes: 300, usedPercent: 4, resetsAt: "2026-08-17T17:00:00.000Z" },
		{ kind: "weekly", minutes: 10080, usedPercent: 80 },
		{ kind: "billing", usedPercent: 60 }
	]);
});

test("zai's console routes get the bare key, and the inference route the Bearer one", async () => {
	// Different API surfaces on one host want different auth. Sending the wrong
	// one is a 401 that looks exactly like a bad key.
	const { fetch, seen } = router({
		"/api/paas/v4/balance": { data: { available_balance: 1 } },
		"/api/monitor/usage/quota/limit": zaiQuota,
		"/api/biz/subscription/list": { data: [] }
	});
	await read("zai", "https://api.z.ai", fetch);
	const authOf = (fragment) => seen.find((r) => r.url.includes(fragment)).authorization;
	assert.equal(authOf("/api/paas/v4/balance"), "Bearer k");
	assert.equal(authOf("/api/monitor/"), "k");
	assert.equal(authOf("/api/biz/"), "k");
});

test("either half of a zai account can fail without taking the other down", async () => {
	const walletOnly = router({ "/api/paas/v4/balance": { data: { available_balance: 42 } } });
	const wallet = await read("zai", "https://api.z.ai", walletOnly.fetch);
	assert.equal(wallet.total, 42);
	assert.equal("windows" in wallet, false);

	const planOnly = router({ "/api/monitor/usage/quota/limit": zaiQuota, "/api/biz/subscription/list": { data: [] } });
	const plan = await read("zai", "https://api.z.ai", planOnly.fetch);
	assert.equal(plan.total, undefined);
	assert.equal(plan.windows.length, 3);
});

test("both halves failing is a failure, not a card with nothing on it", async () => {
	const result = await read("zai", "https://api.z.ai", async () => ({ ok: false, status: 401 }));
	assert.equal(result.fetched, false);
	assert.equal(result.reason, "http-401");
});

test("a window length nobody can decode costs the label, not the number", async () => {
	// The unit codes are inferred, not published. An unrecognised one yields no
	// `minutes`, and the row still renders under its kind's own name — the right
	// way for a guess to fail.
	const { fetch } = router({
		"/api/monitor/usage/quota/limit": { data: { limits: [{ type: "TOKENS_LIMIT", unit: 99, number: 7, usage: 10, remaining: 3 }] } },
		"/api/biz/subscription/list": { data: [] }
	});
	const result = await read("zai", "https://api.z.ai", fetch);
	assert.deepEqual(result.windows, [{ kind: "session", usedPercent: 70 }]);
});

test("zai's `usage` is the allowance, not the amount consumed", async () => {
	// The shared count helper reads `usage` the other way round, which is why
	// this vendor spells the arithmetic out. Getting it backwards turns a 4%
	// window into a 96% one.
	const { fetch } = router({
		"/api/monitor/usage/quota/limit": { data: { limits: [{ type: "CREDIT_LIMIT", usage: 1000, remaining: 960 }] } },
		"/api/biz/subscription/list": { data: [] }
	});
	assert.equal((await read("zai", "https://api.z.ai", fetch)).windows[0].usedPercent, 4);
});

test("a plan whose name cannot be read is still a plan", async () => {
	const { fetch } = router({
		"/api/monitor/usage/quota/limit": zaiQuota,
		"/api/biz/subscription/list": () => ({ ok: false, status: 403 })
	});
	const result = await read("zai", "https://api.z.ai", fetch);
	assert.equal(result.plan, undefined);
	assert.equal(result.windows.length, 3, "the quota was already read and must not be thrown away");
});

// --- the registry ---------------------------------------------------------------

test("every plan vendor is reached by origin, never by what the route is called", async () => {
	// Same rule as site attribution: a route named `kimi` may point anywhere,
	// and a route named anything may point at Kimi.
	const { listAccounts } = await import("../src/balance.js");
	const ctx = {
		get: (name) =>
			name === "llm"
				? { listConfigurableProviders: () => [
						{ provider: "a", settingsNs: "ns", settingsPath: ["a"] },
						{ provider: "b", settingsNs: "ns", settingsPath: ["b"] },
						{ provider: "c", settingsNs: "ns", settingsPath: ["c"] },
						{ provider: "d", settingsNs: "ns", settingsPath: ["d"] }
					] }
				: { get: () => ({
						a: { baseURL: "https://opencode.ai/zen/v1", apiKeyEnv: "K" },
						b: { baseURL: "https://api.kimi.com/coding/v1", apiKeyEnv: "K" },
						c: { baseURL: "https://api.minimax.io/v1", apiKeyEnv: "K" },
						d: { baseURL: "https://api.minimaxi.com/v1", apiKeyEnv: "K" }
					}) }
	};
	assert.deepEqual(listAccounts(ctx).map((a) => a.scheme), ["opencode-go", "kimi", "minimax", "minimax"]);
	assert.deepEqual(listAccounts(ctx).map((a) => a.displayName), ["OpenCode Go", "Kimi For Coding", "MiniMax", "MiniMax"]);
});

test("only the scheme that has a local key file declares one", async () => {
	// Reading a credential off disk is a capability, not a convenience to spread
	// around. Every other scheme must go through the credentials seam.
	const withLocal = Object.entries(SCHEMES).filter(([, spec]) => spec.localCredential !== undefined);
	assert.deepEqual(withLocal.map(([name]) => name), ["opencode-go"]);
});
