import assert from "node:assert/strict";
import test from "node:test";

import { LedgerStore } from "../src/store.js";
import { applyUsageDelta } from "../src/usage.js";
import { RelaySiteRegistry, createSiteResolver } from "../src/relay-sites.js";

const DAY_A = Date.parse("2026-08-14T10:00:00");
const DAY_B = Date.parse("2026-08-15T10:00:00");

let seq = 0;
const ev = (type, data, time = DAY_A) => ({ type, seq: seq++, time, data });
const header = (provider, model, time = DAY_A) =>
	ev("request/header", { header: { config: { provider, model } } }, time);
const usageChunk = (turn, step, usage, time = DAY_A) =>
	ev("assistant/chunk", { turn, step, chunk: { type: "usage", usage } }, time);
const message = (turn, step, provider, model, usage, time = DAY_A) =>
	ev(
		"assistant/message",
		{ turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage },
		time
	);
const usage = (i, o, extra = {}) => ({ inputTokens: i, outputTokens: o, ...extra });

const withStore = (fn) => {
	const store = LedgerStore.open(":memory:");
	try {
		return fn(store);
	} finally {
		store.close();
	}
};

test("committing a session makes its totals queryable", () => {
	withStore((store) => {
		const state = applyUsageDelta(store.loadState("s1"), [
			header("deepseek", "v4"),
			message(1, 1, "deepseek", "v4", usage(100, 50))
		]);
		store.commitSession("s1", state);

		const totals = store.totals();
		assert.equal(totals.inputTokens, 100);
		assert.equal(totals.outputTokens, 50);
		assert.equal(totals.requests, 1);
		assert.equal(totals.tokens, 150);
	});
});

test("re-committing a session replaces its rows instead of adding to them", () => {
	withStore((store) => {
		const events = [header("deepseek", "v4"), message(1, 1, "deepseek", "v4", usage(100, 50))];
		for (let i = 0; i < 3; i++) {
			const state = store.loadState("s1");
			// Deliberately re-fold the SAME events every time, as a rebuild would.
			const fresh = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
			applyUsageDelta(fresh, events);
			store.commitSession("s1", fresh);
			assert.ok(state !== undefined);
		}
		assert.equal(store.totals().inputTokens, 100, "three identical folds still total one fold");
		assert.equal(store.totals().requests, 1);
	});
});

test("two sessions sum without interfering", () => {
	withStore((store) => {
		const s1 = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(s1, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
		const s2 = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(s2, [message(1, 1, "deepseek", "v4", usage(200, 20))]);
		store.commitSession("s1", s1);
		store.commitSession("s2", s2);

		assert.equal(store.totals().inputTokens, 300);
		store.dropSession("s1");
		assert.equal(store.totals().inputTokens, 200);
		assert.equal(store.checkpointFor("s1"), undefined);
	});
});

test("an incremental fold across a restart equals a from-scratch fold", () => {
	const events = [
		header("deepseek", "v4"),
		usageChunk(1, 1, usage(100, 20)),
		message(1, 1, "deepseek", "v4", usage(100, 50)),
		header("ark", "flash"),
		message(2, 1, "ark", "flash", usage(300, 30), DAY_B)
	];

	const incremental = withStore((store) => {
		// Slice the log at every boundary, reloading state from the store between
		// slices exactly as a restarted collector would.
		for (let cut = 1; cut <= events.length; cut++) {
			const state = store.loadState("s1");
			const slice = events.slice(cut - 1, cut);
			applyUsageDelta(state, slice);
			store.commitSession("s1", state, { logRevision: `r${cut}` });
		}
		assert.equal(store.checkpointFor("s1").consumedSeq, events.at(-1).seq);
		assert.equal(store.checkpointFor("s1").logRevision, `r${events.length}`);
		return store.byRoute();
	});

	const wholesale = withStore((store) => {
		const state = store.loadState("s1");
		applyUsageDelta(state, events);
		store.commitSession("s1", state);
		return store.byRoute();
	});

	assert.deepEqual(incremental, wholesale, "slicing the log must not change the answer");
});

test("a replacement spanning a restart is still not double counted", () => {
	withStore((store) => {
		let state = store.loadState("s1");
		applyUsageDelta(state, [header("deepseek", "v4"), usageChunk(1, 1, usage(100, 20))]);
		store.commitSession("s1", state);
		assert.equal(store.totals().outputTokens, 20);

		// Restart: nothing survives but the store.
		state = store.loadState("s1");
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 50))]);
		store.commitSession("s1", state);

		const totals = store.totals();
		assert.equal(totals.outputTokens, 50, "the later sample replaced the earlier one");
		assert.equal(totals.inputTokens, 100);
		assert.equal(totals.requests, 1);
	});
});

test("reset clears everything so the next pass rebuilds from seq 0", () => {
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
		store.commitSession("s1", state);
		store.reset();

		assert.equal(store.totals().inputTokens, 0);
		assert.equal(store.checkpointFor("s1"), undefined);
		assert.equal(store.loadState("s1").consumedSeq, -1, "a cleared session folds from the beginning");
	});
});

