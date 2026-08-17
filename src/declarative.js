/**
 * Endpoints a user declares, for vendors nobody has written a reader for.
 *
 * ## Why this exists
 *
 * The built-in table has a ceiling. There are far more relays than anyone can
 * ship readers for, and their balance endpoints are nearly all the same thing:
 * one GET, one JSON body, a few numbers inside it. Opening an issue, cutting a
 * release and waiting for an upgrade is an absurd amount of machinery for that.
 *
 * A declaration says where the numbers are, not how to go and get them. There
 * is no expression language and nothing is evaluated: `fields` and `windows`
 * hold dotted paths into the response, and the only operation is "walk down".
 *
 * ## The boundary, and why it is in code rather than in advice
 *
 * This feature lets a configuration file decide where a request carrying the
 * user's API key gets sent. That is the whole risk, and none of it is mitigated
 * by telling people to be careful:
 *
 * 1. **The URL is built from the ACCOUNT's origin, never the declaration's.**
 *    The declared origin is only a lookup key — matched against origins that
 *    are already in the user's own provider configuration. Nothing here can
 *    name a host the harness was not already talking to.
 * 2. **`path` must be a single-slash absolute path.** `//evil.example/x` is a
 *    protocol-relative URL, and `new URL()` resolves it to a different host
 *    entirely. The origin is re-checked after construction anyway, so this is
 *    belt and braces on purpose.
 * 3. **Only GET.** No body, no method, no headers from the declaration.
 * 4. **The credential still comes from the route's own `apiKeyEnv`** and is
 *    resolved by the same seam as everything else. A declaration cannot name a
 *    credential, its own or anyone else's.
 * 5. **Cross-origin redirects fail instead of being followed** — see `http` in
 *    `balance.js`. Following one is the cheapest possible way around rule 1.
 * 6. **Bounded body and a shared timeout**, so a hostile or broken endpoint
 *    cannot hold the panel open or exhaust memory.
 * 7. **A declaration cannot shadow a built-in scheme.** It is consulted only
 *    where nothing else could answer, so no declaration can change how a known
 *    vendor is read.
 *
 * @module dsh-tokenledger/declarative
 */

import { normalizeOrigin } from "./relay-sites.js";

/** Keys that reach the prototype chain rather than the parsed document. */
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Walk a dotted path into a parsed body.
 *
 * Every failure is the same answer — `undefined` — because a path that does not
 * match is a field this response does not carry, which is a fact the card
 * already knows how to render. It is not an error, and it must not cost the
 * fields that did resolve.
 */
export function readPath(body, path) {
	if (typeof path !== "string" || path === "") return undefined;
	let cursor = body;
	for (const segment of path.split(".")) {
		if (cursor === null || typeof cursor !== "object") return undefined;
		if (FORBIDDEN.has(segment)) return undefined;
		cursor = cursor[segment];
	}
	return cursor;
}

/** Numbers arrive as strings often enough to be worth handling once. */
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** The four money fields, each read only if the declaration named a path. */
const AMOUNT_FIELDS = ["total", "granted", "used"];

/** Which window inputs are paths into the body, as opposed to literal values. */
const WINDOW_PATHS = ["usedPercent", "usedRatio", "remainingPercent", "used", "limit", "resetsAt", "resetInSeconds"];

/**
 * Turn one declaration into something `SCHEMES` can hold.
 *
 * @param declaration - `{ displayName, path, raw?, fields?, windows? }`.
 * @returns a scheme, or `undefined` when the declaration cannot be honoured
 *   safely. A rejected declaration leaves the account reading "unsupported",
 *   which is true and is what it said before anyone declared anything.
 */
export function compileEndpoint(declaration) {
	const path = declaration?.path;
	// Rule 2. A path that does not start with exactly one slash is either
	// relative — meaning it would resolve against the origin's own path, which
	// is not what anyone writing this means — or protocol-relative, which is a
	// different host wearing a path's clothes.
	if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return undefined;

	const fields = declaration.fields ?? {};
	const windows = Array.isArray(declaration.windows) ? declaration.windows : [];
	const raw = declaration.raw === true;

	return {
		label: typeof declaration.displayName === "string" && declaration.displayName !== "" ? declaration.displayName : "Declared",
		// Marks the card, because these numbers came out of paths the user
		// wrote. A wrong path is a configuration mistake, and the interface has
		// to make that distinguishable from the plugin getting it wrong.
		declared: true,
		async read({ origin, get }) {
			const url = new URL(path, origin);
			// Rule 1, enforced again after construction rather than trusted. If
			// these ever disagree, the request does not happen.
			if (url.origin !== new URL(origin).origin) throw Object.assign(new Error("cross-origin-path"), { kind: "declaration" });

			const body = await get(url.href, { raw, sameOrigin: url.origin, maxBytes: 1_000_000 });

			const amount = {};
			for (const key of AMOUNT_FIELDS) {
				const value = toNumber(readPath(body, fields[key]));
				if (value !== undefined) amount[key] = value;
			}
			const currency = readPath(body, fields.currency);
			const plan = readPath(body, fields.plan);

			return {
				...amount,
				...(typeof currency === "string" && currency !== "" ? { currency } : {}),
				...(typeof plan === "string" && plan !== "" ? { plan } : {}),
				isAvailable: amount.total === undefined ? undefined : amount.total > 0,
				windows: windows.map((window) => resolveWindow(window, body)),
				// Nothing resolved is worth saying out loud: it means every path
				// in the declaration missed, which is a typo, not an empty
				// account. Without this the card is indistinguishable from a
				// vendor that simply reports nothing.
				...(Object.keys(amount).length === 0 && windows.length === 0 ? { reason: "the declaration named no fields" } : {})
			};
		}
	};
}

/** One declared window: `kind` and `minutes` are values, the rest are paths. */
function resolveWindow(declaration, body) {
	const resolved = { kind: declaration?.kind };
	const minutes = toNumber(declaration?.minutes);
	if (minutes !== undefined) resolved.minutes = minutes;
	for (const key of WINDOW_PATHS) {
		const value = readPath(body, declaration?.[key]);
		if (value !== undefined) resolved[key] = value;
	}
	return resolved;
}

/**
 * Index the user's declarations by origin.
 *
 * Normalized through the same function site attribution uses, so a declaration
 * written `https://Relay.Example.com/v1/` matches an account discovered as
 * `https://relay.example.com`. Without that the feature would appear not to
 * work for reasons nobody could see.
 */
export function indexEndpoints(list) {
	const byOrigin = new Map();
	if (!Array.isArray(list)) return byOrigin;
	for (const declaration of list) {
		const origin = normalizeOrigin(declaration?.origin);
		// First wins, so a duplicate is inert rather than quietly overriding.
		if (origin !== undefined && !byOrigin.has(origin)) byOrigin.set(origin, declaration);
	}
	return byOrigin;
}
