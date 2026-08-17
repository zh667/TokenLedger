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
 * ## A 200 is not a yes
 *
 * Some vendors answer every request with HTTP 200 and put the refusal in the
 * body. Z.ai does it even for a path that does not exist, so its status code
 * carries no information at all. Reading only `response.ok` there parses the
 * refusal as data, finds none of the fields it wanted, and renders a card that
 * says the account is empty — which is the one thing this module promises never
 * to do. A scheme whose vendor works that way declares an `envelope`.
 *
 * @module dsh-tokenledger/balance
 */

import { detectRelaySoftware } from "./adapters/detect.js";
import { compileEndpoint, indexEndpoints } from "./declarative.js";
import { normalizeWindows } from "./quota.js";
import { normalizeOrigin } from "./relay-sites.js";
import { KIMI, MINIMAX, OPENCODE_GO, readZaiCodingPlan } from "./subscriptions.js";

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

/**
 * Origins whose balance is an account fact, keyed by hostname.
 *
 * These are vendors, not relays, so nothing is fingerprinted: the origin names
 * the scheme outright. They also collapse per origin the way DeepSeek does —
 * two routes pointing at one vendor share one wallet, unlike two keys on one
 * relay, which hold two separate quotas.
 *
 * `currency` is the denomination the vendor bills in where the response does
 * not carry one; a currency the body reports always wins. It is declared only
 * for the single-currency regional endpoints, because a number rendered under
 * the wrong symbol is worse than a number rendered under none.
 */
const VENDORS = new Map([
	["api.deepseek.com", { scheme: "deepseek", displayName: "DeepSeek" }],
	["openrouter.ai", { scheme: "openrouter", displayName: "OpenRouter" }],
	["api.moonshot.cn", { scheme: "moonshot", displayName: "Moonshot", currency: "CNY" }],
	["api.moonshot.ai", { scheme: "moonshot", displayName: "Moonshot" }],
	["api.z.ai", { scheme: "zai", displayName: "Z.ai" }],
	["open.bigmodel.cn", { scheme: "zai", displayName: "智谱 GLM", currency: "CNY" }],
	// Plan vendors. No wallet to read — see `subscriptions.js`.
	["opencode.ai", { scheme: "opencode-go", displayName: "OpenCode Go" }],
	["api.kimi.com", { scheme: "kimi", displayName: "Kimi For Coding" }],
	["api.minimax.io", { scheme: "minimax", displayName: "MiniMax" }],
	["www.minimax.io", { scheme: "minimax", displayName: "MiniMax" }],
	["api.minimaxi.com", { scheme: "minimax", displayName: "MiniMax", currency: "CNY" }],
	["www.minimaxi.com", { scheme: "minimax", displayName: "MiniMax", currency: "CNY" }]
]);

/**
 * The vendor a provider profile addresses, if it is one we can read.
 *
 * Matched on the origin rather than on the route name, for the same reason site
 * attribution is: a route called `deepseek` may point anywhere, and a route
 * called anything may point at DeepSeek.
 */
export function vendorOf(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl === "") return VENDORS.get("api.deepseek.com");
	try {
		return VENDORS.get(new URL(baseUrl).hostname.toLowerCase());
	} catch {
		return undefined;
	}
}

/** How many hops to follow before giving up on a same-origin redirect loop. */
const MAX_REDIRECTS = 3;

/**
 * Fetch, following redirects only while they stay on the same origin.
 *
 * The default `follow` sends the Authorization header wherever the redirect
 * points, so a relay that answers `302 https://collector.example/` is handed
 * the user's key. That is the cheapest way around every other rule this module
 * has, and it costs one option to close: take the hops manually and stop at the
 * first one that changes origin.
 *
 * A stub `fetch` in a test returns no `status` and no `headers`, so the 3xx
 * branch is simply never entered.
 */
async function fetchNoCrossOriginRedirect(doFetch, url, init) {
	let current = url;
	for (let hop = 0; ; hop++) {
		const response = await doFetch(current, { ...init, redirect: "manual" });
		const status = response?.status;
		if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return response;

		const location = response.headers?.get?.("location");
		if (location === undefined || location === null || location === "" || hop >= MAX_REDIRECTS) {
			throw Object.assign(new Error(`http-${status}`), { status });
		}
		const next = new URL(location, current);
		if (next.origin !== new URL(current).origin) {
			// Not a transport failure — a refusal to hand the credential over.
			throw Object.assign(new Error("cross-origin-redirect"), { kind: "cross-origin-redirect" });
		}
		current = next.href;
	}
}

