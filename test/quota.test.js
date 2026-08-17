/**
 * Rolling quota windows.
 *
 * Every test here is about one of two mistakes. The first is guessing what unit
 * a number is in, which works until it meets the one account where the guess is
 * wrong. The second is turning "cannot tell" into a confident zero, which is
 * how a panel ends up telling someone their allowance is untouched when it has
 * actually run out.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { WINDOW_KINDS, normalizeWindows, quotaWindow } from "../src/quota.js";

/** A fixed clock, so relative resets land somewhere assertable. */
const NOW = Date.UTC(2026, 7, 17, 12, 0, 0);
const at = (ms) => new Date(NOW + ms).toISOString();

// --- how full ----------------------------------------------------------------

test("each way of saying how full a window is arrives at the same number", () => {
	const forms = [
		{ usedPercent: 40 },
		{ usedRatio: 0.4 },
		{ remainingPercent: 60 },
		{ used: 400, limit: 1000 }
	];
	for (const form of forms) {
		const window = quotaWindow({ kind: "session", ...form }, { now: NOW });
		assert.equal(window.usedPercent, 40, JSON.stringify(form));
	}
});

test("the unit is declared, never inferred from the magnitude", () => {
	// This is the whole reason the four forms are separate fields. A reader that
	// guesses gets `4` and `0.04` exactly backwards half the time, and those are
	// a nearly-full window and a nearly-empty one — the two cases where being
	// wrong actually costs someone something.
	assert.equal(quotaWindow({ kind: "session", usedPercent: 4 }, { now: NOW }).usedPercent, 4);
	assert.equal(quotaWindow({ kind: "session", usedRatio: 4 }, { now: NOW }).usedPercent, 100, "clamped, not reinterpreted");
	assert.equal(quotaWindow({ kind: "session", usedRatio: 0.04 }, { now: NOW }).usedPercent, 4);
	assert.equal(quotaWindow({ kind: "session", usedPercent: 0.04 }, { now: NOW }).usedPercent, 0, "0.04% rounds to 0.0");
});

test("a window at zero is reported as zero, not as unknown", () => {
	// `usedPercent: 0` is falsy. Falling through to the next form because of
	// that renders a fresh window as if nothing could be read from it.
	const window = quotaWindow({ kind: "weekly", usedPercent: 0, used: 999, limit: 1000 }, { now: NOW });
	assert.equal(window.usedPercent, 0);
});

test("a limit of zero is an unreported window, not a full one", () => {
	// Dividing by it gives Infinity, which clamps to 100 and tells the user they
	// are out of allowance on a plan whose size the vendor simply did not send.
	assert.equal(quotaWindow({ kind: "session", used: 5, limit: 0 }, { now: NOW }), undefined);
	assert.equal(quotaWindow({ kind: "session", used: 5 }, { now: NOW }), undefined, "a count with no limit is not a fraction");
});

test("percentages are clamped and kept to one decimal", () => {
	assert.equal(quotaWindow({ kind: "session", usedPercent: 143 }, { now: NOW }).usedPercent, 100);
	assert.equal(quotaWindow({ kind: "session", usedPercent: -8 }, { now: NOW }).usedPercent, 0);
	assert.equal(quotaWindow({ kind: "session", used: 1, limit: 3 }, { now: NOW }).usedPercent, 33.3);
});

test("numbers sent as strings are read", () => {
	assert.equal(quotaWindow({ kind: "weekly", usedPercent: "62.5" }, { now: NOW }).usedPercent, 62.5);
	assert.equal(quotaWindow({ kind: "weekly", usedPercent: "" }, { now: NOW }), undefined);
	assert.equal(quotaWindow({ kind: "weekly", usedPercent: "n/a" }, { now: NOW }), undefined);
});

test("an unlimited window keeps its row and carries no percentage", () => {
	// It is not the same fact as an empty one, and a bar drawn at 0% says the
	// opposite of what it means: none used OF A FINITE ALLOWANCE.
	const window = quotaWindow({ kind: "weekly", unlimited: true }, { now: NOW });
	assert.deepEqual(window, { kind: "weekly", unlimited: true });
	assert.equal("usedPercent" in window, false);
});

test("unlimited outranks a percentage sent alongside it", () => {
	const window = quotaWindow({ kind: "weekly", unlimited: true, usedPercent: 0 }, { now: NOW });
	assert.equal(window.unlimited, true);
	assert.equal(window.usedPercent, undefined);
});

// --- when it resets -----------------------------------------------------------

test("a duration from now is resolved to an instant at read time", () => {
	// "Resets in 3600 seconds" is true only at the moment it was read. Stored as
	// a duration it survives a cache, a refresh and a re-render, and lies during
	// all three.
	assert.equal(quotaWindow({ kind: "session", usedPercent: 1, resetInSeconds: 3600 }, { now: NOW }).resetsAt, at(3600_000));
	assert.equal(quotaWindow({ kind: "session", usedPercent: 1, resetInMs: 90_000 }, { now: NOW }).resetsAt, at(90_000));
});