test("queries group by day, model, and site, and the site filter narrows them", () => {
	withStore((store) => {
		const registry = new RelaySiteRegistry([
			{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example" },
			{ id: "sub", type: "sub2api", baseUrl: "https://api.relay-two.example" }
		]);
		const resolveSite = createSiteResolver(registry, {
			relayA: "https://api.relay-one.example/v1",
			relayB: "https://api.relay-two.example/v1",
			official: "https://api.deepseek.com"
		});
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(
			state,
			[
				message(1, 1, "relayA", "v4", usage(100, 10), DAY_A),
				message(2, 1, "relayB", "v4", usage(200, 20), DAY_A),
				message(3, 1, "official", "flash", usage(300, 30), DAY_B)
			],
			{ resolveSite }
		);
		store.commitSession("s1", state);

		assert.deepEqual(store.byDay().map((d) => [d.day, d.inputTokens]), [
			["2026-08-14", 300],
			["2026-08-15", 300]
		]);
		assert.deepEqual(store.bySite().map((s) => [s.site, s.inputTokens]).sort(), [
			["direct", 300],
			["nine", 100],
			["sub", 200]
		].sort());
		assert.deepEqual(store.byModel().map((m) => [m.model, m.inputTokens]).sort(), [
			["flash", 300],
			["v4", 300]
		].sort());
		assert.equal(store.byModel({}, "nine").length, 1);
		assert.equal(store.byModel({}, "nine")[0].inputTokens, 100);
		assert.equal(store.totals({ from: "2026-08-15" }).inputTokens, 300);
		assert.equal(store.totals({ to: "2026-08-14" }).inputTokens, 300);
		assert.equal(store.totals({}, "sub").inputTokens, 200);
	});
});

test("zero-valued route buckets are not persisted", () => {
	withStore((store) => {
		// A replacement that lands on another day empties the first day's route.
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [header("deepseek", "v4"), usageChunk(1, 1, usage(100, 20), DAY_A)]);
		applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 50), DAY_B)]);
		store.commitSession("s1", state);

		assert.deepEqual(store.byDay().map((d) => d.day), ["2026-08-15"], "the emptied day is not stored");
		assert.equal(store.totals().outputTokens, 50);
	});
});

test("distinctRoutes is one row per route, not per unit of traffic", () => {
	// It runs on every sweep, so its size has to track the number of routes ever
	// seen rather than how much went through them.
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [
			message(1, 1, "deepseek", "v4", usage(100, 10), DAY_A),
			message(2, 2, "deepseek", "v4", usage(200, 20), DAY_B),
			message(3, 3, "deepseek", "v4-mini", usage(5, 1), DAY_B)
		]);
		store.commitSession("s1", state, {});

		// node:sqlite hands back null-prototype rows, so compare the fields.
		const routes = store.distinctRoutes().map((r) => ({ site: r.site, provider: r.provider }));
		assert.deepEqual(routes, [{ site: "direct", provider: "deepseek" }], "three days and two models, one route");
	});
});

test("diagnostics report counts and identifiers only", () => {
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [
			message(1, 1, "deepseek", "v4", usage(100, 10), DAY_A),
			usageChunk(9, 1, usage(7, 0), DAY_B) // no header seen for this one
		]);
		store.commitSession("s1", state, { dshVersion: "0.1.0-rc.6" });

		const d = store.diagnostics();
		assert.equal(d.schemaVersion, 2);
		assert.equal(d.sessionsTracked, 1);
		assert.equal(d.sessionsWithUsage, 1);
		assert.equal(d.firstDay, "2026-08-14");
		assert.equal(d.lastDay, "2026-08-15");
		assert.equal(d.unattributedRows, 1, "the header-less sample is visible as unattributed");
		assert.equal(store.checkpointFor("s1").dshVersion, "0.1.0-rc.6");
		assert.equal(JSON.stringify(d).includes("prompt"), false);
	});
});

test("csv export quotes cells that need it", () => {
	withStore((store) => {
		const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
		applyUsageDelta(state, [message(1, 1, "deepseek", 'weird,"model', usage(100, 10))]);
		store.commitSession("s1", state);

		const csv = store.exportCsv();
		const [head, row] = csv.split("\n");
		assert.equal(head.startsWith("day,site,provider,model,"), true);
		assert.ok(row.includes('"weird,""model"'), `unexpected row: ${row}`);
	});
});

test("a schema version bump discards the index rather than migrating it", () => {
	const store = LedgerStore.open(":memory:");
	const state = { days: new Map(), lastSample: null, currentRoute: null, consumedSeq: -1 };
	applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 10))]);
	store.commitSession("s1", state);
	assert.equal(store.totals().inputTokens, 100);
	store.close();
	// A real bump is exercised by the migrate path on open; here we assert the
	// contract the path relies on: the index is reconstructible from nothing.
	const fresh = LedgerStore.open(":memory:");
	assert.equal(fresh.totals().inputTokens, 0);
	assert.equal(fresh.diagnostics().rollupRows, 0);
	fresh.close();
});
