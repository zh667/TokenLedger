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
 * @module dsh-tokenledger/plugin
 */

import { applyUsageDelta, dayKey } from "./usage.js";
import { RelaySiteRegistry, SITE_TYPES, createSiteResolver, domainOf } from "./relay-sites.js";
import { discoverFromContext, mergeSites, withKnownSoftware } from "./discovery.js";
import { createBalanceReader, listAccounts } from "./balance.js";
import { registerRoutes } from "./http.js";
import { detectRelaySoftware } from "./adapters/detect.js";
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
 * Turn the `relays` config into sites and a route→origin map.
 *
 * One entry per relay, keyed by the DSH provider route it serves:
 *
 * ```yaml
 * relays:
 *   my-route: https://relay.example.com/v1
 * ```
 *
 * An earlier design asked for the same domain twice — once under `sites` and
 * once under `providerBaseUrls` — plus a hand-written `type`. That is three
 * chances to disagree with yourself and a silent drift every time a provider's
 * base URL changes in the composition but not here. The route is the only
 * thing the user actually knows that this code cannot; everything else is
 * derived.
 *
 * The site id defaults to the exact domain, which is what the reports are
 * supposed to show anyway. `type` is left undefined and filled in later by
 * fingerprinting; a longer object form exists for anyone who wants to override
 * either.
 *
 * @returns `{ sites, providerBaseUrls, resolveSite }`, with `resolveSite`
 *   undefined when nothing is configured — which attributes everything to
 *   `direct` and still produces a correct per-model report.
 */
export function normalizeRelayConfig(config = {}) {
	const entries = Object.entries(config.relays ?? {});
	if (entries.length === 0) return { sites: [], providerBaseUrls: {}, resolveSite: undefined };

	const sites = [];
	const providerBaseUrls = {};
	const seen = new Map();

	for (const [route, value] of entries) {
		const spec = typeof value === "string" ? { baseUrl: value } : (value ?? {});
		const baseUrl = spec.baseUrl;
		if (typeof baseUrl !== "string" || baseUrl === "") continue;
		providerBaseUrls[route] = baseUrl;

		const domain = domainOf(baseUrl);
		const id = spec.id ?? domain ?? route;
		// Two routes may point at one relay — a key per model group is common.
		// They must collapse to one site, not two rows for the same invoice, but
		// the site still lists every route that reaches it: a listing that showed
		// a hand-written site with no routes at all read as broken.
		const already = seen.get(id);
		if (already !== undefined) {
			already.routes.push(route);
			continue;
		}
		const record = {
			id,
			// `type` is not required up front: SITE_TYPES rejects undefined, so an
			// unfingerprinted site is registered as newapi-shaped only once
			// detection says so. Until then it exists purely for attribution.
			type: spec.type,
			baseUrl,
			displayName: spec.displayName,
			credentialReference: spec.credentialReference,
			routes: [route]
		};
		seen.set(id, record);
		sites.push(record);
	}

	return { sites, providerBaseUrls, resolveSite: buildResolver({ sites, providerBaseUrls }) };
}

/**
 * Build the route→site resolver for a set of sites.
 *
 * Attribution needs only the origin match, so a site whose software is not yet
 * known is still usable: `SITE_TYPES` rejects `undefined`, so an unfingerprinted
 * site is registered under a placeholder type it will overwrite once detection
 * answers. The type decides which billing adapter could later be offered; it
 * never decides where a token is counted.
 *
 * @returns the resolver, or undefined when there are no sites — which
 *   attributes everything to `direct` and still produces a correct per-model
 *   report.
 */
