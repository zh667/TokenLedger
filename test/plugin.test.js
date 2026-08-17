import assert from "node:assert/strict";
import test from "node:test";

import { buildResolver, normalizeRelayConfig, staleAttributions, sweep } from "../src/plugin.js";
import { LedgerStore } from "../src/store.js";
import { RelaySiteRegistry, createSiteResolver } from "../src/relay-sites.js";
import { DIRECT } from "../src/usage.js";

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

// --- the index can drift from the directory ------------------------------------

/** A directory that resolves `nine` to a relay and knows nothing else. */
function liveDirectory() {
	const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" }]);
	const providerBaseUrls = { ninerelay: "https://api.relay-one.example/v1" };
	return { available: true, providerBaseUrls, resolveSite: createSiteResolver(registry, providerBaseUrls) };
}

/** Fold `events` into a fresh store using `resolveSite`. */
async function indexedWith(store, id, events, resolveSite) {
	await sweep(fakePersistence(new Map([[id, { revision: id, events }]])), store, { resolveSite });
}

test("a route recorded under a site the directory no longer agrees with is stale", async () => {
	// The shape a real install reached: the fold is INCREMENTAL, so a session
	// first folded before the directory knew a route keeps those rows while its
	// later events attribute correctly. One route, two sites, 229k tokens of it
	// under "direct/official".
	await withStore(async (store) => {
		const directory = liveDirectory();
		const blind = createSiteResolver(new RelaySiteRegistry([]), {});
		await indexedWith(store, "s1", [header("ninerelay", "gpt"), message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 0 })], blind);

		const stale = staleAttributions(store, directory);
		assert.deepEqual(stale, [{ site: "unrouted", provider: "ninerelay", expected: "nine" }]);
	});
});

test("an index that agrees with the directory is not rebuilt", async () => {
	// Without this the check would rebuild on every sweep, which is a rebuild
	// loop wearing the costume of a fix.
	await withStore(async (store) => {
		const directory = liveDirectory();
		await indexedWith(store, "s1", [header("ninerelay", "gpt"), message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 0 })], directory.resolveSite);
		assert.deepEqual(staleAttributions(store, directory), []);
	});
});

test("a genuinely direct route is not mistaken for drift", async () => {
	await withStore(async (store) => {
		const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" }]);
		const providerBaseUrls = { ninerelay: "https://api.relay-one.example/v1", official: "https://api.deepseek.com" };
		const directory = { available: true, providerBaseUrls, resolveSite: createSiteResolver(registry, providerBaseUrls) };
		await indexedWith(store, "s1", [header("official", "v4"), message(1, 1, "official", "v4", { inputTokens: 10, outputTokens: 0 })], directory.resolveSite);
		assert.deepEqual(staleAttributions(store, directory), []);
	});
});

test("a directory that could not be read proves nothing about the index", async () => {
	// Discovery being down makes every route look unresolvable. Acting on that
	// would rebuild the whole index into a worse state than it started in.
	await withStore(async (store) => {
		const directory = liveDirectory();
		await indexedWith(store, "s1", [header("ninerelay", "gpt"), message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 0 })], directory.resolveSite);
		assert.deepEqual(staleAttributions(store, { ...directory, available: false }), []);
		assert.deepEqual(staleAttributions(store, undefined), []);
	});
});

test("rows with no route at all are left alone", async () => {
	// `provider = unknown` has nothing to resolve; it is already counted by the
	// unattributed diagnostic and must not drive a rebuild that cannot fix it.
	await withStore(async (store) => {
		await indexedWith(store, "s1", [message(1, 1, undefined, undefined, { inputTokens: 10, outputTokens: 0 })], liveDirectory().resolveSite);
		assert.deepEqual(staleAttributions(store, liveDirectory()), []);
	});
});

