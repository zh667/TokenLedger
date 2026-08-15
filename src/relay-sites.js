/**
 * Relay-site registry and DSH-provider → site resolution.
 *
 * A *relay site* (中转站) is a third-party gateway that resells access to model
 * APIs — a New API or Sub2API deployment, typically. TokenLedger identifies a
 * site by the exact origin its base URL points at, never by model name and
 * never by guesswork: two sites reselling `deepseek-v4` are two sites.
 *
 * Rules this module exists to enforce:
 *
 * - A credential is referenced, never stored. Callers keep secrets in an
 *   OS-protected store and hand this module a reference plus, optionally, a
 *   non-reversible fingerprint so two keys on one domain stay distinguishable.
 * - An origin is compared after normalization (lowercase host, default port
 *   dropped, path ignored) so `https://api.example.com/v1` and
 *   `https://API.example.com:443/` are one site.
 * - Changing a provider's base URL produces a new configuration revision. The
 *   usage fold stamps the site it resolved at the time, so historical rows keep
 *   pointing at the site that actually served them.
 *
 * @module dsh-tokenledger/relay-sites
 */

import { createHash } from "node:crypto";

/** Supported relay implementations. */
export const SITE_TYPES = Object.freeze(["newapi", "sub2api"]);

/**
 * Normalize a base URL to a comparable origin: `scheme://host[:port]`, with the
 * scheme's default port removed.
 * @returns the normalized origin, or undefined when the input is unparseable.
 */
export function normalizeOrigin(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl.trim() === "") return undefined;
	let url;
	try {
		url = new URL(baseUrl.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const defaultPort = url.protocol === "https:" ? "443" : "80";
	const port = url.port === "" || url.port === defaultPort ? "" : `:${url.port}`;
	return `${url.protocol}//${url.hostname.toLowerCase()}${port}`;
}

/**
 * The domain of a base URL, for display in selectors and billing rows.
 *
 * The port comes along when there is one to carry — `normalizeOrigin` has
 * already dropped the default, so `https://relay.example` stays readable while
 * two self-hosted relays on one machine stay distinct. Dropping it made them a
 * single site whose rows were the sum of both, and made the software cache
 * answer for whichever was probed first.
 */
export function domainOf(baseUrl) {
	const origin = normalizeOrigin(baseUrl);
	if (origin === undefined) return undefined;
	const url = new URL(origin);
	return url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
}

/**
 * A short, non-reversible fingerprint of a credential, so several keys on one
 * domain remain distinguishable in the UI without the secret ever being stored.
 * Not a security boundary — it exists to label rows, not to protect the key.
 */
export function credentialFingerprint(secret) {
	if (typeof secret !== "string" || secret === "") return undefined;
	return createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12);
}

/**
 * Build a validated site record.
 * @param input - `{ id, displayName?, type, baseUrl, credentialReference?,
 *   credentialFingerprint?, configurationRevision? }`.
 * @throws when the type is unknown or the base URL has no usable origin.
 */
export function defineSite(input) {
	const { id, type, baseUrl } = input;
	if (typeof id !== "string" || id.trim() === "") {
		throw new TypeError("relay site requires a non-empty id");
	}
	if (!SITE_TYPES.includes(type)) {
		throw new TypeError(`unknown relay site type: ${String(type)}`);
	}
	const origin = normalizeOrigin(baseUrl);
	if (origin === undefined) {
		throw new TypeError(`relay site ${id} has an unusable baseUrl`);
	}
	if (Object.hasOwn(input, "apiKey") || Object.hasOwn(input, "token")) {
		throw new TypeError(`relay site ${id} must reference a credential, not carry one`);
	}
	return Object.freeze({
		id: id.trim(),
		displayName: input.displayName?.trim() || domainOf(origin),
		type,
		origin,
		domain: domainOf(origin),
		credentialReference: input.credentialReference,
		credentialFingerprint: input.credentialFingerprint,
		configurationRevision: input.configurationRevision ?? 1
	});
}

/**
 * A registry of relay sites, queryable by id or by origin.
 */
export class RelaySiteRegistry {
	#byId = new Map();
	#byOrigin = new Map();

	constructor(sites = []) {
		for (const site of sites) this.add(site);
	}

	/** Register a site record (or raw input, which is validated first). */
	add(site) {
		const record = Object.isFrozen(site) && site.origin !== undefined ? site : defineSite(site);
		this.#byId.set(record.id, record);
		// Last registration wins for an origin, matching "current configuration".
		this.#byOrigin.set(record.origin, record);
		return record;
	}

	get(id) {
		return this.#byId.get(id);
	}

	matchOrigin(baseUrl) {
		const origin = normalizeOrigin(baseUrl);
		if (origin === undefined) return undefined;
		return this.#byOrigin.get(origin);
	}

	list() {
		return [...this.#byId.values()];
	}
}

/**
 * Build the `resolveSite` function the usage fold takes.
 *
 * @param registry - the relay-site registry.
 * @param providerBaseUrls - `Map<providerId, baseUrl>` or a plain object,
 *   describing how each DSH provider route is currently configured.
 * @returns `(providerId) => siteId | undefined`, where undefined means the call
 *   did not go through a configured relay and should count as direct.
 */
export function createSiteResolver(registry, providerBaseUrls) {
	const lookup =
		providerBaseUrls instanceof Map ? providerBaseUrls : new Map(Object.entries(providerBaseUrls ?? {}));
	const cache = new Map();
	return (providerId) => {
		if (cache.has(providerId)) return cache.get(providerId);
		const site = registry.matchOrigin(lookup.get(providerId));
		const id = site?.id;
		cache.set(providerId, id);
		return id;
	};
}
