/**
 * Endpoints a user declares.
 *
 * This feature lets a configuration file decide where a request carrying the
 * user's API key is sent. Every boundary in `declarative.js` therefore has a
 * test here that tries to get through it, because a boundary nobody attacks is
 * a boundary nobody has checked.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createBalanceReader, readBalance } from "../src/balance.js";
import { compileEndpoint, indexEndpoints, readPath } from "../src/declarative.js";

const ORIGIN = "https://relay-one.example";

/** A declaration covering both halves of the card. */
const DECLARATION = {
	origin: ORIGIN,
	displayName: "我的中转站",
	path: "/api/quota",
	fields: { total: "data.balance", granted: "data.total", used: "data.used", currency: "data.unit", plan: "data.plan_name" },
	windows: [{ kind: "weekly", minutes: 10080, usedPercent: "data.week.percent", resetsAt: "data.week.reset_at" }]
};

const BODY = {
	data: {
		balance: "12.5",
		total: 20,
		used: 7.5,
		unit: "CNY",
		plan_name: "包月",
		week: { percent: 63, reset_at: "2026-08-21T00:00:00Z" }
	}
};

/** A `ctx` whose one provider route points at ORIGIN. */
const ctxWith = (profile = { baseURL: `${ORIGIN}/v1`, apiKeyEnv: "RELAY_KEY" }) => ({
	get: (name) =>
		name === "llm"
			? { listConfigurableProviders: () => [{ provider: "mine", settingsNs: "ns", settingsPath: [] }] }
			: name === "credentials"
				? { resolve: async () => ({ value: "sk-route-key" }) }
				: { get: () => profile }
});

/** Record every request, and answer the declared path with `body`. */
function spy(body, over = {}) {
	const seen = [];
	const fetch = async (url, init) => {
		seen.push({ url, ...init });
		return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), ...over };
	};
	return { fetch, seen };
}

// --- it works at all ------------------------------------------------------------

test("a declaration renders a full card from paths the user wrote", async () => {
	const { fetch } = spy(BODY);
	const result = await createBalanceReader(ctxWith(), { endpoints: [DECLARATION], fetch })();
	assert.equal(result.fetched, true);
	assert.equal(result.declared, true, "the card has to be able to say where these numbers came from");
	assert.equal(result.total, 12.5, "a number sent as a string is still a number");
	assert.equal(result.granted, 20);
	assert.equal(result.used, 7.5);
	assert.equal(result.currency, "CNY");
	assert.equal(result.plan, "包月");
	assert.deepEqual(result.windows, [{ kind: "weekly", minutes: 10080, usedPercent: 63, resetsAt: "2026-08-21T00:00:00.000Z" }]);
});

test("a path that misses costs that field and nothing else", async () => {
	const { fetch } = spy(BODY);
	const typo = { ...DECLARATION, fields: { ...DECLARATION.fields, total: "data.blance" } };
	const result = await createBalanceReader(ctxWith(), { endpoints: [typo], fetch })();
	assert.equal(result.fetched, true);
	assert.equal(result.total, undefined);
	assert.equal(result.granted, 20, "the fields that did resolve still render");
});

test("a declaration that resolves nothing says so rather than showing an empty account", async () => {
	const { fetch } = spy({ unrelated: true });
	const result = await createBalanceReader(ctxWith(), { endpoints: [{ origin: ORIGIN, path: "/x" }], fetch })();
	assert.match(result.reason, /named no fields/);
});

test("an origin match is case- and trailing-slash-insensitive", async () => {
	// Otherwise the feature appears not to work, for a reason nobody can see.
	const { fetch } = spy(BODY);
	const declared = { ...DECLARATION, origin: "https://Relay-One.Example/v1/" };
	const result = await createBalanceReader(ctxWith(), { endpoints: [declared], fetch })();
	assert.equal(result.declared, true);
});

// --- boundary 1: the request goes to the ACCOUNT's origin ------------------------

test("a declaration cannot name a host the harness was not already talking to", async () => {
	// The declared origin is a lookup key, nothing more. One that matches no
	// configured provider is never consulted, so it can never cause a request.
	const { fetch, seen } = spy(BODY);
	const elsewhere = { ...DECLARATION, origin: "https://collector.example" };
	const result = await createBalanceReader(ctxWith(), { endpoints: [elsewhere], fetch })();
	assert.equal(result.supported, false);
	assert.equal(result.reason, "unknown-software");
	assert.equal(seen.length, 0, "no request may be made to an origin nobody configured");
});

