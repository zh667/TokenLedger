import assert from "node:assert/strict";
import test from "node:test";

import {
	DIRECT,
	UNROUTED,
	UNKNOWN,
	applyUsageDelta,
	byModel,
	bySite,
	cacheHitRate,
	createUsageState,
	dailyModels,
	foldUsage,
	hostTimeZone,
	mergeInto,
	renderUsage,
	routeKey,
	sumRange,
	totalTokens
} from "../src/usage.js";
import { RelaySiteRegistry, createSiteResolver } from "../src/relay-sites.js";

const DAY_A = Date.parse("2026-08-14T10:00:00");
const DAY_B = Date.parse("2026-08-15T10:00:00");

let seq = 0;
const ev = (type, data, time = DAY_A) => ({ type, seq: seq++, time, data });

const header = (provider, model, time = DAY_A, reason = "initial") =>
	ev("request/header", { header: { config: { provider, model }, reason } }, time);

const usageChunk = (turn, step, usage, time = DAY_A) =>
	ev("assistant/chunk", { turn, step, chunk: { type: "usage", usage } }, time);

const message = (turn, step, provider, model, usage, time = DAY_A) =>
	ev("assistant/message", { turn, step, message: { role: "assistant", source: { kind: "model", provider, model } }, usage }, time);

const usage = (input, output, extra = {}) => ({ inputTokens: input, outputTokens: output, ...extra });

test("a plain turn counts once from its assistant/message", () => {
	const days = foldUsage([header("deepseek", "v4"), message(1, 1, "deepseek", "v4", usage(100, 50))]);
	const entry = days.get("2026-08-14");
	assert.equal(entry.totals.inputTokens, 100);
	assert.equal(entry.totals.outputTokens, 50);
	assert.equal(entry.totals.requests, 1);
	assert.equal(totalTokens(entry.totals), 150);
});

test("a usage chunk superseded by its assistant/message is not double counted", () => {
	const days = foldUsage([
		header("deepseek", "v4"),
		usageChunk(1, 1, usage(100, 20)),
		message(1, 1, "deepseek", "v4", usage(100, 50))
	]);
	const entry = days.get("2026-08-14");
	assert.equal(entry.totals.outputTokens, 50, "the later sample replaces, never adds");
	assert.equal(entry.totals.requests, 1);
	assert.equal(entry.routes.size, 1);
});

test("a billed-but-failed request is still counted from its orphan usage chunk", () => {
	// The provider streamed usage and the request then failed: no assistant/message
	// ever arrives, but the call was billed.
	const days = foldUsage([
		header("deepseek", "v4"),
		usageChunk(1, 1, usage(800, 0)),
		ev("turn/end", { turn: 1, interrupted: true })
	]);
	const entry = days.get("2026-08-14");
	assert.equal(entry.totals.inputTokens, 800);
	assert.equal(entry.totals.requests, 1);
	assert.equal([...entry.routes.keys()][0], routeKey(DIRECT, "deepseek", "v4"), "route falls back to the last header");
});

test("a session that switches models attributes each sample to its own route", () => {
	const days = foldUsage([
		header("deepseek", "v4"),
		message(1, 1, "deepseek", "v4", usage(100, 10)),
		header("ark", "v4-flash"),
		message(2, 1, "ark", "v4-flash", usage(200, 20))
	]);
	const entry = days.get("2026-08-14");
	assert.equal(entry.routes.get(routeKey(DIRECT, "deepseek", "v4")).inputTokens, 100);
	assert.equal(entry.routes.get(routeKey(DIRECT, "ark", "v4-flash")).inputTokens, 200);
	assert.equal(entry.totals.inputTokens, 300);
});

