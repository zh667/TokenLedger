/**
 * The read-only HTTP surface the browser panel reads.
 *
 * ## Why this needs its own fence
 *
 * `httpServer.register({ kind: 'exact' })` wins over the RPC prefix, which means
 * these routes sit **outside** the RPC trust boundary. Nothing upstream is
 * checking the caller for us, so the handler does it, and it does it on the
 * peer socket address rather than on the `Host` header: a header is whatever
 * the client typed, while the socket's remote address is observed. The header
 * is checked too, but only as a second condition — never as the only one.
 *
 * ## Why it serves the same queries the command renders
 *
 * Every figure comes from `LedgerStore`'s existing methods. The page therefore
 * cannot disagree with `/tokenledger`, because there is no second aggregation
 * to drift. That equality is also the acceptance test for the whole UI, which
 * only works if there is nothing here to get independently wrong.
 *
 * ## What this module is not
 *
 * Transport, screening, and one view model. The day arithmetic and the per-day
 * model fold used to live here too, which put the loopback fence in the same
 * file as a set of date helpers — the two things least worth reading past each
 * other. They now sit in `usage.js`, beside the folds they belong with.
 *
 * ## What is deliberately not exposed
 *
 * Counts and identifiers only — the same rule the collector follows. No prompt,
 * tool argument, response content, or credential is readable through any route
 * here, and the store holds none of them to begin with.
 *
 * @module dsh-tokenledger/http
 */

import { createRequire } from "node:module";

import { describeProject } from "./projects.js";
import { dailyModels, dayKey, fromDaysAgo, hostTimeZone, monthStart } from "./usage.js";

/**
 * This package's version, read from its own manifest.
 *
 * Reported on every payload because an install being behind is invisible from
 * both sides otherwise — the symptom of a stale copy is identical to the
 * symptom of a broken one.
 */
export const VERSION = (() => {
	try {
		return createRequire(import.meta.url)("../package.json").version;
	} catch {
		return "unknown";
	}
})();

/** Route prefix. Exact registrations, so each path is spelled out. */
export const BASE_PATH = "/api/tokenledger";
export const USAGE_PATH = `${BASE_PATH}/usage`;
export const BALANCE_PATH = `${BASE_PATH}/balance`;
export const ACCOUNTS_PATH = `${BASE_PATH}/accounts`;

/**
 * How many days the activity strip covers: a full year of whole weeks.
 *
 * Twelve weeks fit the panel without scrolling and answered almost nothing —
 * the point of a heatmap is the shape of a long stretch. The strip scrolls
 * horizontally and lands on the newest week, which is the GitHub convention and
 * the one the comparable dashboard uses.
 */
export const ACTIVITY_DAYS = 371;

/**
 * Loopback test for a bare address.
 *
 * IPv6-mapped IPv4 (`::ffff:127.0.0.1`) is what Node reports on a dual-stack
 * listener, so it has to be recognized or every local request looks foreign.
 */
