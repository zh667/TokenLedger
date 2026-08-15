/**
 * The read-only HTTP surface the browser panel reads.
 *
 * ## Why this needs its own fence
 *
 * `webServer.register({ kind: 'exact' })` wins over the RPC prefix, which means
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
 * ## What is deliberately not exposed
 *
 * Counts and identifiers only — the same rule the collector follows. No prompt,
 * tool argument, response content, or credential is readable through any route
 * here, and the store holds none of them to begin with.
 *
 * @module dsh-tokenledger/http
 */

import { dayKey } from "./usage.js";

/** Route prefix. Exact registrations, so each path is spelled out. */
export const BASE_PATH = "/api/tokenledger";
export const USAGE_PATH = `${BASE_PATH}/usage`;
export const BALANCE_PATH = `${BASE_PATH}/balance`;

/** `YYYY-MM-DD` for N days back, inclusive of today. */
function fromDaysAgo(days) {
	return dayKey(Date.now() - (days - 1) * 86_400_000);
}

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
 * @param deps - `{ store, sites, priced }`.
 * @param query - `{ range, site }` from {@link parseQuery}.
 */
export function usagePayload(deps, query) {
	const { store, sites, priced } = deps;
	const { range, site } = query;
	return {
		ok: true,
		generatedAt: Date.now(),
		range,
		site,
		totals: store.totals(range, site),
		days: store.byDay(range, site),
		models: store.byModel(range, site),
		// Site rows are never filtered by the current selection: the breakdown is
		// how you CHANGE that selection, so hiding the others would strand you.
		sites: store.bySite(range),
		providers: store.byProvider(range, site),
		// Configured/discovered sites carry the routes and software behind each
		// row, which the totals alone cannot say.
		directory: (sites?.() ?? []).map((s) => ({
			id: s.id,
			routes: s.routes ?? [],
			type: s.type,
			discovered: s.discovered !== false
		})),
		diagnostics: store.diagnostics(),
		priced: priced?.(range, site) ?? null
	};
}

/**
 * Register the read-only routes, if this composition has a web server.
 *
 * `webServer` is reached through `ctx.get` rather than declared in `inject`,
 * for the same reason `commands` and `settings` are: a headless composition
 * must still collect usage, and Cordis's `inject` has no optional form.
 *
 * @returns whether the routes were registered.
 */
export function registerRoutes(ctx, deps) {
	// WAITED FOR, not sampled. `ctx.get` at mount time answers undefined for a
	// service that mounts later, and on a real install `webServer` is one of
	// them: the routes silently never registered and the panel got a 404 from a
	// plugin whose host half had demonstrably loaded. This is the third time the
	// same mistake has shipped — `settings` twice, now this — so the sampling
	// form is not used for an optional service anywhere in this package.
	if (typeof ctx.inject !== "function") {
		const immediate = typeof ctx.get === "function" ? ctx.get("webServer") : undefined;
		if (immediate === undefined || typeof immediate.register !== "function") return false;
		return attachRoutes(ctx, immediate, deps);
	}
	ctx.inject(["webServer"], (scoped) => {
		attachRoutes(scoped, scoped.webServer, deps);
	});
	return true;
}

/**
 * Register the routes on a context that already has the web server.
 *
 * @returns true, so the caller can report that a surface exists.
 */
function attachRoutes(ctx, webServer, deps) {
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
				webServer.register({
					kind: "exact",
					path,
					handler: async (req, res) => {
						const refused = screenRequest(req);
						if (refused !== undefined) return send(res, refused.status, refused.body);
						try {
							send(res, 200, await build(parseQuery(req.url)));
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
		route(BALANCE_PATH, async () => deps.balance(), "tokenledger balance route");
	}

	return true;
}
