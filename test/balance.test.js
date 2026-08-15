import assert from "node:assert/strict";
import test from "node:test";

import { createBalanceReader, isOfficialDeepSeek, parseBalance, readDeepSeekBalance } from "../src/balance.js";

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

test("an unreported balance is absent, not zero", () => {
	// Zero is a balance. Absent is not knowing. Rendering the second as the first
	// would tell someone their account is empty.
	const parsed = parseBalance({ is_available: true, balance_infos: [] });
	assert.equal(parsed.isAvailable, true);
	assert.equal(parsed.total, undefined);
	assert.equal(parsed.currency, undefined);
});

test("CNY is preferred, but any entry beats none", () => {
	const cny = parseBalance({
		balance_infos: [
			{ currency: "USD", total_balance: "1.00" },
			{ currency: "CNY", total_balance: "36.44" }
		]
	});
	assert.equal(cny.currency, "CNY");
	assert.equal(cny.total, "36.44");
	assert.equal(parseBalance({ balance_infos: [{ currency: "USD", total_balance: "1.00" }] }).currency, "USD");
});

test("the key rides an Authorization header, never a query string", async () => {
	let seen;
	await readDeepSeekBalance({
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
	const result = await readDeepSeekBalance({
		fetch: async () => void called++
	});
	assert.deepEqual(result, { supported: true, ok: false, reason: "no-credential" });
	assert.equal(called, 0);
});

test("an http error and an unreachable host read differently", async () => {
	assert.equal(
		(await readDeepSeekBalance({ apiKey: "k", fetch: async () => ({ ok: false, status: 401 }) })).reason,
		"http-401"
	);
	assert.equal(
		(
			await readDeepSeekBalance({
				apiKey: "k",
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				}
			})
		).reason,
		"unreachable"
	);
});

// --- reaching the host -------------------------------------------------------

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

const piAi = (route) => ({ provider: route, settingsNs: "llm-pi-ai", settingsPath: ["providers", route] });

test("a deployment with only relays says so, and calls nothing", async () => {
	// Not a failure: a relay has no /user/balance. A red state here would flag a
	// problem on a panel where nothing is wrong.
	let called = 0;
	const read = createBalanceReader(
		ctxWith([piAi("api99")], { providers: { api99: { baseURL: "https://api.9zyx.xyz/v1" } } }),
		{ fetch: async () => void called++ }
	);
	assert.deepEqual(await read(), { ok: true, supported: false, reason: "no-official-route" });
	assert.equal(called, 0);
});

test("the official route's credential reference is resolved at request time", async () => {
	let resolved;
	const read = createBalanceReader(
		ctxWith(
			[piAi("api99"), piAi("official")],
			{
				providers: {
					api99: { baseURL: "https://api.9zyx.xyz/v1" },
					official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_KEY" }
				}
			},
			{
				resolve: async (reference) => {
					resolved = reference;
					return { value: "sk-live" };
				}
			}
		),
		{ fetch: async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "36.44" }] }) }) }
	);
	const result = await read();
	assert.equal(resolved, "DEEPSEEK_KEY");
	assert.equal(result.provider, "official");
	assert.equal(result.total, "36.44");
});

test("a host that cannot be asked is reported as unsupported, not as a failure", async () => {
	assert.equal((await createBalanceReader({ get: () => undefined })()).reason, "no-provider-directory");
	const throws = createBalanceReader({
		get: (n) =>
			n === "llm"
				? {
						listConfigurableProviders() {
							throw new Error("rc bump");
						}
					}
				: { get: () => ({}) }
	});
	assert.equal((await throws()).supported, false);
});

test("a missing credentials service degrades to no-credential rather than throwing", async () => {
	const read = createBalanceReader(
		ctxWith([piAi("official")], { providers: { official: { baseURL: "https://api.deepseek.com", apiKeyEnv: "K" } } }),
		{ fetch: async () => ({ ok: true, json: async () => ({}) }) }
	);
	assert.equal((await read()).reason, "no-credential");
});
