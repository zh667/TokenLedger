import assert from "node:assert/strict";
import test from "node:test";

import { sweep } from "../src/plugin.js";
import { LedgerStore } from "../src/store.js";
import { RelaySiteRegistry, createSiteResolver } from "../src/relay-sites.js";

const DAY = Date.parse("2026-08-14T10:00:00");
let seq = 0;
const ev = (type, data) => ({ type, seq: seq++, time: DAY, data });
const header = (provider, model) => ev("request/header", { header: { config: { provider, model } } });
const message = (turn, step, provider, model, usage) =>
	ev("assistant/message", { turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage });

/**
 * A persistence double shaped like the real one: `listSnapshots()` returns
 * `{ header, revision }`, NOT `{ id }`. An earlier sweep read `snapshot.id`,
 * found nothing, and skipped every session in silence — a bug no synthetic
 * test caught because the double had been written to match the bug.
 */
const fakePersistence = (sessions) => ({
	async listSnapshots() {
		return [...sessions.entries()].map(([id, s]) => ({
			header: { version: 0, id, createdAt: DAY },
			revision: s.revision
		}));
	},
	async readFrom(id, fromSeq) {
		const s = sessions.get(id);
		if (s === undefined) throw new Error(`unknown session ${id}`);
		return { meta: { id }, events: s.events.filter((e) => e.seq >= fromSeq) };
	}
});

// Must await before closing: a synchronous `finally` around an async callback
// closes the database while the body is still using it, and every store call
// after that point fails inside the sweep's own error handling — which looks
// exactly like a collector bug.
const withStore = async (fn) => {
	const store = LedgerStore.open(":memory:");
	try {
		return await fn(store);
	} finally {
		store.close();
	}
};

test("the session id is read from snapshot.header.id", async () => {
	await withStore(async (store) => {
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })] }]
		]);
		const stats = await sweep(fakePersistence(sessions), store, {});
		assert.equal(stats.scanned, 1);
		assert.equal(stats.updated, 1);
		assert.equal(stats.failed, 0);
		assert.equal(store.totals().inputTokens, 100);
	});
});

test("a snapshot with no recoverable id is counted and reported, not silently dropped", async () => {
	await withStore(async (store) => {
		const persistence = {
			async listSnapshots() {
				return [{ revision: "r1" }];
			},
			async readFrom() {
				throw new Error("should not be reached");
			}
		};
		const warnings = [];
		const stats = await sweep(persistence, store, { logger: { warn: (...a) => warnings.push(a) } });
		assert.equal(stats.scanned, 1);
		assert.equal(stats.failed, 1, "silence here is what hid the header.id bug");
		assert.equal(warnings.length, 1);
	});
});

test("an unchanged revision is skipped without reading the log", async () => {
	await withStore(async (store) => {
		let reads = 0;
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })] }]
		]);
		const persistence = fakePersistence(sessions);
		const counting = { ...persistence, readFrom: (...a) => (reads++, persistence.readFrom(...a)) };

		await sweep(counting, store, {});
		assert.equal(reads, 1);
		const second = await sweep(counting, store, {});
		assert.equal(reads, 1, "an unchanged log must cost no read at all");
		assert.equal(second.skipped, 1);
	});
});

test("a changed revision reads only the tail and stays exact", async () => {
	await withStore(async (store) => {
		const events = [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 100, outputTokens: 10 })];
		const sessions = new Map([["s1", { revision: "r1", events }]]);
		const persistence = fakePersistence(sessions);
		await sweep(persistence, store, {});

		// Append a second turn and bump the revision, as an append would.
		events.push(message(2, 1, "p", "m", { inputTokens: 50, outputTokens: 5 }));
		sessions.get("s1").revision = "r2";
		const stats = await sweep(persistence, store, {});

		assert.equal(stats.updated, 1);
		assert.equal(stats.events, 1, "only the appended event was read");
		assert.equal(store.totals().inputTokens, 150);
		assert.equal(store.totals().requests, 2);
	});
});

test("one broken session does not stop the others", async () => {
	await withStore(async (store) => {
		const good = [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 7, outputTokens: 1 })];
		const persistence = {
			async listSnapshots() {
				return [
					{ header: { id: "bad" }, revision: "r1" },
					{ header: { id: "good" }, revision: "r1" }
				];
			},
			async readFrom(id) {
				if (id === "bad") throw new Error("corrupt log");
				return { meta: { id }, events: good };
			}
		};
		const stats = await sweep(persistence, store, { logger: { warn() {} } });
		assert.equal(stats.failed, 1);
		assert.equal(stats.updated, 1);
		assert.equal(store.totals().inputTokens, 7);
	});
});

test("a listSnapshots failure degrades instead of throwing into DSH", async () => {
	await withStore(async (store) => {
		const persistence = {
			async listSnapshots() {
				throw new Error("backend down");
			}
		};
		const stats = await sweep(persistence, store, { logger: { warn() {} } });
		assert.equal(stats.failed, 1);
		assert.equal(stats.scanned, 0);
	});
});

test("relay attribution flows through the sweep", async () => {
	await withStore(async (store) => {
		const registry = new RelaySiteRegistry([
			{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" }
		]);
		const resolveSite = createSiteResolver(registry, { ninerelay: "https://api.relay-one.example/v1" });
		const sessions = new Map([
			[
				"s1",
				{
					revision: "r1",
					events: [
						header("ninerelay", "gpt"),
						message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 10 }),
						message(2, 1, "elsewhere", "gpt", { inputTokens: 20, outputTokens: 2 })
					]
				}
			]
		]);
		await sweep(fakePersistence(sessions), store, { resolveSite });

		const sites = store.bySite();
		assert.deepEqual(
			sites.map((s) => [s.site, s.inputTokens]).sort(),
			[
				["direct", 20],
				["nine", 100]
			].sort()
		);
	});
});

test("the dsh version is stamped on the checkpoint", async () => {
	await withStore(async (store) => {
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 1, outputTokens: 1 })] }]
		]);
		await sweep(fakePersistence(sessions), store, { dshVersion: "0.1.0-rc.6" });
		assert.equal(store.checkpointFor("s1").dshVersion, "0.1.0-rc.6");
		assert.equal(store.checkpointFor("s1").logRevision, "r1");
	});
});