test("an instant is accepted as ISO, as epoch seconds, and as epoch milliseconds", () => {
	const iso = at(0);
	for (const form of [iso, Math.floor(NOW / 1000), NOW, new Date(NOW).toUTCString()]) {
		assert.equal(quotaWindow({ kind: "session", usedPercent: 1, resetsAt: form }, { now: NOW }).resetsAt, iso, String(form));
	}
});

test("a reset nobody sent stays absent rather than being invented", () => {
	const window = quotaWindow({ kind: "monthly", usedPercent: 12 }, { now: NOW });
	assert.equal("resetsAt" in window, false);
	for (const bad of ["", null, "next tuesday", Number.NaN]) {
		const w = quotaWindow({ kind: "monthly", usedPercent: 12, resetsAt: bad }, { now: NOW });
		assert.equal("resetsAt" in w, false, JSON.stringify(bad));
	}
});

test("a negative duration is not a reset in the past", () => {
	// It means the field was not really populated. Rendering it produces a
	// window that claims to have reset before it was read.
	const window = quotaWindow({ kind: "session", usedPercent: 1, resetInSeconds: -60 }, { now: NOW });
	assert.equal("resetsAt" in window, false);
});

// --- what it is called ---------------------------------------------------------

test("a kind outside the list drops the window rather than showing a raw enum", () => {
	// The upstreams call these things TOKENS_LIMIT, ROLLING_5H, TIME_LIMIT. A
	// label nobody can read is worse than no row at all.
	for (const kind of ["TOKENS_LIMIT", "rolling", undefined, "", 5]) {
		assert.equal(quotaWindow({ kind, usedPercent: 10 }, { now: NOW }), undefined, String(kind));
	}
	for (const kind of WINDOW_KINDS) {
		assert.equal(quotaWindow({ kind, usedPercent: 10 }, { now: NOW }).kind, kind);
	}
});

test("a window length rides along when the upstream reports one", () => {
	assert.equal(quotaWindow({ kind: "session", usedPercent: 4, minutes: 300 }, { now: NOW }).minutes, 300);
	assert.equal("minutes" in quotaWindow({ kind: "session", usedPercent: 4 }, { now: NOW }), false);
	assert.equal("minutes" in quotaWindow({ kind: "session", usedPercent: 4, minutes: 0 }, { now: NOW }), false);
	assert.equal("minutes" in quotaWindow({ kind: "session", usedPercent: 4, minutes: -5 }, { now: NOW }), false);
});

test("a non-object is not a window", () => {
	for (const junk of [null, undefined, "session", 5, []]) {
		assert.equal(quotaWindow(junk, { now: NOW }), undefined, JSON.stringify(junk));
	}
});

// --- the list ------------------------------------------------------------------

test("windows are ordered by clock length, whatever order they arrived in", () => {
	// Two accounts on the same plan must not lay their rows out differently
	// because one vendor happened to serialize them backwards.
	const windows = normalizeWindows(
		[
			{ kind: "billing", usedPercent: 1 },
			{ kind: "monthly", usedPercent: 2 },
			{ kind: "weekly", usedPercent: 3 },
			{ kind: "daily", usedPercent: 5 },
			{ kind: "session", usedPercent: 4 }
		],
		{ now: NOW }
	);
	assert.deepEqual(windows.map((w) => w.kind), ["session", "daily", "weekly", "monthly", "billing"]);
});

test("one kind appears once, and the first source wins", () => {
	// A reader listing its best source first should get it, so that a fallback
	// field cannot overwrite the authoritative one.
	const windows = normalizeWindows(
		[{ kind: "weekly", usedPercent: 10 }, { kind: "weekly", usedPercent: 90 }],
		{ now: NOW }
	);
	assert.equal(windows.length, 1);
	assert.equal(windows[0].usedPercent, 10);
});

test("unusable entries are dropped without taking the usable ones with them", () => {
	const windows = normalizeWindows(
		[null, { kind: "nonsense", usedPercent: 1 }, { kind: "weekly" }, { kind: "session", usedPercent: 7 }],
		{ now: NOW }
	);
	assert.deepEqual(windows, [{ kind: "session", usedPercent: 7 }]);
});

test("no windows means absent, not an empty list", () => {
	// `windows: []` would have a card claim to be a subscription account with
	// nothing in it — the same lie as reporting an unread balance as zero.
	assert.equal(normalizeWindows([], { now: NOW }), undefined);
	assert.equal(normalizeWindows([{ kind: "weekly" }], { now: NOW }), undefined);
	assert.equal(normalizeWindows(undefined, { now: NOW }), undefined);
	assert.equal(normalizeWindows("weekly", { now: NOW }), undefined);
});