test("the same model on two providers stays distinct", () => {
	const rows = byModel(foldUsage([
		message(1, 1, "deepseek", "v4", usage(100, 10)),
		message(2, 1, "ark", "v4", usage(200, 20))
	]));
	assert.equal(rows.length, 1, "byModel intentionally sums across providers");
	const days = foldUsage([
		message(1, 1, "deepseek", "v4", usage(100, 10)),
		message(2, 1, "ark", "v4", usage(200, 20))
	]);
	assert.equal(days.get("2026-08-14").routes.size, 2, "but the routes stay separate underneath");
});

test("an unattributable sample lands in the unknown bucket rather than being guessed", () => {
	const days = foldUsage([usageChunk(1, 1, usage(50, 5))]);
	const key = [...days.get("2026-08-14").routes.keys()][0];
	assert.equal(key, routeKey(DIRECT, UNKNOWN, UNKNOWN));
});

test("reasoning tokens are tracked but never added to the billed total", () => {
	const days = foldUsage([
		message(1, 1, "deepseek", "v4", usage(100, 200, { reasoningTokens: 150 }))
	]);
	const t = days.get("2026-08-14").totals;
	assert.equal(t.reasoningTokens, 150);
	assert.equal(totalTokens(t), 300, "100 input + 200 output; reasoning is inside output");
});

test("billed input sums the three disjoint prompt buckets", () => {
	const days = foldUsage([
		message(1, 1, "deepseek", "v4", usage(100, 10, { cacheReadTokens: 900, cacheWriteTokens: 50 }))
	]);
	const t = days.get("2026-08-14").totals;
	assert.equal(totalTokens(t), 1060);
	assert.equal(cacheHitRate(t), 85.7);
});

test("cacheHitRate is null when nothing prompt-side was reported", () => {
	assert.equal(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }), null);
});

test("a replacement arriving in a later fold slice is still exact", () => {
	const state = createUsageState();
	applyUsageDelta(state, [header("deepseek", "v4"), usageChunk(1, 1, usage(100, 20))]);
	assert.equal(state.days.get("2026-08-14").totals.outputTokens, 20);

	// Second slice: the assistant/message for the SAME (turn, step) arrives after
	// the fold boundary. Naive implementations double count here.
	applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 50))]);
	const t = state.days.get("2026-08-14").totals;
	assert.equal(t.outputTokens, 50);
	assert.equal(t.inputTokens, 100);
	assert.equal(t.requests, 1);
});

test("a replacement that lands on the next day unwinds the first day", () => {
	const state = createUsageState();
	applyUsageDelta(state, [header("deepseek", "v4"), usageChunk(1, 1, usage(100, 20), DAY_A)]);
	applyUsageDelta(state, [message(1, 1, "deepseek", "v4", usage(100, 50), DAY_B)]);
	assert.equal(state.days.get("2026-08-14").totals.requests, 0, "the superseded day is emptied");
	assert.equal(state.days.get("2026-08-14").totals.outputTokens, 0);
	assert.equal(state.days.get("2026-08-15").totals.outputTokens, 50);
});

test("consumedSeq advances so a caller can checkpoint", () => {
	const state = createUsageState();
	const events = [header("deepseek", "v4"), message(1, 1, "deepseek", "v4", usage(1, 1))];
	applyUsageDelta(state, events);
	assert.equal(state.consumedSeq, events.at(-1).seq);
});

test("a resume header restates the route without creating a new one", () => {
	const days = foldUsage([
		header("deepseek", "v4"),
		message(1, 1, "deepseek", "v4", usage(100, 10)),
		header("deepseek", "v4", DAY_A, "resume"),
		usageChunk(2, 1, usage(200, 20))
	]);
	assert.equal(days.get("2026-08-14").routes.size, 1);
	assert.equal(days.get("2026-08-14").totals.inputTokens, 300);
});

