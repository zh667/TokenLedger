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
 * ## Where the host contract is written down
 *
 * `docs/HOST-CONTRACT.md` holds the facts this plugin has got wrong at least
 * once — service names per host version, why `inject` must be an array, why the
 * browser half loading proves nothing about this half, and the order to check
 * things in when the panel 404s. Read it before changing anything that talks to
 * a host service.
 *
 * @module dsh-tokenledger/plugin
 */

import { DIRECT, UNKNOWN, UNROUTED, applyUsageDelta, dayKey } from "./usage.js";
import { RelaySiteRegistry, SITE_TYPES, createSiteResolver, domainOf } from "./relay-sites.js";
import { createFingerprintRegistry } from "./fingerprints.js";
import { describeProject, readProjectTitles, workspaceRegistry } from "./projects.js";
import { discoverFromContext, mergeSites, withKnownSoftware } from "./discovery.js";
import { createBalanceReader, listAccounts } from "./balance.js";
import { VERSION, registerRoutes } from "./http.js";
import { LedgerStore } from "./store.js";
import { RateTable, priceRows } from "./pricing.js";
import { num, renderReport, table } from "./report.js";

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
/**
 * Services this plugin cannot start without.
 *
 * **An array, never an object.** Cordis reads an object `inject` as a
 * `name -> intercept config` map, not as `{ required, optional }` — every key
 * becomes a REQUIRED service name. Declaring the latter asked for two services
 * called `required` and `optional`, neither of which exists, so the plugin sat
 * pending forever and DSH's activation assertion took the whole host down with
 * it. `dsh web` did not start.
 *
 * This version of Cordis has no notion of an optional dependency at all:
 * `Inject.resolve` puts every declared name in one table with no strength
 * attached. Something a plugin can work without is therefore NOT declared here
 * — it is read with `ctx.get(name)`, which returns `undefined` when the service
 * is absent rather than throwing. `workspace` is read that way, per sweep, so a
 * service that mounts later is picked up on its own.
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
 * answers. The type decides which balance scheme reads that site; it never
 * decides where a token is counted.
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
				dshVersion: options.dshVersion,
				// The directory the session ran in. Immutable — DSH stamps the
				// header once at creation — so re-folding a session can only ever
				// write the same value back.
				project: snapshot.header?.cwd
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
	// Workspace titles, resolved on the sweep because the lookup is async. Absent
	// in a composition with no workspace service, and then every project row is
	// named by its directory — which is the fallback, not a degraded state.
	const projectTitles = deps.projectTitles?.() ?? new Map();
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
	// shipped, but no command reached them — an overclaim found while listing
	// what a user can actually type. Reconciliation was the mirror of it: a
	// command nobody could see, for a feature the product had dropped.
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
			`  归因不上的行     ${d.unattributedRows}${d.unattributedRows > 0 ? "  ← 这些行的 provider 或 model 是 unknown" : ""}`,
			"",
			...routeAttributionReport(store, deps.directory?.())
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

	const rest = args;
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
			"可用子命令：site / export / diagnostics / reindex",
			"（如果你刚看到某个子命令不存在，多半是插件还没更新到那个版本。）"
		].join("\n");
	}

	return renderReport({
		range,
		days: store.byDay(range, site),
		models: store.byModel(range, site),
		sites: store.bySite(range),
		providers: store.byProvider(range, site),
		projects: store.byProject(range, site).map((row) => describeProject(row.project, projectTitles.get(row.project))),
		priced: config.rates === undefined ? null : priceWithConfiguredRates(store, range, site, config.rates),
		siteFilter: site
	});
}

/**
 * Rows whose recorded site is not what the directory would say today.
 *
 * The fold is INCREMENTAL — `readFrom(id, consumedSeq + 1)` appends only new
 * events — so a session first folded when the directory did not know a route
 * keeps those old rows forever while its later events attribute correctly. A
 * real install ended up with one route under two different sites, 229k tokens
 * of it labelled "direct/official".
 *
 * The old trigger compared the set of ORIGINS and rebuilt when it changed. That
 * catches a relay being added or removed and misses this entirely: once the set
 * settles, stale rows are never revisited no matter how plainly they disagree.
 * So the disagreement itself is what gets checked.
 *
 * @param store - the ledger.
 * @param directory - the live directory; its `resolveSite` is the authority.
 * @returns `[{ site, provider, expected }]`, empty when the index agrees.
 */
