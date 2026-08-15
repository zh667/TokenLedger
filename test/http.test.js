import assert from "node:assert/strict";
import test from "node:test";

import {
	BASE_PATH,
	dailyModels,
	USAGE_PATH,
	hostNameOf,
	hostTimeZone,
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

test("the web server is waited for, not sampled at mount", async () => {
	// Third time this mistake shipped: ctx.get answers undefined for a service
	// that mounts later, and webServer is one of them. The routes silently never
	// registered, and the panel got a 404 from a plugin whose host half had
	// demonstrably loaded — the SQLite store was open in the same log.
	const registered = [];
	let waitedFor;
	const ctx = {
		// A context whose `get` NEVER answers, exactly like mount-time reality.
		get: () => undefined,
		inject: (deps, run) => {
			waitedFor = deps;
			run({
				webServer: { register: (spec) => void registered.push(spec) },
				effect: (fn) => fn()
			});
		},
		effect: (fn) => fn()
	};
	assert.equal(registerRoutes(ctx, { store: {}, sites: () => [] }), true);
	assert.deepEqual(waitedFor, ["webServer"]);
	assert.equal(registered.length, 1, "the routes must register once the service arrives");
	assert.equal(registered[0].path, USAGE_PATH);
});

test("a Cordis without ctx.inject still registers immediately", async () => {
	// Older harnesses, and the test doubles above. The fallback must not be a
	// silent no-op.
	const registered = [];
	const ctx = {
		get: () => ({ register: (spec) => void registered.push(spec) }),
		effect: (fn) => fn()
	};
	assert.equal(registerRoutes(ctx, { store: {}, sites: () => [] }), true);
	assert.equal(registered.length, 1);
});

test("every payload reports the installed version", async () => {
	// Several rounds went into a missing panel that turned out to be a stale
	// install. A copy that is behind looks exactly like one that is broken, and
	// nothing on either side could tell them apart.
	const store = seeded();
	try {
		const p = usagePayload({ store, sites: () => [] }, { range: {} });
		assert.equal(typeof p.version, "string");
		assert.notEqual(p.version, "unknown", "the manifest must be readable from the shipped layout");
		assert.match(p.version, /^\d+\.\d+\.\d+/);
	} finally {
		store.close();
	}
});

test("one model reached through two relays is one row, not two halves", () => {
	// byRoute is keyed by (day, site, provider, model), so the day tooltip listed
	// the same model twice — each showing half its real total and half its real
	// share. Seen in a browser, not in a test.
	const merged = dailyModels([
		{ day: "2026-08-14", site: "a.example", model: "gpt", tokens: 64552 },
		{ day: "2026-08-14", site: "direct", model: "gpt", tokens: 10170 },
		{ day: "2026-08-14", site: "direct", model: "claude", tokens: 0 },
		{ day: "2026-08-13", site: "direct", model: "gpt", tokens: 5 }
	]);
	assert.deepEqual(merged, [
		{ day: "2026-08-13", model: "gpt", tokens: 5 },
		{ day: "2026-08-14", model: "gpt", tokens: 74722 }
	]);
});

test("a model that ran nothing that day is not part of that day's breakdown", () => {
	assert.deepEqual(dailyModels([{ day: "d", model: "idle", tokens: 0 }]), []);
});

test("rows are ordered by day, then by size within the day", () => {
	const rows = dailyModels([
		{ day: "2026-08-14", model: "small", tokens: 1 },
		{ day: "2026-08-14", model: "big", tokens: 100 },
		{ day: "2026-08-12", model: "mid", tokens: 50 }
	]);
	assert.deepEqual(rows.map((r) => r.model), ["mid", "big", "small"]);
});

test("the payload names the host's timezone, offset and all", () => {
	const store = seeded();
	try {
		const p = usagePayload({ store, sites: () => [] }, { range: {} });
		assert.match(p.timeZone.offset, /^UTC[+-]\d{2}:\d{2}$/);
	} finally {
		store.close();
	}
});

test("the offset's sign is inverted from getTimezoneOffset, which counts west", () => {
	// getTimezoneOffset returns minutes WEST of UTC, so Tokyo (UTC+9) reports
	// -540. Printing it unflipped would label every eastern zone as western.
	const tokyo = hostTimeZone({ getTimezoneOffset: () => -540 });
	assert.equal(tokyo.offset, "UTC+09:00");
	const newYork = hostTimeZone({ getTimezoneOffset: () => 300 });
	assert.equal(newYork.offset, "UTC-05:00");
	// Half-hour and quarter-hour zones exist and must not round away.
	assert.equal(hostTimeZone({ getTimezoneOffset: () => -330 }).offset, "UTC+05:30");
	assert.equal(hostTimeZone({ getTimezoneOffset: () => -345 }).offset, "UTC+05:45");
	assert.equal(hostTimeZone({ getTimezoneOffset: () => 0 }).offset, "UTC+00:00");
});

test("the payload separates when the logs were read from when they changed", () => {
	// One is freshness, the other is activity. Reporting the second as the first
	// made a quiet half hour look like a stuck panel.
	const store = seeded();
	try {
		const read = Date.now();
		const p = usagePayload({ store, sites: () => [], lastSweepAt: () => read }, { range: {} });
		assert.equal(p.lastSweepAt, read);
		assert.equal(typeof p.diagnostics.lastUpdatedAt, "number");
	} finally {
		store.close();
	}
});

test("a host that has never swept reports no read time rather than a wrong one", () => {
	const store = seeded();
	try {
		assert.equal(usagePayload({ store, sites: () => [] }, { range: {} }).lastSweepAt, undefined);
	} finally {
		store.close();
	}
});
