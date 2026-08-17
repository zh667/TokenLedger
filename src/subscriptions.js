/**
 * Vendors that sell a plan rather than a balance.
 *
 * ## What is verified here and what is not
 *
 * Two different things get called "supported", and conflating them is how a
 * feature ships broken. What was checked directly, with an invalid key and a
 * control path that does not exist:
 *
 * - the endpoint is served at that host, and answers JSON
 * - which status code it uses to refuse, and whether that code means anything
 *   (see `balance.js` on the vendors that refuse with a 200)
 *
 * What could **not** be checked without a paying account is the shape of a
 * successful body. Every reader below is therefore written to fail into a
 * stated reason rather than a blank card: if the fields are not where they were
 * expected, the card says so in words a user can forward, and the rest of the
 * panel is untouched. That diagnostic is the feature, not an apology for one —
 * these payloads have no published schema and will drift.
 *
 * ## The rule about units
 *
 * A field whose name contains "percent" is read as 0..100. Not sometimes; the
 * word means that. A vendor that puts a ratio in a field called `percent` is a
 * bug worth surfacing loudly rather than compensating for silently, because the
 * compensation is a guess and the two readings it has to choose between are
 * "almost empty" and "almost full". `quota.js` refuses to guess for the same
 * reason, and nothing here undoes that.
 *
 * @module dsh-tokenledger/subscriptions
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Parse a number a JSON API may have sent as a string. */
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** The first key present on an object, whatever it is spelled. */
function pick(source, ...keys) {
	if (source === null || typeof source !== "object") return undefined;
	for (const key of keys) {
		if (source[key] !== undefined && source[key] !== null) return source[key];
	}
	return undefined;
}

/** A trimmed non-empty string, or undefined. Plan names arrive padded. */
function label(value) {
	const text = typeof value === "string" ? value.trim() : "";
	return text === "" ? undefined : text;
}

/**
 * When a window next empties, in whichever of the two forms it was sent.
 *
 * A duration is handed on as a duration: `quota.js` resolves it against a
 * single injected `now`, so every window on a card agrees about what time it
 * is, and no reader has to reach for the clock itself.
 */
function whenOf(source) {
	const seconds = toNumber(pick(source, "resetInSec", "resetInSeconds", "resetSeconds"));
	if (seconds !== undefined) return { resetInSeconds: seconds };
	const at = pick(source, "resetsAt", "resetAt", "resetTime", "reset_time", "nextReset", "next_reset");
	return at === undefined ? {} : { resetsAt: at };
}

/**
 * A window built from a `{used, limit, remaining}` trio.
 *
 * Common enough across these vendors to be worth one implementation. `limit`
 * with `remaining` is preferred over `limit` with `used`, because a vendor that
 * reports both sometimes zeroes the counter it is not using.
 */
function fromCounts(source, kind, extra = {}) {
	const limit = toNumber(pick(source, "limit", "total", "quota", "total_count", "totalCount"));
	if (limit === undefined || limit <= 0) return undefined;
	const remaining = toNumber(pick(source, "remaining", "remain", "left"));
	if (remaining !== undefined) return { kind, used: limit - remaining, limit, ...extra };
	const used = toNumber(pick(source, "used", "usage", "consumed", "usage_count", "usageCount"));
	return used === undefined ? undefined : { kind, used, limit, ...extra };
}

// --- OpenCode Go ---------------------------------------------------------------

/** Where the OpenCode client keeps the key it was issued. */
const OPENCODE_AUTH_PATH = [".local", "share", "opencode", "auth.json"];

/**
 * One window off the Go usage payload.
 *
 * `percent` is 0..100 by the rule above. Counts are the fallback, not a
 * cross-check: a vendor sending both and disagreeing is not something a client
 * can adjudicate.
 */
function goWindow(source, kind, extra = {}) {
	if (source === null || typeof source !== "object") return undefined;
	const when = whenOf(source);

	const percent = toNumber(pick(source, "percent", "usedPercent", "percentUsed"));
	if (percent !== undefined) return { kind, usedPercent: percent, ...when, ...extra };
	return fromCounts(source, kind, { ...when, ...extra });
}