test("relay sites are resolved at fold time and split the routes", () => {
	const registry = new RelaySiteRegistry([
		{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example/v1" },
		{ id: "sub", type: "sub2api", baseUrl: "https://api.relay-two.example" }
	]);
	const resolveSite = createSiteResolver(registry, {
		relayA: "https://API.relay-one.example:443/v1/chat",
		relayB: "https://api.relay-two.example/v1",
		official: "https://api.deepseek.com"
	});

	const days = foldUsage(
		[
			message(1, 1, "relayA", "v4", usage(100, 10)),
			message(2, 1, "relayB", "v4", usage(200, 20)),
			message(3, 1, "official", "v4", usage(300, 30))
		],
		{ resolveSite }
	);

	const sites = bySite(days);
	assert.deepEqual(
		sites.map((s) => [s.site, s.inputTokens]).sort(),
		[
			[DIRECT, 300],
			["nine", 100],
			["sub", 200]
		].sort()
	);

	assert.equal(byModel(days).length, 1, "one model overall");
	assert.equal(byModel(days, {}, "nine")[0].inputTokens, 100, "filtering by site narrows it");
});

// --- direct is a claim, not a fallback -----------------------------------------

test("a route absent from the directory is unrouted, not direct", () => {
	// A real install read 88% of its tokens as "direct/official" because a relay
	// route had since been renamed. `direct` says the call went to the vendor.
	// We did not know that; we knew only that the route was unrecognised.
	const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example" }]);
	const resolveSite = createSiteResolver(registry, {
		relayA: "https://api.relay-one.example",
		official: "https://api.deepseek.com"
	});

	const siteOf = (route) => {
		const days = foldUsage([message(1, 1, route, "v4", usage(10, 1), DAY_A)], { resolveSite });
		return [...[...days.values()][0].routes.keys()][0].split("\u0000")[0];
	};

	assert.equal(siteOf("relayA"), "nine", "configured and pointing at a relay");
	assert.equal(siteOf("official"), DIRECT, "configured and pointing at the vendor");
	assert.equal(siteOf("vanished"), UNROUTED, "not in the directory at all");
});

test("the resolver answers three different things, and says which", () => {
	const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example" }]);
	const resolveSite = createSiteResolver(registry, {
		relayA: "https://api.relay-one.example",
		official: "https://api.deepseek.com"
	});
	assert.equal(resolveSite("relayA"), "nine");
	assert.equal(resolveSite("official"), DIRECT, "present in the directory, so this IS a claim about where it went");
	assert.equal(resolveSite("vanished"), undefined, "absent from the directory, so there is nothing to claim");
	// Cached answers must keep the distinction too.
	assert.equal(resolveSite("official"), DIRECT);
	assert.equal(resolveSite("vanished"), undefined);
});

test("re-adding the route re-attributes its history", () => {
	// The recovery path, and the reason mislabelled traffic is not lost traffic:
	// the rollup row keeps the ROUTE name, so a later fold against a directory
	// that knows the route puts it back where it belongs.
	const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example" }]);
	const events = [message(1, 1, "relayA", "v4", usage(10, 1), DAY_A)];

	const before = foldUsage(events, { resolveSite: createSiteResolver(registry, {}) });
	const after = foldUsage(events, { resolveSite: createSiteResolver(registry, { relayA: "https://api.relay-one.example" }) });

	const siteOf = (days) => [...[...days.values()][0].routes.keys()][0].split("\u0000")[0];
	assert.equal(siteOf(before), UNROUTED);
	assert.equal(siteOf(after), "nine");
});

test("sumRange honours inclusive bounds and the site filter", () => {
	const registry = new RelaySiteRegistry([{ id: "nine", type: "newapi", baseUrl: "https://api.relay-one.example" }]);
	const resolveSite = createSiteResolver(registry, { relayA: "https://api.relay-one.example" });
	const byDay = new Map();
	mergeInto(byDay, foldUsage([message(1, 1, "relayA", "v4", usage(100, 10), DAY_A)], { resolveSite }));
	mergeInto(byDay, foldUsage([message(1, 1, "relayA", "v4", usage(200, 20), DAY_B)], { resolveSite }));

	assert.equal(sumRange(byDay).inputTokens, 300);
	assert.equal(sumRange(byDay, { from: "2026-08-15" }).inputTokens, 200);
	assert.equal(sumRange(byDay, { to: "2026-08-14" }).inputTokens, 100);
	assert.equal(sumRange(byDay, {}, "nine").inputTokens, 300);
	assert.equal(sumRange(byDay, {}, DIRECT).inputTokens, 0);
});

test("renderUsage emits ascending days with descending routes", () => {
	const byDay = new Map();
	mergeInto(byDay, foldUsage([message(1, 1, "a", "small", usage(10, 1), DAY_B)]));
	mergeInto(byDay, foldUsage([message(1, 1, "a", "big", usage(1000, 100), DAY_B)]));
	mergeInto(byDay, foldUsage([message(1, 1, "a", "small", usage(5, 1), DAY_A)]));

	const wire = renderUsage(byDay, 1234);
	assert.deepEqual(wire.days.map((d) => d.date), ["2026-08-14", "2026-08-15"]);
	assert.deepEqual(wire.days[1].routes.map((r) => r.model), ["big", "small"]);
	assert.equal(wire.total.tokens, 1117);
	assert.equal(wire.updatedAt, 1234);
});

// --- day-key arithmetic and the per-day model fold --------------------------
//
// These moved here with the functions: they are folds over rollup rows and
// local-day arithmetic, which is what this module is. They lived in the HTTP
// tests only because the code did.

test("one model reached through two relays is one row, not two halves", () => {
	// byRoute is keyed by (day, site, provider, model), so the day tooltip listed
	// the same model twice — each showing half its real total and half its real
	// share. Seen in a browser, not in a test.
	const merged = dailyModels([
		{ day: "2026-08-14", site: "a.example", model: "gpt", tokens: 64552 },
		{ day: "2026-08-14", site: "direct", model: "gpt", tokens: 10170 },
		{ day: "2026-08-14", site: "direct", model: "claude", tokens: 0 },
		{ day: "2026-08-13", site: "direct", model: "gpt", tokens: 5 }
	]);
	assert.deepEqual(merged, [
		{ day: "2026-08-13", model: "gpt", tokens: 5 },
		{ day: "2026-08-14", model: "gpt", tokens: 74722 }
	]);
});

test("a model that ran nothing that day is not part of that day's breakdown", () => {
	assert.deepEqual(dailyModels([{ day: "d", model: "idle", tokens: 0 }]), []);
});

test("rows are ordered by day, then by size within the day", () => {
	const rows = dailyModels([
		{ day: "2026-08-14", model: "small", tokens: 1 },
		{ day: "2026-08-14", model: "big", tokens: 100 },
		{ day: "2026-08-12", model: "mid", tokens: 50 }
	]);
	assert.deepEqual(rows.map((r) => r.model), ["mid", "big", "small"]);
});

test("the offset's sign is inverted from getTimezoneOffset, which counts west", () => {
	// getTimezoneOffset returns minutes WEST of UTC, so Tokyo (UTC+9) reports
	// -540. Printing it unflipped would label every eastern zone as western.
	const tokyo = hostTimeZone({ getTimezoneOffset: () => -540 });
	assert.equal(tokyo.offset, "UTC+09:00");
	const newYork = hostTimeZone({ getTimezoneOffset: () => 300 });
	assert.equal(newYork.offset, "UTC-05:00");
	// Half-hour and quarter-hour zones exist and must not round away.
	assert.equal(hostTimeZone({ getTimezoneOffset: () => -330 }).offset, "UTC+05:30");
	assert.equal(hostTimeZone({ getTimezoneOffset: () => -345 }).offset, "UTC+05:45");
	assert.equal(hostTimeZone({ getTimezoneOffset: () => 0 }).offset, "UTC+00:00");
});
