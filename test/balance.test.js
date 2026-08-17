/**
 * Account balances.
 *
 * The premise these tests were first written against was wrong: relay balances
 * were assumed to need administrator credentials. New API's per-request LOG
 * does; its balance does not. `GET /api/usage/token/` sits behind
 * `TokenAuthReadOnly`, so an ordinary `sk-` key reads that key's quota —
 * verified against New API's router source and against a live deployment.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SCHEMES, createBalanceReader, isOfficialDeepSeek, listAccounts, readBalance } from "../src/balance.js";

test("official is decided by origin, not by what the route is called", () => {
	// The same reason site attribution is: a route named `deepseek` may point at
	// a relay, and a route named anything may point at DeepSeek.
	assert.equal(isOfficialDeepSeek("https://api.deepseek.com/v1"), true);
	assert.equal(isOfficialDeepSeek("https://API.DeepSeek.com"), true);
	assert.equal(isOfficialDeepSeek(undefined), true, "no baseURL means the shipped default");
	assert.equal(isOfficialDeepSeek("https://api.relay-one.example/v1"), false);
	assert.equal(isOfficialDeepSeek("https://api.deepseek.com.evil.example"), false, "suffix must not match");
	assert.equal(isOfficialDeepSeek("not a url"), false);
});

test("every scheme answers the same shape, so one card renders all of them", () => {
	assert.deepEqual(Object.keys(SCHEMES).sort(), [
		"deepseek",
		"kimi",
		"minimax",
		"moonshot",
		"newapi",
		"opencode-go",
		"openrouter",
		"sub2api",
		"zai"
	]);
	for (const [name, spec] of Object.entries(SCHEMES)) {
		assert.equal(typeof spec.read, "function", name);
		assert.equal(typeof spec.label, "string", name);
		if (spec.envelope !== undefined) assert.equal(typeof spec.envelope, "function", name);
		if (spec.localCredential !== undefined) assert.equal(typeof spec.localCredential, "function", name);
	}
});

// --- the wire ----------------------------------------------------------------

const okJson = (body) => async () => ({ ok: true, json: async () => body });

test("the key rides an Authorization header, never a query string", async () => {
	let seen;
	await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "sk-secret",
		fetch: async (url, init) => {
			seen = { url, init };
			return { ok: true, json: async () => ({ balance_infos: [] }) };
		}
	});
	assert.equal(seen.url.includes("sk-secret"), false, "a key in a URL leaks into history and proxy logs");
	assert.equal(seen.init.headers.authorization, "Bearer sk-secret");
});

test("no credential is reported as such, without a request", async () => {
	let called = 0;
	const result = await readBalance({ scheme: "newapi", origin: "https://r.example", fetch: async () => void called++ });
	assert.deepEqual(result, { supported: true, fetched: false, reason: "no-credential" });
	assert.equal(called, 0);
});

test("software nobody recognises is unsupported, not failed", async () => {
	assert.deepEqual(await readBalance({ scheme: "mystery", origin: "https://r.example", apiKey: "k" }), {
		supported: false,
		reason: "unknown-software"
	});
});

test("an http error and an unreachable host read differently", async () => {
	assert.equal(
		(await readBalance({ scheme: "deepseek", origin: "https://x.example", apiKey: "k", fetch: async () => ({ ok: false, status: 401 }) })).reason,
		"http-401"
	);
	assert.equal(
		(
			await readBalance({
				scheme: "deepseek",
				origin: "https://x.example",
				apiKey: "k",
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				}
			})
		).reason,
		"unreachable"
	);
});

// --- per-vendor shapes -------------------------------------------------------

test("DeepSeek prefers CNY, and an unreported balance is absent rather than zero", async () => {
	// Zero is a balance. Absent is not knowing. Rendering the second as the
	// first tells someone their account is empty.
	const both = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: okJson({
			is_available: true,
			balance_infos: [
				{ currency: "USD", total_balance: "1.00" },
				{ currency: "CNY", total_balance: "36.44", granted_balance: "5.00" }
			]
		})
	});
	assert.equal(both.currency, "CNY");
	assert.equal(both.total, 36.44);
	assert.equal(both.granted, 5);

	const empty = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: okJson({ is_available: true, balance_infos: [] })
	});
	assert.equal(empty.total, undefined);
	assert.equal(empty.currency, undefined);
});

test("New API converts quota to money using the site's own divisor", async () => {
	// Quota is an internal integer and the same figure means different money at
	// different relays, so the conversion has to come from that site.
	const calls = [];
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "sk-k",
		fetch: async (url, init) => {
			calls.push({ url, auth: init.headers.authorization });
			if (url.includes("/api/status")) {
				return { ok: true, json: async () => ({ data: { quota_per_unit: 500000, price: 2 } }) };
			}
			return {
				ok: true,
				json: async () => ({
					data: { total_granted: 5_000_000, total_used: 1_000_000, total_available: 4_000_000, unlimited_quota: false }
				})
			};
		}
	});
	// 4,000,000 quota / 500,000 per unit = 8 USD. `price` is the local cost of
	// one unit at top-up, not the unit the quota is denominated in.
	assert.equal(result.total, 8);
	assert.equal(result.granted, 10);
	assert.equal(result.used, 2);
	assert.equal(result.currency, "USD");
	// The raw quota survives beside the money, for a site that publishes no units.
	assert.deepEqual(result.quota, { granted: 5_000_000, used: 1_000_000, available: 4_000_000 });

	assert.ok(calls[0].url.endsWith("/api/usage/token/"), "the trailing slash matters: without it New API answers 301");
	assert.equal(calls[0].auth, "Bearer sk-k");
	// `/api/status` is public; sending the key there would be gratuitous.
	assert.equal(calls[1].auth, undefined);
});

test("a New API site that publishes no units still reports its quota", async () => {
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) throw new Error("nope");
			return { ok: true, json: async () => ({ data: { total_available: 4_000_000, total_granted: 4_000_000 } }) };
		}
	});
	assert.equal(result.total, undefined, "money is unknowable without the site's scale");
	assert.equal(result.quota.available, 4_000_000, "but the quota itself is not");
});

test("an unlimited New API key reads as available even at zero remaining", async () => {
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: okJson({ data: { total_available: 0, unlimited_quota: true } })
	});
	assert.equal(result.unlimited, true);
	assert.equal(result.isAvailable, true);
});

// --- Sub2API's three shapes ----------------------------------------------------
//
// `/v1/usage` answers in one of three shapes and only ONE of them carries a
// `balance`. Read off the gateway's own handler rather than inferred from a
// sample: `quota_limited` when the key has a total quota or rate limits,
// `unrestricted` with a `subscription` object when the key's group is a plan,
// and `unrestricted` with a `balance` for a plain wallet.

const sub2api = (body) => readBalance({ scheme: "sub2api", origin: "https://s.example", apiKey: "k", fetch: okJson(body) });

test("Sub2API's wallet shape reads as a wallet", async () => {
	const result = await sub2api({
		mode: "unrestricted",
		isValid: true,
		planName: "钱包余额",
		remaining: 4.768,
		unit: "USD",
		balance: 4.768
	});
	assert.equal(result.total, 4.768);
	assert.equal(result.currency, "USD");
	assert.equal(result.isAvailable, true);
	// The wallet shape sends a `planName` too, and it is a placeholder. Showing
	// it produces a card claiming the account is on a plan called "wallet".
	assert.equal(result.plan, undefined);
	assert.equal("windows" in result, false);
});

test("a quota-limited key reports its quota and every configured window", async () => {
	const result = await sub2api({
		mode: "quota_limited",
		isValid: true,
		status: "active",
		quota: { limit: 20, used: 8, remaining: 12, unit: "USD" },
		remaining: 12,
		unit: "USD",
		rate_limits: [
			{ window: "5h", limit: 100, used: 4, remaining: 96, reset_at: "2026-08-17T17:00:00Z" },
			{ window: "1d", limit: 400, used: 200, remaining: 200 },
			{ window: "7d", limit: 1000, used: 100, remaining: 900, reset_at: "2026-08-21T00:00:00Z" }
		]
	});
	assert.equal(result.total, 12, "remaining quota is the balance");
	assert.equal(result.granted, 20);
	assert.equal(result.used, 8);
	assert.deepEqual(result.windows, [
		{ kind: "session", minutes: 300, usedPercent: 4, resetsAt: "2026-08-17T17:00:00.000Z" },
		{ kind: "daily", usedPercent: 50 },
		{ kind: "weekly", usedPercent: 10, resetsAt: "2026-08-21T00:00:00.000Z" }
	]);
});

test("a lapsed window sends no reset_at, and none is invented", async () => {
	// The gateway omits it once the window has expired — the next request opens
	// a fresh one, so there is no instant to show.
	const result = await sub2api({
		mode: "quota_limited",
		isValid: true,
		rate_limits: [{ window: "5h", limit: 100, used: 0, remaining: 100, window_start: null }]
	});
	assert.equal("resetsAt" in result.windows[0], false);
});

test("a subscription key reports its periods, which is where its numbers live", async () => {
	// This shape has no `balance` at all. The previous reader looked for one,
	// found nothing, and rendered a card with nothing on it.
	const result = await sub2api({
		mode: "unrestricted",
		isValid: true,
		planName: "Claude 拼车 Pro",
		unit: "USD",
		remaining: 3.5,
		subscription: {
			daily_usage_usd: 1.5,
			weekly_usage_usd: 12,
			monthly_usage_usd: 30,
			daily_limit_usd: 5,
			weekly_limit_usd: 30,
			monthly_limit_usd: null,
			weekly_window_start: "2026-08-14T00:00:00Z",
			expires_at: "2026-09-01T00:00:00Z"
		}
	});
	assert.equal(result.plan, "Claude 拼车 Pro");
	assert.equal(result.total, 3.5);
	assert.deepEqual(result.windows, [
		{ kind: "daily", usedPercent: 30 },
		// The gateway reports when the window OPENED; the panel asks when it
		// frees up.
		{ kind: "weekly", usedPercent: 40, resetsAt: "2026-08-21T00:00:00.000Z" }
	]);
	assert.equal(result.windows.some((w) => w.kind === "monthly"), false, "an uncapped period is not a window at zero");
});

test("a subscription with no period caps is unlimited, not minus one dollar", async () => {
	// The gateway returns -1 for "no limit is configured anywhere". Rendered as
	// money that is a negative figure meaning nothing.
	const result = await sub2api({
		mode: "unrestricted",
		isValid: true,
		planName: "内部",
		unit: "USD",
		remaining: -1,
		subscription: { daily_limit_usd: null, weekly_limit_usd: null, monthly_limit_usd: null }
	});
	assert.equal(result.unlimited, true);
	assert.equal(result.total, undefined);
	assert.equal("windows" in result, false);
});

test("a key that is out of quota is not an available account", async () => {
	// `isValid` stays true for exhausted and expired keys — upstream means "we
	// recognise this key", not "you can spend on it".
	for (const status of ["quota_exhausted", "expired", "disabled"]) {
		const result = await sub2api({ mode: "quota_limited", isValid: true, status, quota: { limit: 20, used: 20, remaining: 0 } });
		assert.equal(result.isAvailable, false, status);
	}
	const active = await sub2api({ mode: "quota_limited", isValid: true, status: "active", quota: { limit: 20, used: 1, remaining: 19 } });
	assert.equal(active.isAvailable, true);
});

test("a window the gateway names something we do not know is dropped, not guessed", async () => {
	const result = await sub2api({
		mode: "quota_limited",
		isValid: true,
		rate_limits: [{ window: "30d", limit: 10, used: 1 }, { window: "5h", limit: 10, used: 1 }]
	});
	assert.deepEqual(result.windows.map((w) => w.kind), ["session"]);
});

// --- reaching the host -------------------------------------------------------

const piAi = (route) => ({ provider: route, settingsNs: "llm-pi-ai", settingsPath: ["providers", route] });

const ctxWith = (providers, section, credentials) => ({
	get: (name) =>
		name === "llm"
			? { listConfigurableProviders: () => providers }
			: name === "settings"
				? { get: () => section }
				: name === "credentials"
					? credentials
					: undefined
});

test("the account list carries no keys and makes no requests", () => {
	const accounts = listAccounts(
		ctxWith([piAi("official"), piAi("api99")], {
			providers: {
				official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DS_KEY" },
				api99: { baseURL: "https://api.relay-one.example/v1", apiKeyEnv: "RELAY_KEY" }
			}
		})
	);
	assert.deepEqual(accounts.map((a) => a.displayName), ["DeepSeek", "api.relay-one.example"]);
	assert.deepEqual(accounts.map((a) => a.scheme), ["deepseek", undefined]);
	assert.deepEqual(accounts.map((a) => a.hasCredential), [true, true]);
	assert.equal(JSON.stringify(accounts).includes("DS_KEY"), false, "the reference is not the key, but it is still not needed here");
});

test("two keys on one relay are two quotas, and are listed as two", () => {
	// A relay's quota is scoped to the KEY: New API's /api/usage/token/ and
	// Sub2API's /v1/usage both answer for whichever key asked. Collapsing them
	// by host showed one key's spend under the site's name and hid the other.
	const accounts = listAccounts(
		ctxWith([piAi("gpt"), piAi("claude")], {
			providers: {
				gpt: { baseURL: "https://api.relay-one.example/v1" },
				claude: { baseURL: "https://api.relay-one.example/v2" }
			}
		})
	);
	assert.equal(accounts.length, 2);
	// And the picker must be able to tell them apart, which the bare host cannot.
	assert.deepEqual(accounts.map((a) => a.displayName), ["api.relay-one.example · gpt", "api.relay-one.example · claude"]);
});

test("a single key on a relay is labelled by host alone", () => {
	const accounts = listAccounts(
		ctxWith([piAi("api99")], { providers: { api99: { baseURL: "https://api.relay-one.example/v1" } } })
	);
	assert.deepEqual(accounts.map((a) => a.displayName), ["api.relay-one.example"], "no route suffix when it adds nothing");
});

test("DeepSeek is still collapsed, because there the account is the unit", () => {
	// Its balance is an account fact, not a key fact — every key spends the same
	// wallet, so two routes to it are one card.
	const accounts = listAccounts(
		ctxWith([piAi("ds1"), piAi("ds2")], {
			providers: {
				ds1: { baseURL: "https://api.deepseek.com" },
				ds2: { baseURL: "https://api.deepseek.com" }
			}
		})
	);
	assert.equal(accounts.length, 1);
});

test("a relay's software is fingerprinted when a balance is asked for, and only once", async () => {
	// Probing every relay at startup was six unauthenticated requests for a
	// column nothing read. Probing the one just asked about is the same work
	// with a reason behind it.
	let probes = 0;
	const learned = new Map();
	const read = createBalanceReader(
		ctxWith(
			[piAi("api99")],
			{ providers: { api99: { baseURL: "https://api.relay-one.example/v1", apiKeyEnv: "K" } } },
			{ resolve: async () => ({ value: "sk-live" }) }
		),
		{
			softwareOf: learned,
			learnSoftware: (host, software) => learned.set(host, software),
			detect: async () => {
				probes++;
				return { billingAvailable: true, software: "newapi", confidence: 1 };
			},
			fetch: okJson({ data: { total_available: 1000 } })
		}
	);
	const first = await read("api99");
	assert.equal(first.scheme, "newapi");
	assert.equal(probes, 1);

	await read("api99");
	assert.equal(probes, 1, "the answer is remembered");
	assert.equal(learned.get("https://api.relay-one.example"), "newapi", "keyed by origin, so a second relay on the same host does not inherit it");
});

test("a relay running nothing recognisable says so instead of failing", async () => {
	const read = createBalanceReader(
		ctxWith([piAi("api99")], { providers: { api99: { baseURL: "https://odd.example/v1", apiKeyEnv: "K" } } }, {
			resolve: async () => ({ value: "k" })
		}),
		{ detect: async () => ({ billingAvailable: false, software: "unknown" }) }
	);
	const result = await read("api99");
	assert.equal(result.supported, false);
	assert.equal(result.reason, "unknown-software");
});

test("the credential comes from the route that serves that account", async () => {
	let resolved;
	const read = createBalanceReader(
		ctxWith([piAi("official")], { providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" } } }, {
			resolve: async (reference) => {
				resolved = reference;
				return { value: "sk-live" };
			}
		}),
		{ fetch: okJson({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.41" }] }) }
	);
	const result = await read("official");
	assert.equal(resolved, "DEEPSEEK_KEY");
	assert.equal(result.total, 9.41);
	assert.equal(result.displayName, "DeepSeek");
});

test("a host that cannot be asked is unsupported, not an error", async () => {
	assert.equal((await createBalanceReader({ get: () => undefined })()).reason, "no-provider-directory");
	assert.deepEqual(listAccounts({ get: () => undefined }), []);
});

test("an unknown account id is named as such rather than silently answered", async () => {
	const read = createBalanceReader(ctxWith([piAi("a")], { providers: { a: { baseURL: "https://x.example" } } }));
	assert.equal((await read("nope")).reason, "unknown-account");
});

test("an unlimited key reports what it spent, not a negative balance", async () => {
	// New API decrements `total_available` from zero for an unlimited key, so it
	// comes back as the negated usage. Shown as a balance that is a negative
	// number meaning nothing — a real install displayed ¥-1.5052 next to a
	// wallet holding $33.49. The wallet is behind user auth a token key does not
	// have; what the key CAN answer is its own spend.
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) return { ok: true, json: async () => ({ data: { quota_per_unit: 500000 } }) };
			return {
				ok: true,
				json: async () => ({
					data: { total_granted: 0, total_used: 752_600, total_available: -752_600, unlimited_quota: true }
				})
			};
		}
	});
	assert.equal(result.total, undefined, "there is no remaining balance to report");
	assert.equal(result.granted, undefined);
	assert.equal(result.used, 1.5052);
	assert.equal(result.unlimited, true);
	assert.equal(result.isAvailable, true, "unlimited is available however much it has spent");
	assert.deepEqual(result.quota, { used: 752_600 });
});

test("quota converts to USD, because that is what quota_per_unit divides into", async () => {
	// `price` is the local-currency cost of one unit at top-up, not the unit the
	// quota is denominated in. Treating its presence as "this site bills in CNY"
	// put a ¥ in front of a dollar figure that the site's own wallet shows as $.
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) {
				return { ok: true, json: async () => ({ data: { quota_per_unit: 500000, price: 7.3 } }) };
			}
			return { ok: true, json: async () => ({ data: { total_available: 16_745_000, total_used: 0 } }) };
		}
	});
	assert.equal(result.currency, "USD");
	assert.equal(result.total, 33.49);
});

test("the key's own name and expiry ride along, when New API gives them", async () => {
	// With several keys on one relay the name is the only thing that says which
	// one a card is about; it is what the site's console shows beside each row.
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async (url) => {
			if (url.includes("/api/status")) return { ok: true, json: async () => ({ data: { quota_per_unit: 500000 } }) };
			return { ok: true, json: async () => ({ data: { name: "claude1", total_available: 500000, expires_at: 1800000000 } }) };
		}
	});
	assert.equal(result.keyName, "claude1");
	assert.equal(result.expiresAt, 1800000000);
});

test("expires_at of 0 means never, not the epoch", async () => {
	const result = await readBalance({
		scheme: "newapi",
		origin: "https://r.example",
		apiKey: "k",
		fetch: async () => ({ ok: true, json: async () => ({ data: { total_available: 1, expires_at: 0 } }) })
	});
	assert.equal(result.expiresAt, undefined);
});

test("two relays on one machine are two sites, not one with two ports", async () => {
	// Found by pointing two stub relays at 127.0.0.1 on different ports: the
	// second inherited the first's detected software and then 404'd, because
	// both the site id and the software cache were keyed by hostname alone.
	const accounts = listAccounts(
		ctxWith([piAi("a"), piAi("b")], {
			providers: {
				a: { baseURL: "http://127.0.0.1:7801/v1" },
				b: { baseURL: "http://127.0.0.1:7802/v1" }
			}
		}),
		{ softwareOf: new Map([["http://127.0.0.1:7801", "newapi"]]) }
	);
	assert.equal(accounts.length, 2);
	assert.deepEqual(accounts.map((a) => a.origin), ["http://127.0.0.1:7801", "http://127.0.0.1:7802"]);
	assert.deepEqual(accounts.map((a) => a.scheme), ["newapi", undefined], "the second must not inherit the first's software");
	// The port already tells them apart, so no route suffix is needed — the
	// suffix is only for two keys reaching the SAME origin.
	assert.deepEqual(accounts.map((a) => a.displayName), ["127.0.0.1:7801", "127.0.0.1:7802"]);
});

// --- vendors with a public balance endpoint -----------------------------------
//
// Provenance of the fixtures below: the response *shapes* are taken from
// `Ychris12138/dsh-usage-stats` (MIT), whose parsers are written against live
// responses, cross-checked against each vendor's published docs. The endpoints
// themselves were probed directly on 2026-08-15 — each answers 401 to a bad
// Bearer while a sibling path under the same prefix answers 404, which is what
// distinguishes "route exists, credential rejected" from "no such route".
//
// What is NOT verified: that a real key returns these bodies. Nobody here holds
// an OpenRouter, Moonshot, or Z.ai key. If a field name is wrong, the scheme
// reports `undefined` for it rather than a wrong number — which is the whole
// reason every field is read defensively instead of destructured.

test("a vendor origin names its scheme outright, with no fingerprint probe", () => {
	const accounts = listAccounts(
		ctxWith([piAi("or"), piAi("kimi"), piAi("glm")], {
			providers: {
				or: { baseURL: "https://openrouter.ai/api/v1" },
				kimi: { baseURL: "https://api.moonshot.cn/v1" },
				glm: { baseURL: "https://open.bigmodel.cn/api/paas/v4" }
			}
		}),
		{ softwareOf: new Map() }
	);
	assert.deepEqual(accounts.map((a) => a.scheme), ["openrouter", "moonshot", "zai"]);
	assert.deepEqual(accounts.map((a) => a.displayName), ["OpenRouter", "Moonshot", "智谱 GLM"]);
});

test("two routes at one vendor collapse, because they draw on one wallet", () => {
	// The opposite of the relay rule directly above: there, two keys are two
	// quotas and must stay apart. Here they are one account seen twice.
	const accounts = listAccounts(
		ctxWith([piAi("fast"), piAi("smart")], {
			providers: {
				fast: { baseURL: "https://api.moonshot.cn/v1" },
				smart: { baseURL: "https://api.moonshot.cn/v1" }
			}
		})
	);
	assert.equal(accounts.length, 1);
	assert.equal(accounts[0].displayName, "Moonshot");
});

test("openrouter reports remaining credit, not the top-up total", async () => {
	const result = await readBalance({
		scheme: "openrouter",
		origin: "https://openrouter.ai",
		apiKey: "sk-or-mgmt",
		fetch: okJson({ data: { total_credits: 50, total_usage: 12.5 } })
	});
	assert.equal(result.total, 37.5, "the headline is what is left, not what was bought");
	assert.equal(result.used, 12.5);
	assert.equal(result.granted, 50);
	assert.equal(result.currency, "USD");
	assert.equal(result.isAvailable, true);
});

test("openrouter says which key it wanted, rather than leaving a bare 401", async () => {
	// `/api/v1/credits` takes a Management Key, not the `sk-or-v1-` inference
	// key the route carries — so for most people this 401s, and a card reading
	// only "401" would send them to check a key that is perfectly fine.
	const result = await readBalance({
		scheme: "openrouter",
		origin: "https://openrouter.ai",
		apiKey: "sk-or-v1-inference",
		fetch: async () => ({ ok: false, status: 401 })
	});
	assert.equal(result.reason, "http-401");
	assert.equal(result.hint, "openrouter-management-key");
});

test("a scheme with no hint adds no hint field", async () => {
	const result = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: async () => ({ ok: false, status: 401 })
	});
	assert.equal("hint" in result, false);
});

test("moonshot separates voucher credit from cash", async () => {
	const result = await readBalance({
		scheme: "moonshot",
		origin: "https://api.moonshot.cn",
		apiKey: "sk-moonshot",
		fetch: okJson({ code: 0, data: { available_balance: 49.58, voucher_balance: 49.58, cash_balance: 0 } })
	});
	assert.equal(result.total, 49.58);
	assert.equal(result.granted, 49.58, "voucher credit is granted, not bought");
	assert.equal(result.toppedUp, 0);
	assert.equal(result.currency, "CNY", "the regional endpoint bills in one currency and does not say so");
});

test("a currency the body reports beats the one we assumed", async () => {
	const result = await readBalance({
		scheme: "moonshot",
		origin: "https://api.moonshot.cn",
		apiKey: "k",
		fetch: okJson({ data: { available_balance: 1, currency: "USD" } })
	});
	assert.equal(result.currency, "USD");
});

test("an unreported currency stays absent rather than being guessed", async () => {
	// `api.moonshot.ai` is the global endpoint; we do not know what it bills in,
	// so the card shows a bare number. A number under the wrong symbol is worse.
	const result = await readBalance({
		scheme: "moonshot",
		origin: "https://api.moonshot.ai",
		apiKey: "k",
		fetch: okJson({ data: { available_balance: 20 } })
	});
	assert.equal(result.total, 20);
	assert.equal(result.currency, undefined);
});

test("zai reads available against total", async () => {
	const result = await readBalance({
		scheme: "zai",
		origin: "https://open.bigmodel.cn",
		apiKey: "glm-key",
		fetch: okJson({ data: { total_balance: 100, available_balance: 64 } })
	});
	assert.equal(result.total, 64);
	assert.equal(result.granted, 100);
	assert.equal(result.currency, "CNY");
});

// --- quota windows ------------------------------------------------------------

test("a scheme describes what its vendor sent; readBalance does the arithmetic", async () => {
	// Normalising centrally is the point: a reader says "a ratio" or "seconds
	// from now" and never has to get the same conversion right a fifth time.
	const now = Date.UTC(2026, 7, 17, 12, 0, 0);
	const spec = {
		label: "Stub",
		read: async () => ({
			plan: "Go",
			windows: [
				{ kind: "weekly", usedRatio: 0.82 },
				{ kind: "session", minutes: 300, usedPercent: 4, resetInSeconds: 3600 }
			]
		})
	};
	SCHEMES.__stub = spec;
	try {
		const result = await readBalance({ scheme: "__stub", origin: "https://x.example", apiKey: "k", now, fetch: okJson({}) });
		assert.deepEqual(result.windows, [
			{ kind: "session", minutes: 300, resetsAt: "2026-08-17T13:00:00.000Z", usedPercent: 4 },
			{ kind: "weekly", usedPercent: 82 }
		]);
		assert.equal(result.plan, "Go", "the rest of the reader's answer is untouched");
	} finally {
		delete SCHEMES.__stub;
	}
});

test("a reader that emits nothing usable leaves no windows key at all", async () => {
	// Not `windows: []`. An empty list would have the card claim to be a
	// subscription account with nothing in it, which is the same lie as
	// reporting an unread balance as zero.
	SCHEMES.__stub = { label: "Stub", read: async () => ({ total: 5, windows: [{ kind: "ROLLING_5H", usedPercent: 3 }] }) };
	try {
		const result = await readBalance({ scheme: "__stub", origin: "https://x.example", apiKey: "k", fetch: okJson({}) });
		assert.equal("windows" in result, false);
		assert.equal(result.total, 5);
	} finally {
		delete SCHEMES.__stub;
	}
});

test("a money scheme still returns no windows key", async () => {
	const result = await readBalance({
		scheme: "deepseek",
		origin: "https://api.deepseek.com",
		apiKey: "k",
		fetch: okJson({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "3.00" }] })
	});
	assert.equal("windows" in result, false);
});

// --- vendors that refuse with a 200 ------------------------------------------
//
// Probed live with an invalid Bearer and a control path that does not exist:
//
//   GET https://api.z.ai/api/monitor/usage/quota/limit
//     -> 200 {"code":401,"msg":"token expired or incorrect","success":false}
//   GET https://api.z.ai/api/monitor/nope-404            (control)
//     -> 200 {"code":401,"msg":"token expired or incorrect","success":false}
//
// The control is the point: the status line does not even distinguish a route
// that exists from one that never did, so nothing can be read off it.

test("a refusal dressed as a 200 is a failure, not an empty account", async () => {
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "bad-key",
		fetch: okJson({ code: 401, msg: "token expired or incorrect", success: false })
	});
	assert.equal(result.fetched, false, "the vendor refused; nothing was read");
	assert.equal(result.reason, "upstream-401");
	assert.equal(result.total, undefined, "an account we could not read has no balance to report");
	assert.equal(result.isAvailable, undefined);
});

test("an envelope refusal reads differently from a transport failure", async () => {
	// Both are failures, and they are not the same failure: one means the vendor
	// answered and said no, the other means the status line said no. Collapsing
	// them loses the only thing that tells you the endpoint is even alive.
	const envelope = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: okJson({ success: false, msg: "nope" })
	});
	const transport = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: async () => ({ ok: false, status: 401 })
	});
	assert.equal(envelope.reason, "upstream-error", "no code in the body means no number to report");
	assert.equal(transport.reason, "http-401");
});

test("a success code spelled 0 is still a success", async () => {
	// The refusal signal is `success:false`; `code` only supplies the number.
	// Reading any non-200 code as a refusal would report a live account as
	// unreadable on every vendor that spells success `0`, which is common.
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: okJson({ code: 0, data: { total_balance: 100, available_balance: 64 } })
	});
	assert.equal(result.fetched, true);
	assert.equal(result.total, 64);
});

test("a vendor that carries neither convention is left alone", async () => {
	// `/api/paas/v4/balance` may answer with a bare `data` object. An envelope
	// that fires on absence would break every such response.
	const result = await readBalance({
		scheme: "zai",
		origin: "https://api.z.ai",
		apiKey: "k",
		fetch: okJson({ data: { total_balance: 10, available_balance: 10 } })
	});
	assert.equal(result.fetched, true);
	assert.equal(result.total, 10);
});

test("schemes whose vendor uses real status codes gain no envelope", async () => {
	// DeepSeek, Moonshot, OpenRouter and New API all answer 401 with a 401. A
	// blanket envelope check would start rejecting their success bodies for
	// carrying an unrelated `code` field.
	for (const scheme of ["deepseek", "moonshot", "openrouter", "newapi", "sub2api"]) {
		assert.equal(SCHEMES[scheme].envelope, undefined, scheme);
	}
});

test("a vendor response missing every field fails soft, with no zeros invented", async () => {
	for (const scheme of ["openrouter", "moonshot", "zai"]) {
		const result = await readBalance({ scheme, origin: "https://api.moonshot.cn", apiKey: "k", fetch: okJson({}) });
		assert.equal(result.fetched, true, scheme);
		assert.equal(result.total, undefined, `${scheme}: an unreported balance is not a balance of zero`);
		assert.equal(result.isAvailable, undefined, scheme);
	}
});