/**
 * Read a response body with a byte ceiling.
 *
 * A declared endpoint is not one of ours, so its answer is not assumed to be a
 * reasonable size. Streamed where the runtime gives us a reader — which is what
 * actually bounds the cost — and length-checked otherwise, which at least
 * bounds the parse.
 */
async function readCapped(response, maxBytes) {
	const tooLarge = () => Object.assign(new Error("response-too-large"), { kind: "too-large" });

	const reader = response.body?.getReader?.();
	if (reader === undefined || reader === null) {
		const text = await response.text();
		if (text.length > maxBytes) throw tooLarge();
		return text;
	}

	const chunks = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => {});
			throw tooLarge();
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** A trimmed non-empty string, or undefined. */
function label(value) {
	const text = typeof value === "string" ? value.trim() : "";
	return text === "" ? undefined : text;
}

/**
 * Sub2API's per-key rate-limit windows.
 *
 * The gateway names its windows by duration. `5h` is the only one whose length
 * is worth carrying: `daily` and `weekly` already say how long they are, and a
 * length there would only repeat the label.
 */
const SUB2API_WINDOWS = new Map([
	["5h", { kind: "session", minutes: 300 }],
	["1d", { kind: "daily" }],
	["7d", { kind: "weekly" }]
]);

function sub2apiRateLimits(list) {
	if (!Array.isArray(list)) return [];
	return list
		.map((entry) => {
			const shape = SUB2API_WINDOWS.get(entry?.window);
			if (shape === undefined) return undefined;
			return {
				...shape,
				used: toNumber(entry.used),
				limit: toNumber(entry.limit),
				// Absent once the window has lapsed, which is the gateway saying
				// the next request starts a fresh one. Nothing to show.
				...(entry.reset_at === undefined || entry.reset_at === null ? {} : { resetsAt: entry.reset_at })
			};
		})
		.filter(Boolean);
}

/** One week after a window opened, which is when Sub2API rolls it over. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sub2API's subscription periods.
 *
 * A limit that is null means the group does not cap that period; `quota.js`
 * drops a window with no positive limit, so those disappear on their own rather
 * than being drawn as empty bars.
 */
function sub2apiPeriods(subscription) {
	if (subscription === null || typeof subscription !== "object") return [];
	const openedAt = Date.parse(subscription.weekly_window_start ?? "");
	return [
		{ kind: "daily", used: subscription.daily_usage_usd, limit: subscription.daily_limit_usd },
		{
			kind: "weekly",
			used: subscription.weekly_usage_usd,
			limit: subscription.weekly_limit_usd,
			// The gateway reports when the window OPENED; the panel asks when it
			// frees up. Only the second is worth showing.
			...(Number.isNaN(openedAt) ? {} : { resetsAt: new Date(openedAt + WEEK_MS).toISOString() })
		},
		{ kind: "monthly", used: subscription.monthly_usage_usd, limit: subscription.monthly_limit_usd }
	];
}

/** Host for display, carrying a non-default port so two on one machine differ. */
function hostLabel(origin) {
	const url = new URL(origin);
	return url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
}

/**
 * Parse a number an API may send as a string.
 *
 * Named for its direction. `report.js` exports a `num` that goes the other way
 * — number to display string, with an em dash for absent — and two functions
 * called `num` that are inverses of each other is a trap for whoever reads the
 * second one expecting the first.
 */
