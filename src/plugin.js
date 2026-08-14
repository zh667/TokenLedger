/**
 * TokenLedger as a DeepSeek Harness plugin.
 *
 * Mounts on the `sessionPersistence` seam, sweeps every session's durable log
 * from wherever it last stopped, and maintains the rollup index. It reads;
 * it never writes to a session, never touches DSH's own SQLite projection, and
 * never sits in the request path.
 *
 * ## Failure is always the collector's problem, never DSH's
 *
 * Every sweep is wrapped. A corrupt log, a locked database, a schema surprise
 * from an upstream rc bump — all of it degrades to a counted error and a
 * skipped session. Accounting is worth having; it is not worth a turn failing
 * over. `ctx.logger` records what went wrong and the agent keeps working.
 *
 * ## Why it sweeps rather than subscribing
 *
 * `sessionPersistence.listSnapshots()` returns an opaque per-log revision that
 * changes on append, so a sweep can skip every unchanged session without
 * parsing it, and `readFrom(id, seq)` reads only the tail. Subscribing to live
 * events instead would put this code on the hot path and lose everything
 * written while the plugin was not running — a restart would silently under-
 * count. Sweeping is idempotent and self-healing; subscribing is neither.
 *
 * @module tokenledger/plugin
 */

import { applyUsageDelta } from "./usage.js";
import { RelaySiteRegistry, createSiteResolver } from "./relay-sites.js";
import { LedgerStore } from "./store.js";

export const name = "tokenledger";

export const inject = ["sessionPersistence"];

/** Defaults chosen so an unconfigured mount still does something useful. */
const DEFAULTS = {
	database: "tokenledger.sqlite",
	sweepIntervalMs: 60_000,
	sweepOnStart: true
};

/**
 * Build the site resolver from configuration.
 *
 * `providerBaseUrls` normally mirrors the `dsh-llm-pi-ai` row's
 * `config.providers[route].baseURL`. It is passed in rather than read out of
 * the live composition so the collector keeps working when the model route is
 * supplied by some other adapter.
 */
function buildResolver(config) {
	const sites = config.sites ?? [];
	if (sites.length === 0) return undefined;
	const registry = new RelaySiteRegistry(sites);
	return createSiteResolver(registry, config.providerBaseUrls ?? {});
}

/**
 * Sweep every session once.
 *
 * @returns `{ scanned, updated, skipped, failed, events }` — counts only. No
 *   prompt, tool argument, credential, or response content is read or logged.
 */
export async function sweep(persistence, store, options = {}) {
	const resolveSite = options.resolveSite;
	const logger = options.logger;
	const stats = { scanned: 0, updated: 0, skipped: 0, failed: 0, events: 0 };

	let snapshots;
	try {
		snapshots = await persistence.listSnapshots();
	} catch (error) {
		logger?.warn?.("tokenledger: could not list sessions: %s", error?.message ?? error);
		stats.failed++;
		return stats;
	}

	for (const snapshot of snapshots ?? []) {
		stats.scanned++;
		// The id lives at `snapshot.header.id`; a SessionPersistenceSnapshot is
		// `{ header, revision }`. Reading `snapshot.id` finds nothing, and an
		// earlier version of this loop then skipped every session in silence —
		// which is why an unusable snapshot is now counted and logged instead of
		// quietly dropped.
		const sessionId = snapshot.header?.id ?? snapshot.id ?? snapshot.sessionId;
		if (sessionId === undefined) {
			stats.failed++;
			logger?.warn?.("tokenledger: snapshot carries no session id; keys were %s", Object.keys(snapshot).join(","));
			continue;
		}

		try {
			const checkpoint = store.checkpointFor(sessionId);
			const revision = snapshot.revision === undefined ? undefined : String(snapshot.revision);

			// An unchanged log needs no read at all. This is what keeps a sweep
			// cheap enough to run on a timer.
			if (checkpoint !== undefined && revision !== undefined && checkpoint.logRevision === revision) {
				stats.skipped++;
				continue;
			}

			const state = store.loadState(sessionId);
			const { events } = await persistence.readFrom(sessionId, state.consumedSeq + 1);
			if ((events?.length ?? 0) === 0) {
				stats.skipped++;
				continue;
			}

			applyUsageDelta(state, events, { resolveSite });
			store.commitSession(sessionId, state, {
				logRevision: revision,
				dshVersion: options.dshVersion
			});
			stats.updated++;
			stats.events += events.length;
		} catch (error) {
			// One bad session must not stop the rest, and must never reach DSH.
			stats.failed++;
			logger?.warn?.("tokenledger: session %s failed: %s", sessionId, error?.message ?? error);
		}
	}

	return stats;
}

/**
 * Cordis plugin entry.
 *
 * Publishes `ctx.tokenLedger` so a UI row or a tool can read the index without
 * reopening the database, and disposes both the timer and the store with the
 * fiber.
 */
export function apply(ctx, userConfig = {}) {
	const config = { ...DEFAULTS, ...userConfig };
	const logger = ctx.logger?.("tokenledger") ?? ctx.logger;

	let store;
	try {
		store = LedgerStore.open(config.database);
	} catch (error) {
		// Without a store there is nothing to collect, but DSH must still boot.
		logger?.error?.("tokenledger: could not open %s: %s", config.database, error?.message ?? error);
		return;
	}

	const resolveSite = buildResolver(config);
	let running = false;

	const runSweep = async () => {
		// A slow sweep must not overlap itself and double the read load.
		if (running) return undefined;
		running = true;
		try {
			const stats = await sweep(ctx.sessionPersistence, store, {
				resolveSite,
				logger,
				dshVersion: config.dshVersion
			});
			if (stats.updated > 0 || stats.failed > 0) {
				logger?.info?.(
					"tokenledger: swept %d, updated %d, skipped %d, failed %d",
					stats.scanned,
					stats.updated,
					stats.skipped,
					stats.failed
				);
			}
			return stats;
		} catch (error) {
			logger?.warn?.("tokenledger: sweep failed: %s", error?.message ?? error);
			return undefined;
		} finally {
			running = false;
		}
	};

	const api = {
		store,
		sweep: runSweep,
		totals: (range, site) => store.totals(range, site),
		byDay: (range, site) => store.byDay(range, site),
		byModel: (range, site) => store.byModel(range, site),
		bySite: (range) => store.bySite(range),
		diagnostics: () => store.diagnostics(),
		/** Discard the index; the next sweep rebuilds it from seq 0. */
		reindex: async () => {
			store.reset();
			return runSweep();
		}
	};

	// Cordis refuses a bare assignment to an undeclared service ("cannot set
	// property without provide"). Publishing is a convenience for a UI row or a
	// tool, not a prerequisite for collecting, so an upstream rc that moves this
	// API costs the service and nothing else.
	try {
		if (typeof ctx.reflect?.provide === "function") {
			ctx.reflect.provide("tokenLedger", api);
		} else {
			logger?.warn?.("tokenledger: no reflect.provide on this Cordis; collecting without publishing a service");
		}
	} catch (error) {
		logger?.warn?.("tokenledger: could not publish the service: %s", error?.message ?? error);
	}

	if (config.sweepOnStart) void runSweep();

	const timer =
		config.sweepIntervalMs > 0 ? setInterval(() => void runSweep(), config.sweepIntervalMs) : undefined;
	timer?.unref?.();

	ctx.on("dispose", () => {
		if (timer !== undefined) clearInterval(timer);
		try {
			store.close();
		} catch {
			// A close failure at shutdown is not worth failing shutdown over.
		}
	});
}

export default { name, inject, apply };
