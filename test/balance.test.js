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
	assert.equal(isOfficialDeepSeek("https://api.9zyx.xyz/v1"), false);
	assert.equal(isOfficialDeepSeek("https://api.deepseek.com.evil.example"), false, "suffix must not match");
	assert.equal(isOfficialDeepSeek("not a url"), false);
});

test("every scheme answers the same shape, so one card renders all of them", () => {
	assert.deepEqual(Object.keys(SCHEMES).sort(), ["deepseek", "newapi", "sub2api"]);
	for (const [name, spec] of Object.entries(SCHEMES)) {
		assert.equal(typeof spec.read, "function", name);
		assert.equal(typeof spec.label, "string", name);
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

test("Sub2API reports its wallet and plan", async () => {
	const result = await readBalance({
		scheme: "sub2api",
		origin: "https://s.example",
		apiKey: "k",
		fetch: okJson({ unit: "USD", balance: "4.768", remaining: "3.2", planName: "pro", isValid: true })
	});
	assert.equal(result.total, 4.768);
	assert.equal(result.remaining, 3.2);
	assert.equal(result.plan, "pro");
	assert.equal(result.currency, "USD");
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
				api99: { baseURL: "https://api.9zyx.xyz/v1", apiKeyEnv: "RELAY_KEY" }
			}
		})
	);
	assert.deepEqual(accounts.map((a) => a.displayName), ["DeepSeek", "api.9zyx.xyz"]);
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
				gpt: { baseURL: "https://api.9zyx.xyz/v1" },
				claude: { baseURL: "https://api.9zyx.xyz/v2" }
			}
		})
	);
	assert.equal(accounts.length, 2);
	// And the picker must be able to tell them apart, which the bare host cannot.
	assert.deepEqual(accounts.map((a) => a.displayName), ["api.9zyx.xyz · gpt", "api.9zyx.xyz · claude"]);
});

test("a single key on a relay is labelled by host alone", () => {
	const accounts = listAccounts(
		ctxWith([piAi("api99")], { providers: { api99: { baseURL: "https://api.9zyx.xyz/v1" } } })
	);
	assert.deepEqual(accounts.map((a) => a.displayName), ["api.9zyx.xyz"], "no route suffix when it adds nothing");
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
			{ providers: { api99: { baseURL: "https://api.9zyx.xyz/v1", apiKeyEnv: "K" } } },
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
	assert.equal(learned.get("api.9zyx.xyz"), "newapi");
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