export const OPENCODE_GO = {
	label: "OpenCode Go",
	/**
	 * Fall back to the key the OpenCode client already holds.
	 *
	 * Only when the route carries no `apiKeyEnv`, only this one path, and only
	 * to the vendor the file belongs to — the key goes back where it came from.
	 * Every failure mode (absent, unreadable, not JSON, different shape) is the
	 * same answer: no credential. The file is not ours and may change without
	 * notice, so it must never be able to turn a working panel into an error.
	 */
	async localCredential({ readFile: read = readFile, homedir: home = homedir } = {}) {
		try {
			const raw = JSON.parse(await read(join(home(), ...OPENCODE_AUTH_PATH), "utf8"));
			const entry = pick(raw, "opencode-go", "opencode");
			return entry?.type === "api" ? label(entry.key) : undefined;
		} catch {
			return undefined;
		}
	},
	async read({ origin, get }) {
		const body = await get(new URL("/zen/go/v1/usage", origin).href);
		const usage = body?.usage ?? body;
		const windows = [
			goWindow(pick(usage, "rolling", "session"), "session"),
			goWindow(pick(usage, "weekly", "week"), "weekly"),
			goWindow(pick(usage, "monthly", "month"), "monthly")
		].filter(Boolean);
		return {
			plan: label(pick(usage, "plan", "planName")) ?? "Go",
			isAvailable: windows.length === 0 ? undefined : windows.every((w) => (w.usedPercent ?? 0) < 100),
			windows,
			...(windows.length === 0 ? { reason: "no rolling/weekly/monthly usage in the response" } : {})
		};
	}
};

// --- Kimi For Coding -----------------------------------------------------------

export const KIMI = {
	label: "Kimi For Coding",
	async read({ origin, get }) {
		const body = await get(new URL("/coding/v1/usages", origin).href);
		const data = body?.data ?? body;

		// The short window arrives as a list, because a plan can carry several
		// rate limits. The first one that yields a usable window is the one the
		// panel can say something true about; the rest have no row to go in.
		const limits = Array.isArray(data?.limits) ? data.limits : [];
		const session = limits
			.map((entry) => {
				const detail = entry?.detail ?? entry;
				return fromCounts(detail, "session", whenOf(detail));
			})
			.find(Boolean);
		const weeklyDetail = pick(data, "usage", "weekly");
		const weekly = fromCounts(weeklyDetail, "weekly", whenOf(weeklyDetail));
		const windows = [session, weekly].filter(Boolean);

		return {
			plan: label(pick(data, "plan", "planName", "plan_name")) ?? "Kimi For Coding",
			isAvailable: windows.length === 0 ? undefined : windows.some((w) => w.used < w.limit),
			windows,
			...(windows.length === 0 ? { reason: "no limits or usage counters in the response" } : {})
		};
	}
};

// --- MiniMax Coding Plan -------------------------------------------------------

/** Which host serves the token-plan route, given the one the route points at. */
const MINIMAX_SIBLING = new Map([
	["api.minimax.io", "www.minimax.io"],
	["www.minimax.io", "api.minimax.io"],
	["api.minimaxi.com", "www.minimaxi.com"],
	["www.minimaxi.com", "api.minimaxi.com"]
]);

/**
 * Chat model names, for finding the entry the plan is actually about.
 *
 * The resource group used to be called `general`. Newer payloads name the entry
 * after the model instead, so matching only `general` loses the whole card —
 * silently, because an empty list is not an error.
 */
const MINIMAX_CHAT_MODEL = /^(minimax|abab|coding-plan)/i;

/**
 * The window status codes, as far as they can be told apart.
 *
 * 1 normal, 2 exhausted, 3 unlimited. Inferred, not published. The important
 * part is what they are used FOR: they decide how a window renders, never
 * whether it renders. Treating "status is 1" as the precondition for showing a
 * window hides it in exactly the two states worth seeing — spent, and
 * unmetered.
 */