function toNumber(value) {
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
 * `{ currency, total, granted, used, unlimited?, plan?, windows?, note? }`,
 * with every field absent rather than zeroed when the response does not carry
 * it. A balance of nothing and an unreported balance are different facts, and
 * showing the second as the first tells someone their account is empty.
 *
 * The card has two halves and they are not alternatives. `total` and friends
 * are money; `windows` is a subscription's rolling allowances (see `quota.js`).
 * An account can have both — a plan with a top-up wallet behind it is ordinary
 * — so what is rendered is decided by which fields are present, never by a mode
 * flag that would force a choice reality does not make.
 *
 * A reader returns windows in whatever unit its vendor speaks; `readBalance`
 * normalizes them.
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
				total: toNumber(info?.total_balance),
				granted: toNumber(info?.granted_balance),
				toppedUp: toNumber(info?.topped_up_balance)
			};
		}
	},

	openrouter: {
		label: "OpenRouter",
		// `/api/v1/credits` wants a **Management Key**, not the `sk-or-v1-` key
		// that serves inference. The route's own key therefore answers 401 here
		// for most people, which is a missing capability rather than a fault —
		// hence the hint, so the card can say which key is wanted.
		unauthorizedHint: "openrouter-management-key",
		async read({ origin, get }) {
			const body = await get(new URL("/api/v1/credits", origin).href);
			const granted = toNumber(body?.data?.total_credits);
			const used = toNumber(body?.data?.total_usage);
			const total = granted !== undefined && used !== undefined ? granted - used : undefined;
			return {
				isAvailable: total === undefined ? undefined : total > 0,
				currency: "USD",
				total,
				used,
				granted
			};
		}
	},

	moonshot: {
		label: "Moonshot",
		async read({ origin, get, vendor }) {
			const body = await get(new URL("/v1/users/me/balance", origin).href);
			const data = body?.data;
			const total = toNumber(data?.available_balance);
			return {
				isAvailable: total === undefined ? undefined : total > 0,
				currency: typeof data?.currency === "string" ? data.currency : vendor?.currency,
				total,
				granted: toNumber(data?.voucher_balance),
				toppedUp: toNumber(data?.cash_balance)
			};
		}
	},

	zai: {
		label: "Z.ai",
		// Auth here happens before routing: a bad key gets HTTP 200 and
		// `{"code":401,"msg":"token expired or incorrect","success":false}`, and
		// so does a path that was never served. The status line is therefore
		// worthless and the body is the only place the answer lives.
		envelope: (body) => {
			// `success` is the explicit signal. `code` only supplies the number,
			// and only when it disagrees with both success conventions — a live
			// account must never be reported as refused because its success code
			// was spelled 0 rather than 200.
			const code = typeof body?.code === "number" ? body.code : undefined;
			const refused = body?.success === false || (code !== undefined && code !== 0 && code !== 200);
			return refused ? { status: code, message: typeof body?.msg === "string" ? body.msg : undefined } : undefined;
		},
		// This vendor sells both a wallet and a Coding Plan, and an account can
		// hold both at once, so both are read and either may fail alone. A plan
		// user with an empty wallet must not see an empty card, and a wallet user
		// with no plan must not see the balance disappear because a second route
		// answered 404.
		async read({ origin, get, vendor }) {
			const [wallet, plan] = await Promise.allSettled([
				get(new URL("/api/paas/v4/balance", origin).href),
				readZaiCodingPlan({ origin, get })
			]);
			if (wallet.status === "rejected" && plan.status === "rejected") throw wallet.reason;

			const data = wallet.status === "fulfilled" ? wallet.value?.data : undefined;
			const available = toNumber(data?.available_balance);
			const total = toNumber(data?.total_balance) ?? available;
			const coding = plan.status === "fulfilled" ? plan.value : undefined;
			const windows = coding?.windows ?? [];

			return {
				isAvailable:
					total !== undefined
						? total > 0
						: windows.length === 0
							? undefined
							: windows.some((w) => w.unlimited === true || (w.usedPercent ?? 0) < 100),
				currency: typeof data?.currency === "string" ? data.currency : vendor?.currency,
				total: available ?? total,
				granted: total,
				...(coding?.plan === undefined ? {} : { plan: coding.plan }),
				windows
			};
		}
	},

	"opencode-go": OPENCODE_GO,
	kimi: KIMI,
	minimax: MINIMAX,

	newapi: {
		label: "New API",
		async read({ origin, get }) {
			// The trailing slash is load-bearing: without it New API answers 301,
			// and a redirect drops the Authorization header on some clients.
			const body = await get(new URL("/api/usage/token/", origin).href);
			const data = body?.data ?? {};
			const granted = toNumber(data.total_granted);
			const used = toNumber(data.total_used);
			const available = toNumber(data.total_available);

			// Quota is an internal integer, and `quota_per_unit` is the site's own
			// divisor for turning it into **USD** — which is what New API's own
			// wallet page shows. `price` is a different number: the local-currency
			// price of one unit at top-up time. Treating a present `price` as
			// "this site bills in CNY" put a ¥ in front of a dollar figure.
			let scale;
			try {
				const status = (await get(new URL("/api/status", origin).href, { anonymous: true }))?.data ?? {};
				const perUnit = toNumber(status.quota_per_unit);
				if (perUnit !== undefined && perUnit > 0) scale = 1 / perUnit;
			} catch {
				// A site that will not describe its own units still has a quota.
			}

			// Rounded like the billing adapter does: 752600/500000 is 1.5052, and
			// binary floating point renders it 1.5051999999999999 on a card.
			const money = (quota) =>
				quota === undefined || scale === undefined ? undefined : Math.round(quota * scale * 1e6) / 1e6;
			const unlimited = data.unlimited_quota === true;
			return {
				isAvailable: unlimited || (available ?? 0) > 0,
				unlimited,
				currency: scale === undefined ? undefined : "USD",
				// An unlimited key has no remaining quota to report, and New API
				// does not leave the field empty — it decrements from zero, so
				// `total_available` comes back as the negated usage. Shown as a
				// balance that is a negative number meaning nothing. The account's
				// actual wallet is behind user auth, which a token key does not
				// have, so the honest answer is what this key has SPENT.
				total: unlimited ? undefined : money(available),
				granted: unlimited ? undefined : money(granted),
				used: money(used),
				// Kept beside the money so a site with no published units still
				// shows something true.
				quota: unlimited ? { used } : { granted, used, available },
				// The key's own name, which the site's console shows beside every
				// row. With several keys on one relay it is the only thing that
				// says which one this card is about.
				keyName: typeof data.name === "string" && data.name !== "" ? data.name : undefined,
				// 0 means "never" in New API's shape, not "expired at the epoch".
				expiresAt: toNumber(data.expires_at) || undefined
			};
		}
	},

	sub2api: {
		label: "Sub2API",
		/**
		 * `/v1/usage` answers in one of three shapes, and only one of them has a
		 * `balance`.
		 *
		 * - **quota_limited** — the key carries a total quota, or per-window rate
		 *   limits, or both. Read against the gateway's own handler: `quota`
		 *   holds the money, `rate_limits[]` holds one entry per configured
		 *   window (`5h`, `1d`, `7d`) with a `reset_at` that is only present
		 *   while the window is still open.
		 * - **unrestricted + subscription** — no key-level limit, but the key's
		 *   group is a plan. The periods live under `subscription` as paired
		 *   `*_usage_usd` / `*_limit_usd` figures, and there is no `balance`.
		 * - **unrestricted + wallet** — the original shape, and the only one that
		 *   sends `balance`.
		 *
		 * The previous reader knew only the third. On the other two it found no
		 * `balance`, reported no amount, and dropped the windows on the floor —
		 * a plan user saw a card with nothing on it. `remaining` was read and
		 * then never rendered anywhere, which is why nobody noticed.
		 */
		async read({ origin, get }) {
			const body = await get(new URL("/v1/usage", origin).href);
			const currency = typeof body?.unit === "string" ? body.unit : undefined;

			// `isValid` stays true for a key that is out of quota or past its
			// expiry — upstream means "we recognise this key", not "you can spend
			// on it". The card's green/amber line is about the latter.
			const status = typeof body?.status === "string" ? body.status : undefined;
			const usable = body?.isValid !== false && status !== "quota_exhausted" && status !== "expired" && status !== "disabled";

			const subscription = body?.subscription;
			const quota = body?.quota;
			const windows = [...sub2apiRateLimits(body?.rate_limits), ...sub2apiPeriods(subscription)];

			// -1 is the gateway's "no period limit is configured", not a debt.
			const remaining = toNumber(body?.remaining);
			const unlimited = subscription !== undefined && remaining === -1;

			const amount = quota !== undefined
				? { total: toNumber(quota.remaining), granted: toNumber(quota.limit), used: toNumber(quota.used) }
				: subscription !== undefined
					? { total: unlimited ? undefined : remaining }
					: { total: toNumber(body?.balance) };

			return {
				isAvailable: usable,
				currency,
				...amount,
				...(unlimited ? { unlimited: true } : {}),
				// Only a real plan gets a plan line. The wallet shape sends a
				// `planName` too, and it is a placeholder — rendering it produces
				// a card that says the account is on a plan called "wallet".
				...(subscription === undefined ? {} : { plan: label(body?.planName) }),
				windows
			};
		}
	}
};