export function buildResolver({ sites = [], providerBaseUrls = {} } = {}) {
	if (sites.length === 0) return undefined;
	const registry = new RelaySiteRegistry(sites.map((s) => ({ ...s, type: s.type ?? SITE_TYPES[0] })));
	return createSiteResolver(registry, providerBaseUrls);
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
async function collectReconciliations(store, config, range, siteFilter, logger, knownSites) {
	const readers = config.billing ?? {};
	const configuredSites = knownSites ?? config.sites ?? normalizeRelayConfig(config).sites;
	const out = [];
	for (const site of configuredSites) {
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
 * `/tokenledger site [list|add|rm]` — see and correct the relay set without
 * opening a file.
 *
 * Normally there is nothing to do here: sites come from the host's own provider
 * configuration. This exists for the two cases discovery cannot cover — a
 * composition with no settings provider, and a provider mounted by an agent
 * preset — and for correcting a bad guess.
 *
 * `add` takes the DSH provider route as well as the URL, because the route is
 * what attribution matches on and is the one thing this code cannot derive. The
 * listing prints the routes it already knows so that argument can be copied
 * rather than looked up.
 *
 * @param args - arguments after `site`.
 * @param deps - `{ config, sites, saveRelays }`.
 * @returns the text to show.
 */
/**
 * Say which kind of "not identified" this is.
 *
 * A site still being probed, one whose probe could not be made, and one that
 * genuinely matches no known relay program are three different situations with
 * three different responses — wait, check the network, or accept it. Printing
 * one word for all three sent the only person who could tell them apart to the
 * DSH log.
 */
export function describeProbe(site, probe) {
	if (site?.type !== undefined) return site.type;
	switch (probe?.state) {
		case "pending":
			return "探测中…";
		case "failed":
			return `探测失败：${probe.reason}`;
		case "unrecognized":
			return `未识别${probe.reason === undefined ? "" : `：${probe.reason}`}`;
		default:
			// Nothing asked, so there is nothing to say. An earlier version printed
			// a placeholder here, which read as a failure on every site of every
			// install that had simply never opted into fingerprinting.
			return undefined;
	}
}

async function runSiteCommand(args, deps) {
	const { config = {}, sites, saveRelays, removeRelay, saveUnavailableBecause, refresh, settle, probeStatus } = deps;
	const [action, ...rest] = args;
	const manual = config.relays ?? {};

	if (action === undefined || action === "list") {
		// Ask the host now rather than reporting whatever the last background
		// sweep happened to leave. The sweep that runs at startup can precede the
		// settings service by which relays are discovered, so a listing taken from
		// its result says "no relays" for up to a whole interval — on an install
		// whose own report, drawn from the rollups, is showing those relays.
		refresh?.();
		await settle?.();
		const known = sites?.() ?? [];
		const probes = probeStatus?.() ?? new Map();
		if (known.length === 0) {
			return [
				"没有发现任何中转站。",
				"",
				"如果你直连官方，这是对的——用量统计照常按模型和路由分。",
				"如果你确实在用中转站而这里是空的，说明宿主的 provider 配置读不到，",
				"用 `/tokenledger site add <路由名> <地址>` 手动补一条。"
			].join("\n");
		}
		const lines = known.map((s) => {
			const how = s.discovered === false ? "手动" : "自动发现";
			const routes = (s.routes ?? []).join(", ") || "—";
			// The software is shown only when something actually determined it.
			// Printing a placeholder for every site turned a column nothing needs
			// into the most prominent thing on the line.
			const probe = describeProbe(s, probes.get(s.id));
			const badge = probe === undefined ? how : `${how} · ${probe}`;
			return `  ${s.id}  〔${badge}〕  路由：${routes}`;
		});
		return [`中转站（${known.length}）：`, ...lines, "", "改：`/tokenledger site add <路由名> <地址>` 或 `site rm <路由名>`"].join("\n");
	}

	if (saveRelays === undefined) {
		// Two very different causes, and naming the wrong one sends the reader to
		// the wrong file. A registration that failed says why; only a genuinely
		// absent service gets blamed for being absent.
		return saveUnavailableBecause === undefined
			? "settings 服务还没就绪，配置存不了。稍等一下重试；如果一直这样，就直接编辑 cordis.patch.yml 里的 `relays`。"
			: `settings 命名空间没注册上（${saveUnavailableBecause}），配置存不了。请直接编辑 cordis.patch.yml 里的 \`relays\`。`;
	}

	if (action === "add") {
		const [route, url] = rest;
		if (route === undefined || url === undefined) {
			return "用法：`/tokenledger site add <路由名> <地址>`，例如 `site add myrelay https://relay.example.com/v1`。";
		}
		if (domainOf(url) === undefined) {
			return `\`${url}\` 不是一个可用的 http(s) 地址。`;
		}
		await saveRelays({ ...manual, [route]: url });
		return `已记下：路由 \`${route}\` → ${domainOf(url)}。下一次统计会把它算进去。`;
	}

	if (action === "rm") {
		const [route] = rest;
		if (route === undefined) return "用法：`/tokenledger site rm <路由名>`。";
		if (!(route in manual)) {
			return `\`${route}\` 不在手动配置里。自动发现的站点删不掉——它来自 DSH 的 provider 配置，改那里。`;
		}
		if (removeRelay === undefined) {
			return "这个 settings 服务不支持删除单个键。请直接编辑 settings.yaml 里的 `tokenledger.relays`。";
		}
		// Deliberately not `saveRelays` with the key left out: that path
		// deep-merges, so an omitted key is not a deletion. It reported success
		// while the entry stayed in the listing.
		await removeRelay(route);
		return `已删除手动配置的路由 \`${route}\`。`;
	}

	return "用法：`/tokenledger site [list|add|rm]`。";
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
	const { store, config = {}, sweep: doSweep, reindex, logger, sites, saveRelays, saveUnavailableBecause } = deps;
	const args = String(rawInput ?? "").trim().split(/\s+/).filter(Boolean);

	if (args[0] === "site") {
		return runSiteCommand(args.slice(1), {
			config,
			sites,
			saveRelays,
			removeRelay: deps.removeRelay,
			saveUnavailableBecause,
			refresh: deps.refresh,
			settle: deps.settle,
			probeStatus: deps.probeStatus
		});
	}

	// `diagnostics` and `export` existed on the store, and were advertised as
	// shipped, but no command reached them — the same overclaim as reconciliation,
	// found while listing what a user can actually type.
	if (args[0] === "diagnostics" || args[0] === "doctor") {
		const d = store.diagnostics();
		return [
			"── 索引诊断 ──",
			`  schema 版本      ${d.schemaVersion}`,
			`  汇总行数         ${d.rollupRows}`,
			`  有用量的会话     ${d.sessionsWithUsage}`,
			`  已跟踪的会话     ${d.sessionsTracked}`,
			`  覆盖区间         ${d.firstDay ?? "—"} → ${d.lastDay ?? "—"}`,
			`  最后更新         ${d.lastUpdatedAt === undefined ? "—" : new Date(d.lastUpdatedAt).toLocaleString()}`,
			// Worth its own line: rows that could not be attributed are the one
			// number that says the fold is missing something, rather than that
			// there was nothing to find.
			`  归因不上的行     ${d.unattributedRows}${d.unattributedRows > 0 ? "  ← 这些行的 provider 或 model 是 unknown" : ""}`
		].join("\n");
	}

	if (args[0] === "export") {
		const format = args[1] === "csv" ? "csv" : "json";
		const rest = args.slice(args[1] === "csv" || args[1] === "json" ? 2 : 1);
		const days = Number.parseInt(rest[0] ?? "", 10);
		const site = rest.find((a) => !/^\d+$/.test(a));
		const range = Number.isFinite(days) && days > 0 ? { from: dayKeyDaysAgo(days - 1) } : {};
		await doSweep?.();
		return format === "csv"
			? store.exportCsv(range, site)
			: JSON.stringify(store.exportJson(range, site), null, 1);
	}

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

	// A word this command does not recognise used to become a site filter, so a
	// typo — or a subcommand from a newer version than the one installed —
	// produced a confident, empty report about a site that does not exist.
	// Checked against all time rather than the range: a real site with no traffic
	// this week is an empty range, which already has its own honest message.
	if (site !== undefined && !store.bySite({}).some((row) => row.site === site)) {
		const known = store.bySite({}).map((row) => row.site);
		return [
			`不认识 \`${site}\`——它既不是子命令，也不是有记录的中转站。`,
			"",
			known.length > 0 ? `有记录的中转站：${known.join("、")}` : "目前还没有任何中转站的记录。",
			"",
			"可用子命令：site / export / diagnostics / reindex / reconcile",
			"（如果你刚看到某个子命令不存在，多半是插件还没更新到那个版本。）"
		].join("\n");
	}

	// Only reconcile when a billing reader actually exists, or when explicitly
	// asked. Sites used to be hand-configured, so a site with no reader was a
	// half-finished setup worth flagging. Now that they are discovered, that
	// same warning fires on every relay of every install — a ⚠ on a feature
	// nobody opted into, telling users something is wrong when nothing is.
	const wantReconcile = reconcileOnly || Object.keys(config.billing ?? {}).length > 0;
	const reconciliations = wantReconcile
		? await collectReconciliations(store, config, range, site, logger, sites?.())
		: [];
	if (reconcileOnly) return renderReconciliation(reconciliations);

	const byId = {};
	for (const r of reconciliations) byId[r.site] = r;

	return renderReport({
		range,
		days: store.byDay(range, site),
		models: store.byModel(range, site),
		sites: store.bySite(range),
		providers: store.byProvider(range, site),
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

	// --- the site directory -------------------------------------------------
	//
	// Sites are learned from the host, not configured: see `discovery.js`. The
	// set is therefore not fixed at mount time — a user can add a relay to DSH's
	// provider settings while this plugin is running — so the directory is
	// rebuilt at the head of every sweep rather than captured once.
	//
	// Rebuilding is two in-memory reads and no I/O, which is why it can afford to
	// run on the sweep timer instead of subscribing to a change event. It also
	// inherits the property that makes sweeping the right shape for this whole
	// plugin: it is idempotent and self-healing, so a missed notification costs
	// one interval rather than a permanently stale answer.
	let directory = { sites: [], providerBaseUrls: {}, resolveSite: undefined };
	let directoryKnown = false;
	// Keyed by site id and OUTSIDE the directory, because the directory's site
	// objects are rebuilt from scratch on every sweep. An earlier version wrote
	// the detected type onto the site object itself, so the answer survived until
	// the next rebuild and every site then read "未识别" forever — while the
	// `fingerprinted` guard made sure it was never asked again.
	const softwareOf = new Map();
	const asked = new Set();
	// What happened when we asked. Without this, every unresolved case collapses
	// into the same "unidentified" — a site still being probed, one whose probe
	// failed, and one that genuinely matches no known relay program all look
	// alike, and the only way to tell them apart is reading the DSH log.
	const probes = new Map();
	const inFlight = new Set();

	/** Distinct origins, order-independent — the only change that alters attribution. */
	const originKey = (d) => [...new Set(Object.values(d.providerBaseUrls ?? {}))].sort().join(" ");

	/**
	 * Fingerprint a relay once, in the background. It costs a few unauthenticated
	 * GETs and saves the user from looking up a `type`. A failure leaves the type
	 * unknown, which only affects which billing adapter could later be offered —
	 * never attribution.
	 */
	// Injectable so `apply` can be exercised without reaching the network. Both
	// bugs a real install found — a sampled service and a discarded fingerprint —
	// were in this wiring, which had no test at all because it could not be run.
	const detect = config.detect ?? detectRelaySoftware;

	const fingerprint = (site) => {
		// Off unless asked for. Knowing whether a relay runs New API or Sub2API
		// only decides which billing adapter could be offered, and billing is
		// deferred — so by default this would be six unauthenticated requests to
		// a third party, on every relay, to fill in a column nothing reads.
		if (config.fingerprint !== true) return;
		if (site.type !== undefined || asked.has(site.id)) return;
		asked.add(site.id);
		probes.set(site.id, { state: "pending" });
		const settled = detect(site.baseUrl).then(
			(result) => {
				if (result.billingAvailable) {
					softwareOf.set(site.id, result.software);
					// Patch the live directory too. Recording only into the map leaves
					// the answer invisible until the next sweep rebuilds — up to a
					// whole interval of a site reading "unidentified" after detection
					// has already succeeded.
					directory = { ...directory, sites: withKnownSoftware(directory.sites, softwareOf) };
					probes.set(site.id, { state: "identified", confidence: result.confidence });
				} else {
					probes.set(site.id, {
						state: "unrecognized",
						reason: result.ambiguous === undefined ? result.reason : `多个程序同样匹配：${result.ambiguous.join("、")}`
					});
				}
				logger?.info?.("tokenledger: %s looks like %s (confidence %s)", site.id, result.software, result.confidence);
			},
			(error) => {
				// A probe that could not be made is a different fact from one that
				// came back inconclusive, and only one of them is worth retrying.
				probes.set(site.id, { state: "failed", reason: error?.message ?? String(error) });
				logger?.warn?.("tokenledger: could not fingerprint %s: %s", site.id, error?.message ?? error);
			}
		);
		inFlight.add(settled);
		void settled.finally(() => inFlight.delete(settled));
	};

	/**
	 * Wait for probes started just now, but never for long.
	 *
	 * `/tokenledger site` refreshes and then renders synchronously, so on the
	 * first run after a restart every site read "unidentified" — not because
	 * detection had failed but because it had not finished. A short wait turns
	 * that into a real answer; a bounded one keeps an unreachable relay from
	 * holding the command open.
	 */
	const settleProbes = (ms = 2500) =>
		inFlight.size === 0
			? Promise.resolve()
			: Promise.race([
					Promise.allSettled([...inFlight]),
					new Promise((resolve) => setTimeout(resolve, ms).unref?.())
				]);

	/**
	 * @returns whether the origin set moved, which means already-folded history
	 *   was attributed under the old set and has to be rebuilt.
	 */
	const refreshDirectory = () => {
		let discovered;
		try {
			discovered = discoverFromContext(ctx, { officialOrigins: config.officialOrigins });
		} catch (error) {
			// A host that cannot be asked leaves the manual config in charge.
			logger?.warn?.("tokenledger: could not read the provider directory: %s", error?.message ?? error);
			discovered = { sites: [], providerBaseUrls: {}, skipped: 0, available: false };
		}
		const merged = mergeSites(discovered, normalizeRelayConfig(config));
		merged.sites = withKnownSoftware(merged.sites, softwareOf);
		const next = { ...merged, resolveSite: buildResolver(merged) };
		const moved = directoryKnown && originKey(next) !== originKey(directory);

		if (!directoryKnown && discovered.available && merged.sites.length > 0) {
			logger?.info?.(
				"tokenledger: found %d relay site(s) in the host's provider configuration: %s",
				merged.sites.length,
				merged.sites.map((s) => s.id).join(", ")
			);
		}
		directory = next;
		directoryKnown = true;
		for (const site of next.sites) fingerprint(site);
		return moved;
	};

	let running = false;
	// When the logs were last LOOKED AT, which is a different fact from when
	// they last changed. The checkpoint table only advances on a session that
	// moved, so a quiet hour leaves `MAX(updatedAt)` an hour behind while the
	// figures are perfectly current — reported as freshness that reads as a
	// stuck panel.
	let lastSweepAt;

	const runSweep = async () => {
		// A slow sweep must not overlap itself and double the read load.
		if (running) return undefined;
		running = true;
		try {
			// Attribution is resolved at fold time and history is never rewritten,
			// so a newly discovered relay does not retroactively claim the traffic
			// it already served. Discarding the index is the only honest response:
			// the alternative is a report that shows a site starting from the
			// moment it was noticed, which reads as "you just started using this"
			// rather than "this was only just recognised".
			if (refreshDirectory()) {
				logger?.info?.("tokenledger: the relay set changed; rebuilding the index so past traffic is attributed too");
				store.reset();
			}
			const stats = await sweep(ctx.sessionPersistence, store, {
				resolveSite: directory.resolveSite,
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
			lastSweepAt = Date.now();
			return stats;
		} catch (error) {
			logger?.warn?.("tokenledger: sweep failed: %s", error?.message ?? error);
			return undefined;
		} finally {
			running = false;
		}
	};

	// --- durable configuration ----------------------------------------------
	//
	// Registering the namespace puts this plugin's settings in the file the user
	// already edits and makes an edit live without a restart. It is also what
	// makes `/tokenledger site add` able to persist anything: `update()` only
	// works on a registered namespace.
	//
	// It is the one thing here that needs a dependency, so it is loaded
	// dynamically and its absence costs exactly itself.
	let settingsScope;
	let settingsRemove;
	let settingsFailure;

	// `settings` is WAITED FOR, not sampled.
	//
	// An earlier version read `ctx.get('settings')` once inside `apply` and
	// cached the answer. On a real install that answer was `undefined` — the
	// service mounts after this plugin — while the same call from inside a sweep,
	// which happens later, returned it fine. The result was a plugin that could
	// discover relays through the settings service and simultaneously report that
	// there was no settings service.
	//
	// `ctx.inject` runs a child fiber that waits for the service and is re-run
	// whenever it changes, so the timing stops mattering. It is deliberately not
	// in this plugin's own `inject`: that would make collecting usage wait for a
	// service a composition need not have at all.
	if (typeof ctx.inject === "function") {
		ctx.inject(["settings"], (scoped) => {
			let live = true;
			scoped.on?.("dispose", () => {
				live = false;
				settingsScope = undefined;
			});
			void import("./settings-schema.js")
				.then(({ registerNamespace }) =>
					live
						? registerNamespace(scoped.settings, userConfig, (next) => {
								// A resolved value replaces the entry config wholesale;
								// the directory picks the change up on the next sweep.
								Object.assign(config, next);
							})
						: undefined
				)
				.then((registered) => {
					if (!live || registered === undefined) return;
					settingsScope = registered.scope;
					settingsRemove = registered.remove;
					settingsFailure = undefined;
					// Relay discovery reads provider profiles THROUGH this service, so
					// the sweep that ran at startup — before the service existed — found
					// nothing. Re-discover now instead of leaving the directory empty
					// until the next timer tick.
					refreshDirectory();
					logger?.info?.("tokenledger: settings namespace registered; configuration can be saved");
				})
				.catch((error) => {
					// Distinguished from "no settings service" because the fixes are
					// different, and a message that names the wrong one sends whoever
					// reads it to the wrong place.
					settingsFailure = error?.message ?? String(error);
					logger?.warn?.(
						"tokenledger: could not register the settings namespace (%s); using entry config only",
						settingsFailure
					);
				});
		});
	} else {
		settingsFailure = "这个 Cordis 没有 ctx.inject";
	}

	const api = {
		store,
		sweep: runSweep,
		totals: (range, site) => store.totals(range, site),
		byDay: (range, site) => store.byDay(range, site),
		byModel: (range, site) => store.byModel(range, site),
		bySite: (range) => store.bySite(range),
		sites: () => directory.sites.map((s) => ({ ...s })),
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
					description: "Token usage by model and relay site",
					input: { hint: "[days] [site] | site | export [csv] | diagnostics | reindex" },
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
		runCommand(rawInput, {
			store,
			config,
			sweep: runSweep,
			reindex: api.reindex,
			logger,
			sites: () => directory.sites,
			refresh: () => void refreshDirectory(),
			settle: settleProbes,
			probeStatus: () => new Map(probes),
			// Present only once the namespace registered; `runCommand` says so
			// rather than failing, because the report half still works without it.
			saveRelays:
				settingsScope === undefined
					? undefined
					: async (relays) => {
							await settingsScope.update({ relays });
							refreshDirectory();
						},
			removeRelay:
				settingsRemove === undefined
					? undefined
					: async (route) => {
							await settingsRemove(route);
							refreshDirectory();
						},
			saveUnavailableBecause: settingsFailure
		});

	// The read-only surface the browser panel reads. Registering it is optional
	// in both directions: a composition with no web server keeps collecting, and
	// a deployment that never opens the panel pays only for the registration.
	try {
		const served = registerRoutes(ctx, {
			store,
			sites: () => directory.sites,
			sweep: runSweep,
			priced: (range, site) =>
				config.rates === undefined ? null : priceWithConfiguredRates(store, range, site, config.rates),
			accounts: () => listAccounts(ctx, { softwareOf }),
			lastSweepAt: () => lastSweepAt,
			balance: createBalanceReader(ctx, {
				softwareOf,
				// A lazily detected relay program is remembered, so the probe
				// happens once per site rather than once per balance read.
				learnSoftware: (host, software) => softwareOf.set(host, software),
				detect
			}),
			logger
		});
		if (!served) logger?.info?.("tokenledger: no web server in this composition; the panel will not be served");
	} catch (error) {
		logger?.warn?.("tokenledger: could not register the HTTP routes: %s", error?.message ?? error);
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