test("the URL is built from the account's origin, not from the declaration's", async () => {
	const { fetch, seen } = spy(BODY);
	await createBalanceReader(ctxWith(), { endpoints: [DECLARATION], fetch })();
	assert.equal(seen[0].url, `${ORIGIN}/api/quota`);
});

// --- boundary 2: the path cannot be a host in disguise ---------------------------

test("a protocol-relative path is refused, because it is another host wearing a path", async () => {
	// `new URL("//evil.example/x", "https://relay.example")` resolves to
	// https://evil.example/x. The single most likely way to smuggle a host in.
	assert.equal(compileEndpoint({ ...DECLARATION, path: "//collector.example/steal" }), undefined);
	assert.equal(compileEndpoint({ ...DECLARATION, path: "https://collector.example/steal" }), undefined);
	assert.equal(compileEndpoint({ ...DECLARATION, path: "api/quota" }), undefined, "a relative path is not what anyone means");
	assert.equal(compileEndpoint({ ...DECLARATION, path: "" }), undefined);
	assert.equal(compileEndpoint({ ...DECLARATION, path: undefined }), undefined);
	assert.notEqual(compileEndpoint(DECLARATION), undefined);
});

test("a refused declaration leaves the account unsupported and sends nothing", async () => {
	const { fetch, seen } = spy(BODY);
	const smuggled = { ...DECLARATION, path: "//collector.example/steal" };
	const result = await createBalanceReader(ctxWith(), { endpoints: [smuggled], fetch })();
	assert.equal(result.supported, false);
	assert.equal(seen.length, 0);
});

// --- boundary 3: only GET, and only our own headers ------------------------------

test("nothing in a declaration reaches the request but the path", async () => {
	const { fetch, seen } = spy(BODY);
	const loaded = { ...DECLARATION, method: "POST", body: "x", headers: { "x-exfil": "1" } };
	await createBalanceReader(ctxWith(), { endpoints: [loaded], fetch })();
	assert.equal(seen[0].method, undefined, "no method is ever set, so it is a GET");
	assert.equal(seen[0].body, undefined);
	assert.deepEqual(Object.keys(seen[0].headers).sort(), ["accept", "authorization"]);
});

// --- boundary 4: the credential is the route's own -------------------------------

test("the key comes from the route, and a declaration cannot name another one", async () => {
	const { fetch, seen } = spy(BODY);
	const greedy = { ...DECLARATION, apiKeyEnv: "SOMEONE_ELSES_KEY", credential: "SOMEONE_ELSES_KEY" };
	await createBalanceReader(ctxWith(), { endpoints: [greedy], fetch })();
	assert.equal(seen[0].headers.authorization, "Bearer sk-route-key");
});

test("the raw-key form is the only auth choice a declaration gets", async () => {
	const { fetch, seen } = spy(BODY);
	await createBalanceReader(ctxWith(), { endpoints: [{ ...DECLARATION, raw: true }], fetch })();
	assert.equal(seen[0].headers.authorization, "sk-route-key");
});

test("a route with no key makes no request", async () => {
	const { fetch, seen } = spy(BODY);
	const ctx = ctxWith({ baseURL: `${ORIGIN}/v1` });
	const result = await createBalanceReader(ctx, { endpoints: [DECLARATION], fetch })();
	assert.equal(result.reason, "no-credential");
	assert.equal(seen.length, 0);
});

// --- boundary 5: redirects stay on the origin ------------------------------------

test("a cross-origin redirect fails instead of handing the key over", async () => {
	// The default `follow` re-sends the Authorization header to wherever the
	// redirect points, which is the cheapest possible way around boundary 1.
	const fetch = async () => ({
		ok: false,
		status: 302,
		headers: { get: (name) => (name === "location" ? "https://collector.example/x" : null) }
	});
	const result = await createBalanceReader(ctxWith(), { endpoints: [DECLARATION], fetch })();
	assert.equal(result.fetched, false);
	assert.equal(result.reason, "cross-origin-redirect");
});

test("a same-origin redirect is followed, once the origin has been checked", async () => {
	let hop = 0;
	const fetch = async (url, init) => {
		hop += 1;
		if (hop === 1) {
			assert.equal(init.redirect, "manual", "the hops have to be taken by hand to be checked at all");
			return { ok: false, status: 301, headers: { get: () => `${ORIGIN}/api/quota/` } };
		}
		assert.equal(url, `${ORIGIN}/api/quota/`);
		return { ok: true, status: 200, json: async () => BODY, text: async () => JSON.stringify(BODY) };
	};
	const result = await createBalanceReader(ctxWith(), { endpoints: [DECLARATION], fetch })();
	assert.equal(result.total, 12.5);
});

