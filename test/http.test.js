import assert from "node:assert/strict";
import test from "node:test";

import {
	BASE_PATH,
	USAGE_PATH,
	hostNameOf,
	isLoopbackAddress,
	parseQuery,
	registerRoutes,
	screenRequest,
	usagePayload
} from "../src/http.js";
import { LedgerStore } from "../src/store.js";
import { applyUsageDelta } from "../src/usage.js";

const req = (over = {}) => ({
	method: "GET",
	url: USAGE_PATH,
	headers: { host: "127.0.0.1:3000" },
	socket: { remoteAddress: "127.0.0.1" },
	...over
});

// --- the fence ---------------------------------------------------------------
//
// These routes register as `exact`, which wins over the RPC prefix and so sits
// OUTSIDE the RPC trust boundary. Nothing upstream screens the caller.

test("a loopback GET is served", () => {
	assert.equal(screenRequest(req()), undefined);
});

test("IPv6-mapped IPv4 counts as loopback, or every local request looks foreign", () => {
	// What Node reports on a dual-stack listener.
	assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
	assert.equal(isLoopbackAddress("::1"), true);
	assert.equal(isLoopbackAddress("127.0.0.1"), true);
	assert.equal(isLoopbackAddress("10.0.0.4"), false);
	assert.equal(isLoopbackAddress(undefined), false);
});

test("a remote peer is refused even when it claims a loopback Host", () => {
	// The header is whatever the client typed; the socket address is observed.
	// Screening on the header alone is the mistake this asserts against.
	const refused = screenRequest(req({ socket: { remoteAddress: "203.0.113.9" } }));
	assert.equal(refused?.status, 403);
});

test("a loopback peer with a foreign Host is also refused", () => {
	// DNS rebinding: the socket is local because the browser is local.
	const refused = screenRequest(req({ headers: { host: "evil.example" } }));
	assert.equal(refused?.status, 403);
});

test("anything but GET is refused before any work", () => {
	for (const method of ["POST", "DELETE", "PUT"]) {
		assert.equal(screenRequest(req({ method }))?.status, 405, method);
	}
});

test("a bracketed IPv6 Host is parsed without its port", () => {
	assert.equal(hostNameOf("[::1]:3000"), "::1");
	assert.equal(hostNameOf("localhost:3000"), "localhost");
	assert.equal(hostNameOf("localhost"), "localhost");
	assert.equal(hostNameOf(undefined), "");
});

// --- query -------------------------------------------------------------------

test("the query mirrors the command's arguments", () => {
	assert.deepEqual(parseQuery(`${USAGE_PATH}`), { range: {}, site: undefined });
	assert.equal(parseQuery(`${USAGE_PATH}?site=a.example`).site, "a.example");
	assert.ok(parseQuery(`${USAGE_PATH}?days=7`).range.from);
	assert.deepEqual(parseQuery(`${USAGE_PATH}?days=0`).range, {}, "a nonsense range is all time, not an error");
	assert.deepEqual(parseQuery("::::").range, {}, "an unparseable url must not throw");
});

// --- payload -----------------------------------------------------------------

const seeded = () => {
	const store = LedgerStore.open(":memory:");
	const state = store.loadState("s");
	applyUsageDelta(
		state,
		[
			{
				type: "assistant/message",
				seq: 1,
				time: Date.now(),
				data: {
					turn: 1,
					step: 1,
					message: { role: "assistant", source: { kind: "model", provider: "api99", model: "gpt" } },
					usage: { inputTokens: 1000, outputTokens: 100 }
				}
			}
		],
		{ resolveSite: () => "api.relay-one.example" }
	);
	store.commitSession("s", state);
	return store;
};

test("one request carries the whole panel, so its sections cannot disagree mid-load", () => {
	const store = seeded();
	try {
		const p = usagePayload({ store, sites: () => [] }, { range: {}, site: undefined });
		for (const key of ["totals", "days", "models", "sites", "providers", "directory", "diagnostics"]) {
			assert.ok(key in p, `missing ${key}`);
		}
		assert.equal(p.totals.outputTokens, 100);
	} finally {
		store.close();
	}
});

test("the site breakdown ignores the current filter, because it is how you change it", () => {
	const store = seeded();
	try {
		const p = usagePayload({ store, sites: () => [] }, { range: {}, site: "nowhere" });
		assert.ok(p.sites.some((s) => s.site === "api.relay-one.example"), "filtering the breakdown strands the user");
		assert.equal(p.totals.outputTokens, 0, "but the totals do honour it");
	} finally {
		store.close();
	}
});

test("the directory carries routes and software, which the totals cannot say", () => {
	const store = seeded();
	try {
		const p = usagePayload(
			{ store, sites: () => [{ id: "api.relay-one.example", routes: ["api99"], type: "newapi" }] },
			{ range: {} }
		);
		assert.deepEqual(p.directory, [
			{ id: "api.relay-one.example", routes: ["api99"], type: "newapi", discovered: true }
		]);
	} finally {
		store.close();
	}
});

// --- registration ------------------------------------------------------------

test("a composition with no web server keeps collecting instead of failing", () => {
	assert.equal(registerRoutes({ get: () => undefined }, {}), false);
	assert.equal(registerRoutes({}, {}), false);
});

test("routes register as exact, and a refused caller never reaches the store", async () => {
	const registered = [];
	let reads = 0;
	const ctx = {
		get: () => ({ register: (spec) => void registered.push(spec) }),
		effect: (fn) => fn()
	};
	const store = seeded();
	try {
		assert.equal(
			registerRoutes(ctx, {
				store,
				sites: () => [],
				sweep: async () => void reads++
			}),
			true
		);
		assert.deepEqual(registered.map((r) => r.kind), ["exact"]);
		assert.equal(registered[0].path, `${BASE_PATH}/usage`);

		const sent = [];
		const res = { writeHead: (status) => sent.push(status), end: () => {} };
		await registered[0].handler(req({ socket: { remoteAddress: "8.8.8.8" } }), res);
		assert.deepEqual(sent, [403]);
		assert.equal(reads, 0, "a refused request must not sweep or read");

		await registered[0].handler(req(), res);
		assert.deepEqual(sent, [403, 200]);
		assert.equal(reads, 1);
	} finally {
		store.close();
	}
});

test("a read that throws answers 500 rather than taking the harness down", async () => {
	const registered = [];
	const ctx = { get: () => ({ register: (s) => void registered.push(s) }), effect: (fn) => fn() };
	registerRoutes(ctx, {
		store: {
			totals() {
				throw new Error("locked");
			}
		},
		sites: () => [],
		logger: { warn() {} }
	});
	const sent = [];
	await registered[0].handler(req(), { writeHead: (s) => sent.push(s), end: () => {} });
	assert.deepEqual(sent, [500]);
});

test("the balance route only exists when a reader was supplied", () => {
	const registered = [];
	const ctx = { get: () => ({ register: (s) => void registered.push(s) }), effect: (fn) => fn() };
	registerRoutes(ctx, { store: {}, sites: () => [] });
	assert.equal(registered.length, 1);

	registered.length = 0;
	registerRoutes(ctx, { store: {}, sites: () => [], balance: async () => ({ ok: true }) });
	assert.equal(registered.length, 2);
});
