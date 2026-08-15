/**
 * DeepSeek official account balance.
 *
 * Deliberately one vendor. `dsh-usage-stats` already covers DeepSeek,
 * OpenRouter, Moonshot and Z.AI, and a worse copy of something a user probably
 * has installed is not worth the code. What this exists for is the one account
 * every DSH user has.
 *
 * ## The credential is borrowed, never held
 *
 * The key is resolved from the harness's credentials seam at request time and
 * dropped when the request ends. Nothing here writes it to the store, the log,
 * the payload, or a diagnostic. The account's own reference (`apiKeyEnv`) is
 * the only credential-shaped value this module ever names.
 *
 * ## Absence is a fact, not an error
 *
 * A relay has no `/user/balance`. Reporting that as a failure would put a red
 * state on a panel where nothing is wrong, so an unsupported provider answers
 * `supported: false` and the card says so in words.
 *
 * @module dsh-tokenledger/balance
 */

/** The official endpoint's origin, and the only one this module will call. */
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

/**
 * Shape one `/user/balance` response.
 *
 * @param body - the parsed JSON.
 * @returns `{ isAvailable, currency, total, granted, toppedUp }`, each absent
 *   rather than zeroed when the response does not carry it — a balance of
 *   nothing and an unreported balance are different facts.
 */
export function parseBalance(body) {
	const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
	const info = infos.find((entry) => entry?.currency === "CNY") ?? infos[0];
	return {
		isAvailable: body?.is_available === true,
		currency: info?.currency,
		total: info?.total_balance,
		granted: info?.granted_balance,
		toppedUp: info?.topped_up_balance
	};
}

/**
 * Read the balance for the official account.
 *
 * `fetched` rather than `ok` reports whether a balance came back, because the
 * caller wraps this in an envelope whose own `ok` means "the request was
 * served". Spreading one over the other made a served request that simply had
 * no key look like a failed route, and the panel then rendered nothing where it
 * should have said which key was missing.
 *
 * @param options - `{ apiKey, origin?, fetch?, timeoutMs? }`.
 * @returns `{ supported, fetched, ... }`.
 */
export async function readDeepSeekBalance(options = {}) {
	const { apiKey, origin = DEEPSEEK_ORIGIN, timeoutMs = 15_000 } = options;
	const doFetch = options.fetch ?? globalThis.fetch;
	if (typeof apiKey !== "string" || apiKey === "") {
		return { supported: true, fetched: false, reason: "no-credential" };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await doFetch(new URL("/user/balance", origin).href, {
			// Always a header. A key in a query string leaks into browser history,
			// reverse-proxy logs, and every diagnostic that echoes a URL.
			headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
			signal: controller.signal
		});
		if (!response.ok) return { supported: true, fetched: false, reason: `http-${response.status}` };
		return { supported: true, fetched: true, ...parseBalance(await response.json()) };
	} catch (error) {
		return { supported: true, fetched: false, reason: error?.name === "AbortError" ? "timeout" : "unreachable" };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Build the balance reader the HTTP route serves.
 *
 * Walks the host's provider directory for a route addressing DeepSeek's own
 * API, resolves that route's credential reference, and asks. A deployment with
 * no such route is answered plainly rather than with an error.
 *
 * @param ctx - the Cordis context.
 * @param options - `{ readSection, fetch? }`; `readSection` mirrors the one
 *   `discovery.js` takes, so both read provider profiles the same way.
 */
export function createBalanceReader(ctx, options = {}) {
	return async () => {
		const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
		const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
		const credentials = typeof ctx.get === "function" ? ctx.get("credentials") : undefined;
		if (llm === undefined || settings === undefined) {
			return { ok: true, supported: false, reason: "no-provider-directory" };
		}

		const readSection = options.readSection ?? ((ns) => settings.get?.(ns));
		let entries;
		try {
			entries = llm.listConfigurableProviders?.() ?? [];
		} catch {
			return { ok: true, supported: false, reason: "no-provider-directory" };
		}

		for (const entry of entries) {
			let profile;
			try {
				profile = readAt(readSection(entry.settingsNs), entry.settingsPath ?? []);
			} catch {
				continue;
			}
			const baseUrl = profile?.baseURL ?? profile?.baseUrl;
			if (!isOfficialDeepSeek(baseUrl)) continue;

			const reference = profile?.apiKeyEnv;
			const apiKey =
				reference === undefined || credentials === undefined
					? undefined
					: await credentials.resolve?.(reference).then((hit) => hit?.value ?? hit).catch(() => undefined);

			return {
				ok: true,
				provider: entry.provider,
				...(await readDeepSeekBalance({ apiKey, origin: baseUrl || DEEPSEEK_ORIGIN, fetch: options.fetch }))
			};
		}

		// Every route points somewhere else. Not a failure — a relay simply has no
		// balance endpoint of DeepSeek's shape.
		return { ok: true, supported: false, reason: "no-official-route" };
	};
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
