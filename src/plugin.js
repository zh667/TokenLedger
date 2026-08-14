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

import { applyUsageDelta, dayKey } from "./usage.js";
import { RelaySiteRegistry, createSiteResolver } from "./relay-sites.js";
import { LedgerStore } from "./store.js";
import { RateTable, priceRows } from "./pricing.js";
import { reconcileSite } from "./reconcile.js";
import { renderReconciliation, renderReport } from "./report.js";

/** `YYYY-MM-DD` for N days before today, in local time. */
function dayKeyDaysAgo(daysBack) {
	return dayKey(Date.now() - daysBack * 86_400_000);
}

/**
 * Price the range with rates from configuration.
 *
 * Rates live in config rather than in code because a relay sets its own
 * prices; shipping a table would be shipping one site's deal as everyone's.
 */
function priceWithConfiguredRates(store, range, site, rates) {
	try {
		const table = new RateTable(rates);
		const day = range.to ?? range.from ?? dayKey(Date.now());
		return priceRows(store.byModel(range, site), table, day);
	} catch {
		// A malformed rate table costs the cost column, not the report.
		return null;
	}
}

export const name = "tokenledger";

/**
 * Only the persistence seam is required.
 *
 * `commands` is deliberately absent: Cordis's `inject` has no optional form —
 * it is a name list or a name→intercept map, and every entry is awaited — so
 * declaring it would leave a composition without a command runtime pending
 * forever. The optional-capability idiom in this codebase is `ctx.get(name)`,
 * which returns the service or undefined without registering a dependency.
 */
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
 * Reconcile every configured site that has a billing reader wired.
 *
 * A site with no reader is reported through `reconcileSite` with a null relay,
 * which already says "cannot compare". Omitting it, or inventing an agreeing
 * row, would both read as a clean bill of health it has not earned.
 */
async function collectReconciliations(store, config, range, siteFilter, logger) {
	const readers = config.billing ?? {};
	const out = [];
	for (const site of config.sites ?? []) {
		if (siteFilter !== undefined && site.id !== siteFilter) continue;
		const reader = readers[site.id];
		let relay = null;
		if (typeof reader === "function") {
			try {
				relay = await reader({ range });
			} catch (error) {
				logger?.warn?.("tokenledger: billing read for %s failed: %s", site.id, error?.message ?? error);
			}
		}
		out.push(
			reconcileSite({
				site: site.id,
				dsh: store.totals(range, site.id),
				relay,
				readerConfigured: typeof reader === "function",
				window: range.from === undefined ? undefined : { from: range.from, to: range.to },
				allTime: range.from === undefined
			})
		);
	}
	return out;
}

/**
 * The `/tokenledger` command body, separated from its Cordis shell so it can be
 * exercised against a real store without booting a harness.
 *
 * @param rawInput - text after the command name.
 * @param deps - `{ store, config, sweep?, reindex?, logger? }`.
 * @returns the report text.
 */
export async function runCommand(rawInput, deps) {
	const { store, config = {}, sweep: doSweep, reindex, logger } = deps;
	const args = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);

	if (args[0] === "reindex") {
		const stats = await reindex?.();
		return `已重建索引：扫描 ${stats?.scanned ?? 0}，更新 ${stats?.updated ?? 0}，失败 ${stats?.failed ?? 0}。`;
	}

	// A report must not show figures the last sweep could already have improved,
	// so a manual invocation sweeps first.
	await doSweep?.();

	const reconcileOnly = args[0] === "reconcile";
	const rest = reconcileOnly ? args.slice(1) : args;
	const days = Number.parseInt(rest[0] ?? "", 10);
	const site = rest.find((a) => !/^\d+$/.test(a));
	const range = Number.isFinite(days) && days > 0 ? { from: dayKeyDaysAgo(days - 1) } : {};

	const reconciliations = await collectReconciliations(store, config, range, site, logger);
	if (reconcileOnly) return renderReconciliation(reconciliations);

	const byId = {};
	for (const r of reconciliations) byId[r.site] = r;

	return renderReport({
		range,
		days: store.byDay(range, site),
		models: store.byModel(range, site),
		sites: store.bySite(range),
		reconciliations: byId,
		priced: config.rates === undefined ? null : priceWithConfiguredRates(store, range, site, config.rates),
		siteFilter: site
	});
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

	// `/tokenledger [days] [site]` — a report in the conversation stream. The
	// command is a shell over the same queries the future UI page will use, so
	// nothing here is throwaway when that page lands.
	const commands = typeof ctx.get === "function" ? ctx.get("commands") : undefined;
	if (commands !== undefined) {
		try {
			ctx.effect(function* () {
				yield commands.register({
					name: config.commandName ?? "tokenledger",
					description: "Token usage by model and relay site, with billing reconciliation",
					input: { hint: "[days] [site] | reconcile | reindex" },
					handler: async (invocation) => {
						try {
							return { kind: "success", text: await handleCommand(invocation.rawInput ?? "") };
						} catch (error) {
							return { kind: "error", text: `tokenledger: ${error?.message ?? error}` };
						}
					}
				});
			}, "tokenledger command");
		} catch (error) {
			logger?.warn?.("tokenledger: could not register the command: %s", error?.message ?? error);
		}
	}

	const handleCommand = (rawInput) =>
		runCommand(rawInput, { store, config, sweep: runSweep, reindex: api.reindex, logger });

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