function minimaxWindow(entry, prefix, kind, extra = {}) {
	// Payloads have been seen in both spellings, so each field is looked up
	// under `snake_case` and the camelCase of the same words.
	const camel = (text) => text.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
	const at = (suffix) => pick(entry, `${prefix}_${suffix}`, camel(`${prefix}_${suffix}`));
	const status = toNumber(at("status"));
	if (status === 3) return { kind, unlimited: true, ...extra };

	const remainingPercent = toNumber(at("remaining_percent"));
	if (remainingPercent !== undefined) return { kind, remainingPercent, ...extra };

	const total = toNumber(at("total_count"));
	const usage = toNumber(at("usage_count"));
	// Current payloads zero the counters and report only percentages, so a total
	// of zero means "not reported here", not "no allowance".
	if (total !== undefined && total > 0 && usage !== undefined) return { kind, used: usage, limit: total, ...extra };

	// A window whose numbers are all missing is still worth a row when the
	// status says it is spent — that is the state a user most needs to see.
	return status === 2 ? { kind, usedPercent: 100, ...extra } : undefined;
}

export const MINIMAX = {
	label: "MiniMax",
	// Answers HTTP 200 for everything, including a bad key, and puts the verdict
	// in `base_resp`. Verified against all four hosts. Its 404 is a real 404,
	// which is what makes the host fallback below safe.
	envelope: (body) => {
		const code = toNumber(pick(body?.base_resp ?? body?.baseResp, "status_code", "statusCode"));
		if (code === undefined || code === 0) return undefined;
		const message = pick(body?.base_resp ?? body?.baseResp, "status_msg", "statusMsg");
		return { status: code, message: label(message) };
	},
	async read({ origin, get }) {
		const body = await readAcrossHosts(get, origin, "/v1/token_plan/remains");
		const remains = Array.isArray(body?.model_remains)
			? body.model_remains
			: Array.isArray(body?.data?.model_remains)
				? body.data.model_remains
				: [];
		if (remains.length === 0) return { plan: "MiniMax Coding Plan", reason: "response carries no model_remains entries" };

		const nameOf = (entry) => String(pick(entry, "model_name", "modelName") ?? "");
		const chat = remains.find((entry) => nameOf(entry).toLowerCase() === "general") ?? remains.find((entry) => MINIMAX_CHAT_MODEL.test(nameOf(entry)));
		if (chat === undefined) return { plan: "MiniMax Coding Plan", reason: "model_remains has no general or chat-model entry" };

		const windows = [
			minimaxWindow(chat, "current_interval", "session", relativeReset(chat, "remains_time", "remainsTime")),
			minimaxWindow(chat, "current_weekly", "weekly", relativeReset(chat, "weekly_remains_time", "weeklyRemainsTime"))
		].filter(Boolean);

		return {
			plan: "MiniMax Coding Plan",
			isAvailable: windows.length === 0 ? undefined : windows.some((w) => w.unlimited === true || (w.usedPercent ?? 0) < 100),
			windows,
			...(windows.length === 0 ? { reason: "the chat-model entry carries no usable quota fields" } : {})
		};
	}
};

/** `{ resetInMs }` from a "milliseconds remaining" field, if there is one. */
function relativeReset(source, ...keys) {
	const ms = toNumber(pick(source, ...keys));
	return ms === undefined ? {} : { resetInMs: ms };
}

/**
 * Try the route's own host, then its sibling.
 *
 * An account's plan endpoint is not always on the host its inference traffic
 * uses. Only a 404, a 405 or a non-JSON reply moves on — those mean "this host
 * does not serve it". A 401, a 403 or a 429 is a **real answer**: retrying it
 * elsewhere cannot improve on it, and against a rate limiter it turns one
 * refusal into two.
 */
async function readAcrossHosts(get, origin, path) {
	const url = new URL(path, origin);
	const sibling = MINIMAX_SIBLING.get(url.hostname.toLowerCase());
	try {
		return await get(url.href);
	} catch (error) {
		const elsewhere = error?.status === 404 || error?.status === 405 || error?.kind === "invalid-json";
		if (sibling === undefined || !elsewhere) throw error;
		url.hostname = sibling;
		return get(url.href);
	}
}

