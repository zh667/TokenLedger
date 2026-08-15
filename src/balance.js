/**
 * Account balances, for the vendor and for every relay.
 *
 * ## The premise this module used to have was wrong
 *
 * An earlier version read only DeepSeek's balance, on the grounds that relay
 * billing needs administrator credentials. That is true of New API's
 * **per-request log** (`/api/log`, an admin route) and it is not true of its
 * **balance**: `GET /api/usage/token/` is behind `TokenAuthReadOnly`, so an
 * ordinary `sk-` key reads the quota granted to, used by, and remaining on that
 * key. Sub2API's `/v1/usage` is the same shape of thing. Verified against New
 * API's router source and against a live deployment, which answers
 * `{"success":false,"message":"Invalid token"}` to a bad Bearer rather than
 * demanding a session.
 *
 * So a relay's balance costs exactly what the vendor's does: one key, which the
 * harness already holds for that route.
 *
 * ## The credential is borrowed, never held
 *
 * Every key is resolved from the credentials seam at request time from the
 * reference the provider profile already carries (`apiKeyEnv`), and dropped
 * when the request ends. Nothing here writes a key to the store, the log, the
 * payload, or a diagnostic — and it always rides an `Authorization` header,
 * never a query string, which would leak into browser history and proxy logs.
 *
 * ## Absence is a fact, not an error
 *
 * A route with no key, a relay running software nobody recognises, a vendor
 * with no balance endpoint: each says so in words. A red state belongs on a
 * problem, and none of those is one.
 *
 * @module dsh-tokenledger/balance
 */

import { detectRelaySoftware } from "./adapters/detect.js";
import { normalizeOrigin } from "./relay-sites.js";

/** The vendor's own endpoint, and the only origin the `deepseek` scheme calls. */
export const DEEPSEEK_ORIGIN = "https://api.deepseek.com";

/**
 * Whether a provider profile addresses DeepSeek's own API.
 *
 * Matched on the origin rather than on the route name, for the same reason site
 * attribution is: a route called `deepseek` may point anywhere, and a route
 * called anything may point at DeepSeek.
 */
export function isOfficialDeepSeek(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl === "") return true; // no baseURL = the shipped default
	try {
		return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
	} catch {
		return false;
	}
}

