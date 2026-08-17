/**
 * Rolling quota windows, normalized into one shape.
 *
 * ## What a window is
 *
 * A subscription account holds no money. It holds several independent
 * allowances — five hours, a week, a month — each of which fills up and empties
 * on its own clock. Knowing "the 5-hour window is 4% used and resets at 04:17"
 * is the whole reason someone opens the panel, and the money-shaped envelope in
 * `balance.js` has nowhere to put it: pick one window for `total` and the other
 * two vanish.
 *
 * ## Why the caller says which unit it is sending
 *
 * The upstreams disagree about what a percentage is. Some send `0.04`, some
 * send `4`, some send neither and leave you to divide `used` by `limit`. A
 * reader that guesses from the magnitude gets it right almost always and wrong
 * exactly where it matters: `0.04` is a plausible 0.04% and `4` is a plausible
 * 4-in-100 ratio, so a nearly-empty window and a nearly-full one are the two
 * cases the guess cannot separate.
 *
 * So there is no guess. `usedPercent` means 0..100, `usedRatio` means 0..1,
 * `remainingPercent` is the complement, and `used`/`limit` are counts. Each
 * scheme knows which one its vendor sends, and says so.
 *
 * ## Why relative times are resolved here
 *
 * "Resets in 3600 seconds" is only true at the instant it was read. Carried
 * into a cache, a refresh interval, or a re-render, it silently becomes a lie.
 * `now` is injected so this stays testable, and the stored value is always an
 * absolute instant.
 *
 * @module dsh-tokenledger/quota
 */

/**
 * The window shapes the panel can name.
 *
 * Deliberately short. An upstream's own enum ("ROLLING_5H", "TIME_LIMIT") must
 * not reach the interface — a label nobody can read is worse than none — so a
 * kind outside this list drops the window rather than rendering its raw name.
 * The order is the display order: shortest clock first, because that is the one
 * that stops you working.
 */
export const WINDOW_KINDS = ["session", "weekly", "monthly", "billing"];

/** Parse a number a JSON API may have sent as a string. */
function toNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/** 0..100, one decimal. Percentages are read, not computed against. */
function clampPercent(value) {
	if (value === undefined) return undefined;
	return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/**
 * How full the window is, from whichever of the four forms the caller sent.
 *
 * Order matters only in that each form is checked for presence, never for
 * plausibility: a vendor sending `usedPercent: 0` means zero, and falling
 * through to `used`/`limit` because zero is falsy is how a fresh window ends up
 * rendered as unknown.
 */
function usedPercentOf(input) {
	const direct = toNumber(input.usedPercent);
	if (direct !== undefined) return clampPercent(direct);

	const ratio = toNumber(input.usedRatio);
	if (ratio !== undefined) return clampPercent(ratio * 100);

	const remaining = toNumber(input.remainingPercent);
	if (remaining !== undefined) return clampPercent(100 - remaining);

	const used = toNumber(input.used);
	const limit = toNumber(input.limit);
	// A limit of zero is not a full window, it is an unreported one. Dividing by
	// it yields Infinity, which clamps to 100 and tells the user they are out.
	if (used !== undefined && limit !== undefined && limit > 0) return clampPercent((used / limit) * 100);

	return undefined;
}

/**
 * When the window next empties, as an absolute instant.
 *
 * Accepts an instant (`resetsAt`) or a duration from now (`resetInSeconds` /
 * `resetInMs`). Epoch numbers are disambiguated by magnitude, which is safe
 * here in a way the percentage guess was not: the ambiguous range is instants
 * before 1970 or after the year 5138.
 */
function resetsAtOf(input, now) {
	const seconds = toNumber(input.resetInSeconds);
	if (seconds !== undefined && seconds >= 0) return new Date(now + seconds * 1000).toISOString();

	const ms = toNumber(input.resetInMs);
	if (ms !== undefined && ms >= 0) return new Date(now + ms).toISOString();

	const at = input.resetsAt;
	if (at === undefined || at === null || at === "") return undefined;

	const epoch = toNumber(at);
	const date = epoch === undefined ? new Date(String(at)) : new Date(epoch < 1e11 ? epoch * 1000 : epoch);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The window's own length in minutes, when the upstream reports it.
 *
 * Separate from `kind` because the interface has to be able to say "5-hour
 * window" without inventing it. Plans differ — three hours here, five there —
 * and a `session` label hard-coded to five hours is a number the panel made up.
 * Absent, the panel falls back to naming the kind.
 */
function minutesOf(input) {
	const minutes = toNumber(input.minutes);
	return minutes !== undefined && minutes > 0 ? Math.round(minutes) : undefined;
}

/**
 * One window, or `undefined` when the input cannot make one.
 *
 * @param input - `{ kind, usedPercent | usedRatio | remainingPercent | (used +
 *   limit), unlimited?, resetsAt | resetInSeconds | resetInMs, minutes? }`.
 * @param options - `{ now }`, milliseconds, injected so tests do not race.
 */
export function quotaWindow(input, options = {}) {
	if (input === null || typeof input !== "object") return undefined;
	if (!WINDOW_KINDS.includes(input.kind)) return undefined;

	const now = options.now ?? Date.now();
	const resetsAt = resetsAtOf(input, now);
	const minutes = minutesOf(input);
	const shared = { kind: input.kind, ...(minutes === undefined ? {} : { minutes }), ...(resetsAt === undefined ? {} : { resetsAt }) };

	// An unlimited window has no fraction to show and is not the same fact as an
	// empty one. It keeps its row — "unlimited" is worth saying — but carries no
	// percentage, so nothing downstream can render it as a bar at 0%.
	if (input.unlimited === true) return { ...shared, unlimited: true };

	const usedPercent = usedPercentOf(input);
	return usedPercent === undefined ? undefined : { ...shared, usedPercent };
}

/**
 * A scheme's windows, cleaned and ordered.
 *
 * Unusable entries are dropped rather than rendered as blanks, one kind appears
 * at most once (the first wins, so a reader can list its best source first),
 * and the order is `WINDOW_KINDS` regardless of the order they arrived in —
 * two accounts of the same plan must not lay their rows out differently.
 */
export function normalizeWindows(list, options = {}) {
	if (!Array.isArray(list)) return undefined;

	const byKind = new Map();
	for (const entry of list) {
		const window = quotaWindow(entry, options);
		if (window !== undefined && !byKind.has(window.kind)) byKind.set(window.kind, window);
	}

	// Absent rather than empty: `windows: []` would make a card claim to be a
	// subscription account with nothing in it, which is the same mistake as
	// reporting an unread balance as zero.
	if (byKind.size === 0) return undefined;
	return WINDOW_KINDS.filter((kind) => byKind.has(kind)).map((kind) => byKind.get(kind));
}