/**
 * Read one account.
 *
 * @param options - `{ scheme, origin, apiKey, fetch?, timeoutMs?, now? }`.
 *   `now` is only used to resolve relative reset times into instants, and is
 *   injectable so a test does not have to race the clock.
 * @returns `{ supported, fetched, ... }`. `fetched` rather than `ok` because
 *   the caller wraps this in an envelope whose own `ok` means "the request was
 *   served"; spreading one over the other made a served request that simply had
 *   no key look like a failed route.
 */
export async function readBalance(options = {}) {
	const { scheme, origin, timeoutMs = 15_000 } = options;
	// A compiled declaration is passed in rather than registered, because
	// registering it would let it collide with — or replace — a built-in name.
	const spec = options.spec ?? SCHEMES[scheme];
	if (spec === undefined) return { supported: false, reason: "unknown-software" };

	// A scheme may know where its vendor's own client already keeps a key. Only
	// consulted when the route carries none, and only ever able to say "no
	// credential" on failure — see `localCredential` on the scheme.
	let apiKey = options.apiKey;
	if ((typeof apiKey !== "string" || apiKey === "") && spec.localCredential !== undefined) {
		apiKey = await spec.localCredential(options).catch(() => undefined);
	}
	if (typeof apiKey !== "string" || apiKey === "") {
		return { supported: true, fetched: false, reason: "no-credential" };
	}

	const doFetch = options.fetch ?? globalThis.fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	/**
	 * @param options - `{ anonymous }` sends no credential at all; `{ raw }`
	 *   sends the key without the `Bearer` prefix, which some vendors' console
	 *   routes want even though their inference API does not. Either way the key
	 *   rides the Authorization header and never a query string.
	 */
	const get = async (url, options = {}) => {
		const { anonymous = false, raw = false, maxBytes } = options;
		const response = await fetchNoCrossOriginRedirect(doFetch, url, {
			headers: anonymous
				? { accept: "application/json" }
				: { authorization: raw ? apiKey : `Bearer ${apiKey}`, accept: "application/json" },
			signal: controller.signal
		});
		if (!response.ok) throw Object.assign(new Error(`http-${response.status}`), { status: response.status });
		let body;
		try {
			body = maxBytes === undefined ? await response.json() : JSON.parse(await readCapped(response, maxBytes));
		} catch (error) {
			if (error?.kind === "too-large") throw error;
			// A host that answers HTML where JSON was asked for is not serving
			// this route. Marked rather than thrown bare, so a reader that has a
			// second host to try can tell that apart from a real refusal.
			throw Object.assign(new Error("invalid-json"), { kind: "invalid-json" });
		}
		// Run before the reader sees it, so a refusal can never be mistaken for a
		// response whose fields all happen to be missing.
		const refusal = spec.envelope?.(body);
		if (refusal === undefined) return body;
		throw Object.assign(new Error(refusal.message ?? `upstream-${refusal.status ?? "error"}`), {
			status: refusal.status,
			// Distinguishes "the vendor said no in the body" from "the transport
			// said no in the status line". Both are failures; only one of them
			// means the status code meant anything.
			fromEnvelope: true
		});
	};

	try {
		const read = await spec.read({ origin, get, vendor: vendorOf(origin) });
		// Normalized here rather than in each reader, so a scheme describes what
		// its vendor sent ("a ratio", "seconds from now") and never has to get
		// the arithmetic right a fifth time. `windows` stays absent when there
		// are none — an empty array would claim a subscription with nothing in
		// it, which is the same lie as reporting an unread balance as zero.
		const result = { supported: true, fetched: true, scheme, ...read };
		const windows = normalizeWindows(read.windows, { now: options.now ?? Date.now() });
		if (windows === undefined) delete result.windows;
		else result.windows = windows;
		return result;
	} catch (error) {
		const reason =
			error?.fromEnvelope === true
				? `upstream-${error.status ?? "error"}`
				: error?.status !== undefined
					? `http-${error.status}`
					: error?.kind === "invalid-json"
						? "invalid-response"
						: // These three are refusals by this module, not by the
							// endpoint, and the card has to be able to say which.
							error?.kind === "cross-origin-redirect" || error?.kind === "too-large" || error?.kind === "declaration"
							? error.kind
							: error?.name === "AbortError"
								? "timeout"
								: "unreachable";
		// A scheme whose endpoint wants a different credential from the one the
		// route carries says so, rather than leaving the card on a bare 401 that
		// reads as "your key is wrong".
		const hint = error?.status === 401 || error?.status === 403 ? spec.unauthorizedHint : undefined;
		return { supported: true, fetched: false, scheme, reason, ...(hint === undefined ? {} : { hint }) };
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

	// One entry per ROUTE, not per origin.
	//
	// An earlier version collapsed routes sharing a host, on the reasoning that
	// two keys on one relay share a wallet. That holds for DeepSeek, whose
	// balance is an account fact, and not for the relays: New API's
	// `/api/usage/token/` and Sub2API's `/v1/usage` are both scoped to the key
	// that asked. Merging them showed one key's spend under the site's name and
	// silently hid the other.
	//
	// DeepSeek is still collapsed, because there the account really is the unit.
	const seenVendor = new Set();
	const perHost = new Map();
	const out = [];
	for (const entry of entries) {
		let profile;
		try {
			profile = readAt(readSection(entry.settingsNs), entry.settingsPath ?? []);
		} catch {
			continue;
		}
		const baseUrl = profile?.baseURL ?? profile?.baseUrl;
		const vendor = vendorOf(baseUrl);
		const origin = isOfficialDeepSeek(baseUrl) ? (normalizeOrigin(baseUrl) ?? DEEPSEEK_ORIGIN) : normalizeOrigin(baseUrl);
		if (origin === undefined) continue;
		// Vendors collapse per origin: two routes at one vendor draw on one
		// wallet. Relays do not — there the quota belongs to the key.
		if (vendor !== undefined) {
			if (seenVendor.has(origin)) continue;
			seenVendor.add(origin);
		}
		// Keyed by ORIGIN, not hostname: two relays on one machine differ only by
		// port, and a hostname key had the second inherit the first's software.
		const host = hostLabel(origin);
		perHost.set(host, (perHost.get(host) ?? 0) + 1);

		out.push({
			id: entry.provider,
			route: entry.provider,
			host,
			displayName: vendor?.displayName ?? host,
			origin,
			// Unknown until something asks — relay software is fingerprinted
			// lazily, when a balance is actually requested for that site. A
			// vendor needs no probe: its origin names its scheme.
			scheme: vendor?.scheme ?? softwareOf.get(origin),
			hasCredential: typeof profile?.apiKeyEnv === "string" && profile.apiKeyEnv !== ""
		});
	}

	// Name the route only where the host alone would be ambiguous. Two keys on
	// one relay are two quotas, and a picker offering the same label twice
	// cannot be used to choose between them.
	for (const account of out) {
		if ((perHost.get(account.host) ?? 0) > 1) account.displayName = `${account.host} · ${account.route}`;
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
					options.learnSoftware?.(account.origin, scheme);
				}
			} catch {
				// Leave it unknown; the answer below says so.
			}
		}
		// A user declaration is the last thing consulted, never the first. It
		// cannot shadow a built-in scheme, so declaring an endpoint can add a
		// vendor and can never change how a known one is read.
		let declared;
		if (scheme === undefined || SCHEMES[scheme] === undefined) {
			declared = compileEndpoint(indexEndpoints(options.endpoints).get(account.origin));
			if (declared === undefined) {
				return { ok: true, account: account.id, supported: false, reason: "unknown-software" };
			}
			scheme = "declared";
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
			...(await readBalance({ scheme, spec: declared, origin: account.origin, apiKey, fetch: options.fetch })),
			// So the card can say the numbers came out of paths the user wrote.
			// A wrong path is a configuration mistake, and that has to be
			// distinguishable from the plugin getting a known vendor wrong.
			...(declared === undefined ? {} : { declared: true })
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