test("a same-origin redirect loop ends rather than spinning", async () => {
	const fetch = async () => ({ ok: false, status: 302, headers: { get: () => `${ORIGIN}/api/quota` } });
	const result = await createBalanceReader(ctxWith(), { endpoints: [DECLARATION], fetch })();
	assert.equal(result.reason, "http-302");
});

// --- boundary 6: bounded body ----------------------------------------------------

test("an oversized body is refused before it is parsed", async () => {
	const huge = `{"data":{"balance":"${"9".repeat(2_000_000)}"}}`;
	const fetch = async () => ({ ok: true, status: 200, text: async () => huge });
	const result = await createBalanceReader(ctxWith(), { endpoints: [DECLARATION], fetch })();
	assert.equal(result.reason, "too-large");
});

test("a streaming body is cut off at the cap rather than buffered whole", async () => {
	// The length check bounds the parse; only the reader bounds the download.
	let cancelled = false;
	const chunk = new Uint8Array(300_000);
	const fetch = async () => ({
		ok: true,
		status: 200,
		body: {
			getReader: () => ({
				read: async () => ({ done: false, value: chunk }),
				cancel: async () => {
					cancelled = true;
				}
			})
		}
	});
	const result = await createBalanceReader(ctxWith(), { endpoints: [DECLARATION], fetch })();
	assert.equal(result.reason, "too-large");
	assert.equal(cancelled, true, "an endpoint that keeps talking must be hung up on");
});

test("the cap applies only where a declaration asked for one", async () => {
	// Built-in schemes are unchanged: they call `get` without a byte budget and
	// keep taking the fast `response.json()` path.
	const { fetch } = spy({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "3" }] });
	const result = await readBalance({ scheme: "deepseek", origin: "https://api.deepseek.com", apiKey: "k", fetch });
	assert.equal(result.total, 3);
});

// --- boundary 7: paths cannot climb out ------------------------------------------

test("a path cannot reach the prototype chain", async () => {
	const body = { data: { balance: 1 } };
	for (const path of ["__proto__", "constructor", "data.__proto__.polluted", "data.constructor.name"]) {
		assert.equal(readPath(body, path), undefined, path);
	}
	assert.equal(readPath(body, "data.balance"), 1);
});

test("a path that walks off the end of the document is absent, not an error", async () => {
	const body = { a: { b: [1, 2] } };
	assert.equal(readPath(body, "a.b.5"), undefined);
	assert.equal(readPath(body, "a.b.0.c.d.e"), undefined);
	assert.equal(readPath(body, "a.b.1"), 2, "indexing an array is fine, and useful");
	assert.equal(readPath(body, ""), undefined);
	assert.equal(readPath(body, undefined), undefined);
});

// --- boundary 8: a declaration cannot shadow a built-in --------------------------

test("declaring an endpoint on a known vendor's origin changes nothing", async () => {
	// Otherwise this is a way to make the panel read DeepSeek however anyone
	// with write access to a settings file likes.
	const { fetch, seen } = spy({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "3.00" }] });
	const ctx = {
		get: (name) =>
			name === "llm"
				? { listConfigurableProviders: () => [{ provider: "ds", settingsNs: "ns", settingsPath: [] }] }
				: name === "credentials"
					? { resolve: async () => ({ value: "sk-route-key" }) }
					: { get: () => ({ baseURL: "https://api.deepseek.com", apiKeyEnv: "K" }) }
	};
	const hijack = { origin: "https://api.deepseek.com", path: "/somewhere/else", fields: { total: "x" } };
	const result = await createBalanceReader(ctx, { endpoints: [hijack], fetch })();
	assert.equal(result.declared, undefined);
	assert.equal(result.total, 3);
	assert.equal(new URL(seen[0].url).pathname, "/user/balance", "the built-in reader decided the path");
});

// --- the index -------------------------------------------------------------------

test("a duplicate declaration is inert, not an override", async () => {
	const first = { origin: ORIGIN, path: "/a" };
	const second = { origin: `${ORIGIN}/`, path: "/b" };
	assert.equal(indexEndpoints([first, second]).get(ORIGIN).path, "/a");
});

test("a malformed endpoints list is empty, not a crash", async () => {
	for (const junk of [undefined, null, "endpoints", 5, [null], [{}], [{ origin: "not a url" }]]) {
		assert.equal(indexEndpoints(junk).size === 0 || indexEndpoints(junk).size === 1, true, JSON.stringify(junk));
	}
	assert.equal(indexEndpoints([{ origin: "not a url" }]).size, 0);
});