test("relay attribution flows through the sweep", async () => {
	await withStore(async (store) => {
		const registry = new RelaySiteRegistry([
			{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" }
		]);
		// Three routes, three different answers. `official` is configured and
		// points at no relay; `elsewhere` is not in the directory at all.
		const resolveSite = createSiteResolver(registry, {
			ninerelay: "https://api.relay-one.example/v1",
			official: "https://api.deepseek.com"
		});
		const sessions = new Map([
			[
				"s1",
				{
					revision: "r1",
					events: [
						header("ninerelay", "gpt"),
						message(1, 1, "ninerelay", "gpt", { inputTokens: 100, outputTokens: 10 }),
						message(2, 1, "official", "gpt", { inputTokens: 20, outputTokens: 2 }),
						message(3, 1, "elsewhere", "gpt", { inputTokens: 7, outputTokens: 1 })
					]
				}
			]
		]);
		await sweep(fakePersistence(sessions), store, { resolveSite });

		const sites = store.bySite();
		assert.deepEqual(
			sites.map((s) => [s.site, s.inputTokens]).sort(),
			[
				// Configured, points at the vendor. Genuinely direct.
				["direct", 20],
				["nine", 100],
				// NOT in the directory. We do not know where this went, and
				// saying "direct/official" would be inventing an answer — a real
				// install showed 88% of its tokens that way.
				["unrouted", 7]
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

// --- relay config normalization -------------------------------------------

test("one line per relay yields a site, a route map, and a resolver", async () => {
	const { sites, providerBaseUrls, resolveSite } = normalizeRelayConfig({
		relays: { ninerelay: "https://api.relay-one.example/v1" }
	});
	assert.equal(sites.length, 1);
	assert.equal(sites[0].id, "api.relay-one.example", "the id is the exact domain, which is what reports show");
	assert.equal(sites[0].type, undefined, "type is fingerprinted later, not typed by hand");
	assert.deepEqual(providerBaseUrls, { ninerelay: "https://api.relay-one.example/v1" });
	assert.equal(resolveSite("ninerelay"), "api.relay-one.example");
	assert.equal(resolveSite("something-else"), undefined);
});

test("two routes on one relay collapse to a single site", async () => {
	// A key per model group is normal; they share one invoice and must not
	// produce two rows for it.
	const { sites, resolveSite } = normalizeRelayConfig({
		relays: {
			gptroute: "https://api.relay-one.example/v1",
			clauderoute: "https://api.relay-one.example/v1"
		}
	});
	assert.equal(sites.length, 1);
	assert.equal(resolveSite("gptroute"), resolveSite("clauderoute"));
});

test("the long form overrides the derived id and type", async () => {
	const { sites, resolveSite } = normalizeRelayConfig({
		relays: {
			r: { baseUrl: "https://api.relay-two.example", id: "my-label", type: "sub2api" }
		}
	});
	assert.equal(sites[0].id, "my-label");
	assert.equal(sites[0].type, "sub2api");
	assert.equal(resolveSite("r"), "my-label");
});

test("no relays configured means no resolver, and everything is direct", async () => {
	const { sites, resolveSite } = normalizeRelayConfig({});
	assert.deepEqual(sites, []);
	assert.equal(resolveSite, undefined);

	await withStore(async (store) => {
		const sessions = new Map([
			["s1", { revision: "r1", events: [header("p", "m"), message(1, 1, "p", "m", { inputTokens: 5, outputTokens: 1 })] }]
		]);
		await sweep(fakePersistence(sessions), store, { resolveSite });
		assert.deepEqual(store.bySite().map((s) => s.site), ["direct"], "still a correct report, just no site dimension");
	});
});

test("a shipped provider default resolves as official even without a relay site", () => {
	const resolveSite = buildResolver({ directProviders: ["deepseek-official"] });
	assert.equal(resolveSite("deepseek-official"), DIRECT);
	assert.equal(resolveSite("removed-route"), undefined, "an absent route remains unknown");
});

test("a malformed relay entry is skipped rather than poisoning the map", async () => {
	const { sites, providerBaseUrls } = normalizeRelayConfig({
		relays: { good: "https://api.relay-one.example", bad: "", worse: null, alsoBad: {} }
	});
	assert.equal(sites.length, 1);
	assert.deepEqual(Object.keys(providerBaseUrls), ["good"]);
});