// --- Z.ai / 智谱 Coding Plan ----------------------------------------------------

/**
 * Z.ai's window-length unit codes, as far as they can be told apart.
 *
 * Inferred rather than published, so an unrecognised code yields no `minutes`
 * at all. The window still renders — under its kind's own name — which is the
 * right way for a guess to fail: losing the label "5-hour" costs a detail,
 * inventing the wrong one costs trust in the number beside it.
 */
const ZAI_UNIT_MINUTES = new Map([
	[5, 1],
	[3, 60],
	[1, 24 * 60],
	[6, 7 * 24 * 60]
]);

/** How long one Z.ai limit's window is, in minutes, when that can be told. */
function zaiMinutes(limit) {
	const per = ZAI_UNIT_MINUTES.get(toNumber(pick(limit, "unit")));
	const count = toNumber(pick(limit, "number"));
	return per === undefined || count === undefined || count <= 0 ? undefined : per * count;
}

/**
 * One limit row turned into window input, or undefined if it carries no fraction.
 *
 * `usage` on these rows is the **allowance**, not the amount consumed — the
 * shared `fromCounts` reads that name the other way round, which is why this
 * vendor spells the arithmetic out instead of reusing it.
 */
function zaiWindow(limit, kind) {
	if (limit === null || typeof limit !== "object") return undefined;
	const minutes = zaiMinutes(limit);
	const at = pick(limit, "nextResetTime", "next_reset_time");
	const extra = { ...(minutes === undefined ? {} : { minutes }), ...(at === undefined ? {} : { resetsAt: at }) };

	const total = toNumber(pick(limit, "usage", "limit", "total"));
	const remaining = toNumber(pick(limit, "remaining"));
	const current = toNumber(pick(limit, "currentValue", "current_value"));
	if (total !== undefined && total > 0) {
		const used = remaining !== undefined ? total - remaining : current;
		if (used !== undefined) return { kind, used, limit: total, ...extra };
	}

	const percent = toNumber(pick(limit, "percentage", "usedPercent", "used_percent"));
	return percent === undefined ? undefined : { kind, usedPercent: percent, ...extra };
}

const ZAI_TOKEN_LIMITS = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/**
 * The Coding Plan's quota windows, and what the plan is called.
 *
 * Read alongside the wallet balance rather than instead of it: this vendor
 * sells both, and an account can be holding a plan and a top-up at once. Either
 * half failing leaves the other one showing.
 */
export async function readZaiCodingPlan({ origin, get }) {
	const quota = await get(new URL("/api/monitor/usage/quota/limit", origin).href, { raw: true });
	const limits = Array.isArray(quota?.data?.limits) ? quota.data.limits : [];
	const typeOf = (limit) => String(pick(limit, "type", "limit_type") ?? "").toUpperCase();

	// Sorted shortest-first so the rolling window and the long one land in the
	// right rows whatever order they arrived in.
	const token = limits
		.filter((limit) => ZAI_TOKEN_LIMITS.has(typeOf(limit)))
		.sort((a, b) => (zaiMinutes(a) ?? Number.MAX_SAFE_INTEGER) - (zaiMinutes(b) ?? Number.MAX_SAFE_INTEGER));

	const windows = [
		zaiWindow(token[0], "session"),
		token.length > 1 ? zaiWindow(token[token.length - 1], "weekly") : undefined,
		zaiWindow(limits.find((limit) => typeOf(limit) === "TIME_LIMIT"), "billing")
	].filter(Boolean);

	// The plan's name lives on a second route. It is a label, so its absence
	// must not cost the quota that was already read.
	let plan;
	try {
		const subscription = await get(new URL("/api/biz/subscription/list", origin).href, { raw: true });
		const row = Array.isArray(subscription?.data) ? subscription.data[0] : subscription?.data;
		plan = label(pick(row, "product_name", "productName", "plan_name", "planName", "package_name", "packageName"));
	} catch {
		// A plan with no name is still a plan.
	}

	return { windows, plan };
}