export function staleAttributions(store, directory) {
	// Discovery being down makes every route look unresolvable, which would
	// "prove" the whole index stale and rebuild it into a worse state.
	if (directory?.available !== true) return [];
	const out = [];
	for (const row of store.distinctRoutes()) {
		if (row.provider === UNKNOWN) continue; // no route to resolve; DIRECT by rule
		const expected = directory.resolveSite?.(row.provider) ?? UNROUTED;
		if (expected !== row.site) out.push({ site: row.site, provider: row.provider, expected });
	}
	return out;
}

/**
 * The two tables that answer "why is my relay not showing".
 *
 * Neither number was reachable before. Working out where a site's traffic had
 * gone meant reasoning about the resolver from the outside, three rounds of it,
 * while the answer sat in the index the whole time: **the rollup row keys on
 * the route name**, so which routes landed in which bucket has always been
 * recorded and simply never displayed.
 *
 * @param store - the ledger.
 * @param directory - the live relay directory, or undefined if not wired.
 */
function routeAttributionReport(store, directory) {
	const out = ["── 路由归属（当前配置）──"];
	const baseUrls = directory?.providerBaseUrls ?? {};
	const routes = Object.keys(baseUrls).sort();

	if (routes.length === 0) {
		out.push("  自动发现没有看到任何带 baseURL 的 provider 路由。");
		out.push("  这本身可能是对的（只用官方直连），也可能是 settings 服务缺席或 provider 由 agent preset 挂载。");
	} else {
		const rows = routes.map((route) => {
			const site = directory?.resolveSite?.(route);
			const where = site === undefined ? "未知路由" : site === DIRECT ? "直连/官方（不指向中转站）" : site;
			return [route, String(baseUrls[route]), where];
		});
		out.push(...table([{ title: "路由" }, { title: "baseURL" }, { title: "归到" }], rows).map((l) => `  ${l}`));
	}

	// What the index actually holds, which is the half that says whether the
	// CURRENT configuration ever applied to the traffic already recorded.
	const byRoute = new Map();
	for (const row of store.byRoute()) {
		const key = `${row.site} ${row.provider}`;
		byRoute.set(key, (byRoute.get(key) ?? 0) + (row.tokens ?? 0));
	}
	out.push("", "── 索引里的路由（历史流量实际记在哪）──");
	if (byRoute.size === 0) {
		out.push("  索引里还没有任何用量。");
		return out;
	}
	const indexed = [...byRoute]
		.sort((a, b) => b[1] - a[1])
		.map(([key, tokens]) => {
			const [site, ...rest] = key.split(" ");
			const label = site === DIRECT ? "直连/官方" : site === UNROUTED ? "未知路由" : site;
			return [label, rest.join(" "), num(tokens)];
		});
	out.push(
		...table([{ title: "站点" }, { title: "路由" }, { title: "tokens", align: "right" }], indexed).map((l) => `  ${l}`)
	);
	// The line that turns a puzzling breakdown into an actionable one.
	const stranded = [...byRoute.keys()].filter((k) => k.startsWith(`${DIRECT} `) || k.startsWith(`${UNROUTED} `));
	if (stranded.length > 0) {
		out.push("");
		out.push("  上面记在「直连/官方」或「未知路由」下的路由名，如果其实是中转站，");
		out.push("  说明折叠那批流量时目录里没有它。用同一个路由名把它配回去，");
		out.push("  下一次目录变化会重建索引并让历史流量归位。");
	}
	return out;
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

	// First line the host half prints, and it carries the version. Three
	// separate rounds of debugging have ended at "the installed copy predates
	// the fix", each time discovered only after the code was read again — a
	// stale install and a broken one have identical symptoms, and this is the
	// cheapest thing that tells them apart.
	logger?.info?.("tokenledger %s: host half starting", VERSION);

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
	// Which relay program each site runs. Its own module, because it is four
	// pieces of state and a lifecycle — see `fingerprints.js` for why none of
	// them collapses into another, and for the two real bugs that lived here
	// when it had no seam to test against.
	const fingerprints = createFingerprintRegistry({
		detect: config.detect,
		enabled: config.fingerprint === true,
		logger,
		// Patch the live directory as soon as an answer lands. Recording only
		// into the map leaves it invisible until the next sweep rebuilds — up to
		// a whole interval of a site reading "unidentified" after detection has
		// already succeeded.
		onLearn: (software) => {
			directory = { ...directory, sites: withKnownSoftware(directory.sites, software) };
		}
	});

	/** Distinct origins, order-independent — the only change that alters attribution. */
	const originKey = (d) => [...new Set(Object.values(d.providerBaseUrls ?? {}))].sort().join(" ");

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
		merged.sites = withKnownSoftware(merged.sites, fingerprints.software);
		const next = { ...merged, available: discovered.available === true, resolveSite: buildResolver(merged) };
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
		for (const site of next.sites) fingerprints.request(site);
		return moved;
	};

	let running = false;
	// When the logs were last LOOKED AT, which is a different fact from when
	// they last changed. The checkpoint table only advances on a session that
	// moved, so a quiet hour leaves `MAX(updatedAt)` an hour behind while the
	// figures are perfectly current — reported as freshness that reads as a
	// stuck panel.
	let lastSweepAt;

	// Workspace titles for the directories the index knows about, refreshed once
	// per sweep. `resolveByPath` is async and the panel payload is assembled in
	// one synchronous pass, so the lookup cannot happen there; doing it per
	// distinct directory per sweep also keeps it off the panel-open path, where
	// it would be a handful of filesystem calls every time someone looks.
	let projectTitles = new Map();

	const refreshProjectTitles = async () => {
		try {
			const paths = store.byProject({}).map((row) => row.project);
			projectTitles = await readProjectTitles(paths, workspaceRegistry(ctx));
		} catch (error) {
			// A row keeps its directory name. Nothing about the usage it holds is
			// less true for want of a nicer label.
			logger?.debug?.("tokenledger: could not read workspace titles: %s", error?.message ?? error);
		}
	};

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
			const moved = refreshDirectory();
			// Two reasons to rebuild, and the second is the one that was missing.
			// A changed relay set is the obvious case; an index that simply
			// disagrees with the directory is the case that survives it.
			const stale = moved ? [] : staleAttributions(store, directory);
			if (moved || stale.length > 0) {
				if (moved) {
					logger?.info?.("tokenledger: the relay set changed; rebuilding the index so past traffic is attributed too");
				} else {
					logger?.info?.(
						"tokenledger: %d route(s) are recorded under a site the directory no longer agrees with (%s); rebuilding",
						stale.length,
						stale.map((r) => `${r.provider}: ${r.site} -> ${r.expected}`).join(", ")
					);
				}
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
			await refreshProjectTitles();
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
			// The whole directory, not just its sites: diagnostics needs the
			// route -> baseUrl map and the resolver to explain an attribution.
			directory: () => directory,
			projectTitles: () => projectTitles,
			refresh: () => void refreshDirectory(),
			settle: fingerprints.settle,
			probeStatus: fingerprints.status,
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
			accounts: () => listAccounts(ctx, { softwareOf: fingerprints.software }),
			projectTitles: () => projectTitles,
			lastSweepAt: () => lastSweepAt,
			balance: createBalanceReader(ctx, {
				softwareOf: fingerprints.software,
				// A lazily detected relay program is remembered, so the probe
				// happens once per site rather than once per balance read.
				learnSoftware: fingerprints.learn,
				// `config.detect`, not a bare `detect`. Lifting the fingerprint
				// registry out of apply() removed the local binding this used to
				// close over, and the leftover reference threw a ReferenceError
				// the moment `registerRoutes` was called — swallowed by the catch
				// below into a warning nobody reads, so the HTTP routes silently
				// stopped registering and the panel 404'd for every install after
				// that refactor.
				detect: config.detect,
				// Read through `config` rather than captured once, so editing a
				// declaration takes effect on the next read instead of at the
				// next restart — the whole point of registering the namespace.
				get endpoints() {
					return config.endpoints;
				}
			}),
			logger
		});
		if (!served) logger?.info?.("tokenledger: no web server in this composition; the panel will not be served");
	} catch (error) {
		// At error level, with the stack. This catch exists so a broken panel
		// never takes the harness down, and it did that job — but it also turned
		// a ReferenceError in our own code into one grey line, and the routes
		// were missing for weeks behind it. A caught bug still has to look like
		// a bug.
		logger?.error?.("tokenledger: could not register the HTTP routes: %s", error?.stack ?? error?.message ?? error);
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