/** Parse a number that an API may send as a string. */
function num(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * One reader per relay program, plus the vendor.
 *
 * Each returns the same shape so the panel renders one card whatever answered:
 * `{ currency, total, granted, used, unlimited?, plan?, note? }`, with every
 * field absent rather than zeroed when the response does not carry it. A
 * balance of nothing and an unreported balance are different facts, and showing
 * the second as the first tells someone their account is empty.
 */
export const SCHEMES = {
	deepseek: {
		label: "DeepSeek",
		async read({ origin, get }) {
			const body = await get(new URL("/user/balance", origin).href);
			const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
			const info = infos.find((entry) => entry?.currency === "CNY") ?? infos[0];
			return {
				isAvailable: body?.is_available === true,
				currency: info?.currency,
				total: num(info?.total_balance),
				granted: num(info?.granted_balance),
				toppedUp: num(info?.topped_up_balance)
			};
		}
	},

	newapi: {
		label: "New API",
		async read({ origin, get }) {
			// The trailing slash is load-bearing: without it New API answers 301,
			// and a redirect drops the Authorization header on some clients.
			const body = await get(new URL("/api/usage/token/", origin).href);
			const data = body?.data ?? {};
			const granted = num(data.total_granted);
			const used = num(data.total_used);
			const available = num(data.total_available);

			// Quota is an internal integer, and the same figure means different
			// money at different sites. `/api/status` carries the two site-owned
			// numbers that convert it; without them the quota is reported as-is
			// rather than guessed at.
			let currency;
			let scale;
			try {
				const status = (await get(new URL("/api/status", origin).href, { anonymous: true }))?.data ?? {};
				const perUnit = num(status.quota_per_unit);
				const price = num(status.price);
				if (perUnit !== undefined && perUnit > 0) {
					scale = price === undefined ? 1 / perUnit : price / perUnit;
					currency = price === undefined ? "USD" : "CNY";
				}
			} catch {
				// A site that will not describe its own units still has a quota.
			}

			const money = (quota) => (quota === undefined || scale === undefined ? undefined : quota * scale);
			return {
				isAvailable: data.unlimited_quota === true || (available ?? 0) > 0,
				unlimited: data.unlimited_quota === true,
				currency,
				total: money(available),
				granted: money(granted),
				used: money(used),
				// Kept beside the money so a site with no published units still
				// shows something true.
				quota: { granted, used, available },
				expiresAt: num(data.expires_at) || undefined
			};
		}
	},

	sub2api: {
		label: "Sub2API",
		async read({ origin, get }) {
			const body = await get(new URL("/v1/usage", origin).href);
			const currency = body?.unit ?? undefined;
			return {
				isAvailable: body?.isValid !== false,
				currency,
				total: num(body?.balance),
				remaining: num(body?.remaining),
				plan: body?.planName ?? undefined
			};
		}
	}
};

/**
 * Read one account.
 *
 * @param options - `{ scheme, origin, apiKey, fetch?, timeoutMs? }`.
 * @returns `{ supported, fetched, ... }`. `fetched` rather than `ok` because
 *   the caller wraps this in an envelope whose own `ok` means "the request was
 *   served"; spreading one over the other made a served request that simply had
 *   no key look like a failed route.
 */
export async function readBalance(options = {}) {
	const { scheme, origin, apiKey, timeoutMs = 15_000 } = options;
	const spec = SCHEMES[scheme];
	if (spec === undefined) return { supported: false, reason: "unknown-software" };
	if (typeof apiKey !== "string" || apiKey === "") {
		return { supported: true, fetched: false, reason: "no-credential" };
	}

	const doFetch = options.fetch ?? globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const get = async (url, { anonymous = false } = {}) => {
		const response = await doFetch(url, {
			headers: anonymous
				? { accept: "application/json" }
				: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: controller.signal
		});
		if (!response.ok) throw Object.assign(new Error(`http-${response.status}`), { status: response.status });
		return response.json();
	};

	try {
		return { supported: true, fetched: true, scheme, ...(await spec.read({ origin, get })) };
	} catch (error) {
		const reason =
			error?.status !== undefined
				? `http-${error.status}`
				: error?.name === "AbortError"
					? "timeout"
					: "unreachable";
		return { supported: true, fetched: false, scheme, reason };
	} finally {
		clearTimeout(timer);
	}
}

/** Walk a settings path; shared shape with `discovery.readAtPath`. */
function readAt(section, path) {
	let cursor = section;
	for (const key of path) {
		if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
		cursor = cursor[key];
	}
	return cursor;
}

/**
 * Every provider route, with what is known about how to read its balance.
 *
 * No keys and no network: this is the list the picker renders, and it must be
 * cheap enough to send with the panel.
 *
 * @returns `[{ id, displayName, origin, scheme, hasCredential }]`.
 */
export function listAccounts(ctx, options = {}) {
	const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
	const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
	if (llm === undefined || settings === undefined) return [];

	const readSection = options.readSection ?? ((ns) => settings.get?.(ns));
	const softwareOf = options.softwareOf ?? new Map();
	let entries;
	try {
		entries = llm.listConfigurableProviders?.() ?? [];
	} catch {
		return [];
	}

	const seen = new Set();
	const out = [];
	for (const entry of entries) {
		let profile;
		try {
			profile = readAt(readSection(entry.settingsNs), entry.settingsPath ?? []);
		} catch {
			continue;
		}
		const baseUrl = profile?.baseURL ?? profile?.baseUrl;
		const official = isOfficialDeepSeek(baseUrl);
		const origin = official ? (normalizeOrigin(baseUrl) ?? DEEPSEEK_ORIGIN) : normalizeOrigin(baseUrl);
		if (origin === undefined) continue;
		// One card per account, not per route: two keys on one relay share a
		// balance, and listing it twice invites reading it as two.
		if (seen.has(origin)) continue;
		seen.add(origin);

		out.push({
			id: entry.provider,
			displayName: official ? "DeepSeek" : (new URL(origin).hostname),
			origin,
			// Unknown until something asks — relay software is fingerprinted
			// lazily, when a balance is actually requested for that site.
			scheme: official ? "deepseek" : softwareOf.get(new URL(origin).hostname),
			hasCredential: typeof profile?.apiKeyEnv === "string" && profile.apiKeyEnv !== ""
		});
	}
	return out;
}

/**
 * Build the reader the HTTP route serves.
 *
 * @param ctx - the Cordis context.
 * @param options - `{ readSection?, fetch?, softwareOf?, learnSoftware? }`.
 *   `softwareOf` is the plugin's fingerprint cache; `learnSoftware` records a
 *   lazily detected one so the next read skips the probe.
 */
export function createBalanceReader(ctx, options = {}) {
	return async (id) => {
		const accounts = listAccounts(ctx, options);
		if (accounts.length === 0) return { ok: true, supported: false, reason: "no-provider-directory" };

		const account = id === undefined ? accounts[0] : accounts.find((a) => a.id === id);
		if (account === undefined) return { ok: true, supported: false, reason: "unknown-account" };

		// Fingerprint on demand. Probing every relay at startup was six
		// unauthenticated requests for a column nothing read; probing the one a
		// user just asked about is the same work with a reason behind it.
		let scheme = account.scheme;
		if (scheme === undefined) {
			try {
				const detect = options.detect ?? detectRelaySoftware;
				const result = await detect(account.origin);
				if (result.billingAvailable) {
					scheme = result.software;
					options.learnSoftware?.(new URL(account.origin).hostname, scheme);
				}
			} catch {
				// Leave it unknown; the answer below says so.
			}
		}
		if (scheme === undefined || SCHEMES[scheme] === undefined) {
			return { ok: true, account: account.id, supported: false, reason: "unknown-software" };
		}

		const credentials = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
		const reference = referenceFor(ctx, account, options);
		const apiKey =
			reference === undefined || credentials === undefined
				? undefined
				: await Promise.resolve(credentials.resolve?.(reference))
						.then((hit) => hit?.value ?? hit)
						.catch(() => undefined);

		return {
			ok: true,
			account: account.id,
			displayName: account.displayName,
			...(await readBalance({ scheme, origin: account.origin, apiKey, fetch: options.fetch }))
		};
	};
}

/** The credential reference on the route that serves this account. */
function referenceFor(ctx, account, options) {
	const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
	const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
	if (settings === undefined || llm === undefined) return undefined;
	const readSection = options.readSection ?? ((ns) => settings.get?.(ns));
	for (const entry of llm.listConfigurableProviders?.() ?? []) {
		if (entry.provider !== account.id) continue;
		const profile = readAt(readSection(entry.settingsNs), entry.settingsPath ?? []);
		return typeof profile?.apiKeyEnv === "string" ? profile.apiKeyEnv : undefined;
	}
	return undefined;
}