export function isLoopbackAddress(address) {
	if (typeof address !== "string" || address === "") return false;
	const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
	if (bare === "::1" || bare === "localhost") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Host header without its port, tolerating a bracketed IPv6 literal. */
export function hostNameOf(header) {
	if (typeof header !== "string" || header === "") return "";
	if (header.startsWith("[")) return header.slice(1, header.indexOf("]"));
	const colon = header.lastIndexOf(":");
	return colon === -1 ? header : header.slice(0, colon);
}

/**
 * Decide whether a request may be served.
 *
 * @returns `undefined` when the request is acceptable, otherwise
 *   `{ status, body }` to send back.
 */
export function screenRequest(req) {
	if (req?.method !== "GET") return { status: 405, body: { ok: false, error: "method-not-allowed" } };
	const peerOk = isLoopbackAddress(req.socket?.remoteAddress);
	const hostOk = isLoopbackAddress(hostNameOf(req.headers?.host));
	// Both, and the peer address is the one that cannot be forged.
	if (peerOk && hostOk) return undefined;
	return { status: 403, body: { ok: false, error: "forbidden" } };
}

/** The `?account=` a balance request names, or undefined for the first one. */
export function accountOf(url) {
	try {
		const value = new URL(url ?? "/", "http://localhost").searchParams.get("account");
		return value === null || value === "" ? undefined : value;
	} catch {
		return undefined;
	}
}

/** Parse `?days=` / `?site=` into the range the store queries take. */
export function parseQuery(url) {
	let params;
	try {
		params = new URL(url ?? "/", "http://localhost").searchParams;
	} catch {
		return { range: {}, site: undefined };
	}
	const days = Number.parseInt(params.get("days") ?? "", 10);
	const site = params.get("site") ?? undefined;
	return {
		range: Number.isFinite(days) && days > 0 ? { from: fromDaysAgo(days) } : {},
		site: site === "" ? undefined : site
	};
}

/**
 * Build the whole panel payload in one read.
 *
 * One request rather than six: the panel renders as a unit, and six requests
 * would let its sections disagree with each other while they land.
 *
 * @param deps - `{ store, sites, priced, projectTitles }`.
 * @param query - `{ range, site }` from {@link parseQuery}.
 */
export function usagePayload(deps, query) {
	const { store, sites, priced } = deps;
	const { range, site } = query;
	return {
		ok: true,
		// So "is my install current?" is answerable in one request. Several rounds
		// were spent on a panel that was absent because the installed copy predated
		// the fix, with no way to see that from either side.
		version: VERSION,
		generatedAt: Date.now(),
		// The HOST's zone, not the browser's. Days are grouped by the local time
		// of the process that folded them, so a harness on a server in UTC read
		// from a browser in UTC+8 has its days cut at a boundary the reader does
		// not share. Labelling the browser's zone would be confidently wrong.
		timeZone: hostTimeZone(),
		range,
		site,
		totals: store.totals(range, site),
		days: store.byDay(range, site),
		// The three windows the panel shows side by side, each a whole figure
		// rather than a slice of the selected range: "today" and "this month" and
		// "all time" are the questions people actually ask, and reading them off
		// one selector means changing it three times.
		windows: {
			today: store.totals({ from: dayKey(Date.now()) }, site),
			month: store.totals({ from: monthStart() }, site),
			all: store.totals({}, site)
		},
		// The activity strip has its OWN window, deliberately. Tied to the
		// selected range it collapsed to a single cell whenever "today" was
		// picked — a heatmap of one day is not a heatmap, and it read as broken.
		activity: store.byDay({ from: fromDaysAgo(ACTIVITY_DAYS) }, site),
		// Per-day, per-model rows for the same window, so hovering a cell can
		// show what ran that day rather than only how much. Sent with the panel
		// rather than fetched per hover: a request on mouseover would lag behind
		// the pointer, and these are counts, not content.
		activityModels: dailyModels(store.byRoute({ from: fromDaysAgo(ACTIVITY_DAYS) }, site)),
		models: store.byModel(range, site),
		// Site rows are never filtered by the current selection: the breakdown is
		// how you CHANGE that selection, so hiding the others would strand you.
		sites: store.bySite(range),
		// Which project burned it — keyed on the directory the session ran in,
		// labelled with the workspace title when there is one. See `projects.js`
		// for why the directory is the key and the workspace only the label.
		projects: store.byProject(range, site).map((row) => ({ ...row, ...describeProject(row.project, deps.projectTitles?.().get(row.project)) })),
		providers: store.byProvider(range, site),
		// Configured/discovered sites carry the routes and software behind each
		// row, which the totals alone cannot say.
		directory: (sites?.() ?? []).map((s) => ({
			id: s.id,
			routes: s.routes ?? [],
			type: s.type,
			discovered: s.discovered !== false
		})),
		// The picker renders with the panel rather than after a second round
		// trip; it is a list of names and origins, no keys and no network.
		accounts: deps.accounts?.() ?? [],
		// When the logs were last read, as distinct from when they last changed.
		// The checkpoint table only advances on a session that moved, so a quiet
		// hour left the panel claiming to be an hour stale while its figures were
		// exactly right.
		lastSweepAt: deps.lastSweepAt?.(),
		diagnostics: store.diagnostics(),
		priced: priced?.(range, site) ?? null
	};
}

/**
 * Service names worth reporting when the one we want has not turned up.
 *
 * Not an exhaustive list of what a composition holds — there is no public way
 * to enumerate that — but every name this package has ever reached for, plus
 * the one it reached for wrongly. Printing which of these resolve turns "the
 * panel 404s" into "the host provides `httpServer`, so we are asking for the
 * wrong thing" or "this composition genuinely has no web server".
 */
const KNOWN_SERVICES = [
	"httpServer",
	"webServer",
	"sessionPersistence",
	"sessionQuery",
	"settings",
	"credentials",
	"commands",
	"llm",
	"workspace"
];

/** Which of the names above this context can actually resolve. */
function visibleServices(ctx) {
	if (typeof ctx.get !== "function") return [];
	return KNOWN_SERVICES.filter((name) => {
		try {
			return ctx.get(name) !== undefined;
		} catch {
			return false;
		}
	});
}

/**
 * Register the read-only routes, if this composition has a web server.
 *
 * `httpServer` is reached through a nested `inject` rather than the plugin's
 * own, for the same reason `commands` and `settings` are sampled: a headless
 * composition must still collect usage, and Cordis's `inject` has no optional
 * form, so a required declaration would refuse to load without a browser.
 *
 * @returns whether the routes were registered.
 */
export function registerRoutes(ctx, deps) {
	// The service is `httpServer`. The PACKAGE is `dsh-host-webserver`, and
	// naming the service after the package — `webServer` — is what shipped, so
	// the nested fiber below waited on a name nothing provides and the routes
	// were never registered. Upstream is unambiguous: `super(ctx, "httpServer")`.
	//
	// Nothing reported it. A nested `ctx.inject` is its own fiber, and DSH's
	// activation assertion only covers top-level entries, so the host half
	// "loaded" while the panel got a 404 from routes that did not exist.
	//
	// WAITED FOR, not sampled, for the separate reason recorded below: `ctx.get`
	// at mount time answers undefined for a service that mounts later, which is
	// how this same route silently vanished twice before. Name and lookup form
	// are two independent ways to get this wrong and both have now been wrong.
	if (typeof ctx.inject !== "function") {
		const immediate = typeof ctx.get === "function" ? ctx.get("httpServer") : undefined;
		if (immediate === undefined || typeof immediate.register !== "function") return false;
		return attachRoutes(ctx, immediate, deps);
	}
	// A nested inject that never fires is invisible: no error, no log, and the
	// only symptom is a 404 in a browser console that says nothing about the
	// host. Twice now that has cost days. So the wait announces itself, and says
	// so again if it is still waiting — with the services that DO exist, because
	// "which name is right" is the question that was actually wrong both times.
	deps.logger?.info?.("tokenledger: waiting for httpServer to serve %s", BASE_PATH);
	let attached = false;
	// Injectable so a test can reach this branch without sleeping through it.
	const nagging = setTimeout(() => {
		if (attached) return;
		deps.logger?.warn?.(
			"tokenledger: still no httpServer after 10s — the panel will 404. Services this context can see: %s",
			visibleServices(ctx).join(", ") || "(none)"
		);
	}, deps.routeWaitMs ?? 10_000);
	nagging.unref?.();

	ctx.inject(["httpServer"], (scoped) => {
		attached = true;
		clearTimeout(nagging);
		attachRoutes(scoped, scoped.httpServer, deps);
		deps.logger?.info?.("tokenledger: serving %s and %s", USAGE_PATH, BALANCE_PATH);
	});
	return true;
}

/**
 * Register the routes on a context that already has the web server.
 *
 * @returns true, so the caller can report that a surface exists.
 */
function attachRoutes(ctx, httpServer, deps) {
	const logger = deps.logger;

	const send = (res, status, value) => {
		const body = JSON.stringify(value);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-cache"
		});
		res.end(body);
	};

	const route = (path, build, label) => {
		ctx.effect(
			() =>
				httpServer.register({
					kind: "exact",
					path,
					handler: async (req, res) => {
						const refused = screenRequest(req);
						if (refused !== undefined) return send(res, refused.status, refused.body);
						try {
							send(res, 200, await build(parseQuery(req.url), req.url));
						} catch (error) {
							// A failed read is this plugin's problem, never the harness's.
							logger?.warn?.("tokenledger: %s failed: %s", path, error?.message ?? error);
							send(res, 500, { ok: false, error: "internal" });
						}
					}
				}),
			label
		);
	};

	route(USAGE_PATH, async (query) => {
		await deps.sweep?.();
		return usagePayload(deps, query);
	}, "tokenledger usage route");

	if (typeof deps.balance === "function") {
		route(
			BALANCE_PATH,
			async (query, url) => deps.balance(accountOf(url)),
			"tokenledger balance route"
		);
	}

	return true;
}
