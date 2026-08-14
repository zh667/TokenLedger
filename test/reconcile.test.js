import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { INCOMPARABLE, describe, reconcileAll, reconcileSite, relayLevel } from "../src/reconcile.js";
import { normalizeUsage } from "../src/adapters/sub2api.js";
import { readQuotaUnits } from "../src/adapters/newapi.js";

const SUB2API = JSON.parse(readFileSync(new URL("./fixtures/sub2api.json", import.meta.url), "utf8"));
const NEWAPI = JSON.parse(readFileSync(new URL("./fixtures/newapi.json", import.meta.url), "utf8"));

const dshBuckets = (o = {}) => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	requests: 0,
	...o
});

/** An adapter fact shaped like a windowed, per-day relay. */
const windowedRelay = (overrides = {}) => ({
	level: "aggregate",
	fetchedAt: 1_700_000_000_000,
	window: { from: 0, to: 1 },
	currency: "USD",
	capabilities: { perRequest: false, perModel: true, perDay: true, recomputable: true, windowed: true },
	total: { promptTokens: 1000, outputTokens: 100, requests: 5, listCost: 2, actualCost: 2 },
	balance: { remaining: 50, currency: "USD" },
	...overrides
});

test("an unrecognized relay is incomparable, not zero", () => {
	const r = reconcileSite({ site: "mystery", dsh: dshBuckets({ inputTokens: 10 }), relay: null });
	assert.equal(r.comparable, false);
	assert.equal(r.level, "none");
	assert.equal(r.reason, INCOMPARABLE.NO_BILLING);
	assert.equal(r.cost, undefined, "no cost object at all beats a cost object full of zeros");
});

test("a cumulative-only relay cannot answer a windowed question", () => {
	const relay = normalizeUsage(SUB2API.usage);
	const r = reconcileSite({
		site: "sub",
		dsh: dshBuckets({ inputTokens: 100, requests: 2 }),
		relay,
		window: { from: "2026-07-15", to: "2026-08-14" }
	});
	assert.equal(r.comparable, false);
	assert.equal(r.reason, INCOMPARABLE.WINDOW_MISMATCH);
	// The balance is still worth showing even when the comparison is refused.
	assert.equal(r.relayBalance.amount, 4.76803348);
	assert.equal(r.relayBalance.currency, "USD");
});

test("the same cumulative relay IS comparable against an all-time DSH total", () => {
	const relay = normalizeUsage(SUB2API.usage);
	const r = reconcileSite({
		site: "sub",
		dsh: dshBuckets({ inputTokens: 0, cacheReadTokens: 325_024, cacheWriteTokens: 17_107, outputTokens: 2478, requests: 2 }),
		relay,
		allTime: true
	});
	assert.equal(r.comparable, true);
	assert.equal(r.window, "all-time");
	assert.equal(r.tokens.delta.promptTokens, 0, "our prompt-side total matches the site's exactly");
	assert.equal(r.tokens.delta.outputTokens, 0);
	assert.equal(r.tokens.delta.requests, 0);
});

test("prompt tokens are compared cache-inclusive on both sides", () => {
	// DSH splits cache out; the relay reports the whole prompt side. Comparing
	// inputTokens alone would report a 900-token phantom shortfall.
	const dsh = dshBuckets({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 10, requests: 1 });
	const r = reconcileSite({
		site: "s",
		dsh,
		relay: windowedRelay({ total: { promptTokens: 1000, outputTokens: 10, requests: 1 } }),
		window: { from: "a", to: "b" }
	});
	assert.equal(r.tokens.dsh.promptTokens, 1000);
	assert.equal(r.tokens.delta.promptTokens, 0);
});

test("a real token shortfall is reported with direction and percentage", () => {
	const dsh = dshBuckets({ inputTokens: 800, outputTokens: 100, requests: 4 });
	const r = reconcileSite({
		site: "s",
		dsh,
		relay: windowedRelay({ total: { promptTokens: 1000, outputTokens: 100, requests: 5 } }),
		window: { from: "a", to: "b" }
	});
	assert.equal(r.tokens.delta.promptTokens, 200, "the relay billed 200 tokens we never sent");
	assert.equal(r.tokens.delta.requests, 1);
	assert.equal(r.tokens.deltaPercent.promptTokens, 25);
});

test("currencies are never converted to force a difference", () => {
	const r = reconcileSite({
		site: "s",
		dsh: dshBuckets({ inputTokens: 1000, requests: 1 }),
		relay: windowedRelay({ currency: "USD" }),
		dshEstimate: { cost: 14.6, currency: "CNY" },
		window: { from: "a", to: "b" }
	});
	assert.equal(r.cost.currencyMismatch, true);
	assert.equal(r.cost.delta, null, "inventing an exchange rate would fabricate the answer");
	assert.equal(r.cost.dshEstimate.currency, "CNY");
	assert.equal(r.cost.relayActualCost.currency, "USD");
	assert.ok(r.notes.some((n) => n.includes("not converted")));
});

test("list price and deducted cost are both carried, and the deducted one is compared", () => {
	const r = reconcileSite({
		site: "s",
		dsh: dshBuckets({ inputTokens: 1000, requests: 1 }),
		relay: windowedRelay({ total: { promptTokens: 1000, outputTokens: 0, requests: 1, listCost: 3, actualCost: 2 } }),
		dshEstimate: { cost: 1.5, currency: "USD" },
		window: { from: "a", to: "b" }
	});
	assert.equal(r.cost.relayListCost.amount, 3);
	assert.equal(r.cost.relayActualCost.amount, 2);
	assert.equal(r.cost.delta, 0.5, "2 deducted against a 1.5 estimate");
	assert.ok(r.notes.some((n) => n.includes("list price and actually-deducted")));
});

test("a missing estimate leaves the delta null rather than treating it as free", () => {
	const r = reconcileSite({
		site: "s",
		dsh: dshBuckets({ inputTokens: 1000, requests: 1 }),
		relay: windowedRelay(),
		dshEstimate: null,
		window: { from: "a", to: "b" }
	});
	assert.equal(r.cost.dshEstimate, null);
	assert.equal(r.cost.delta, null);
	assert.equal(r.cost.relayActualCost.amount, 2);
});

test("request level is unreachable while DSH records no provider request id", () => {
	const perRequest = windowedRelay({
		capabilities: { perRequest: true, perModel: true, perDay: true, recomputable: true, windowed: true }
	});
	assert.equal(relayLevel(perRequest), "aggregate");
	const r = reconcileSite({ site: "s", dsh: dshBuckets({ requests: 1 }), relay: perRequest, window: { from: "a", to: "b" } });
	assert.equal(r.level, "aggregate", "the relay can, but the DSH side cannot join call-for-call");
});

test("a summary-capable relay never reports aggregate", () => {
	assert.equal(relayLevel(normalizeUsage(SUB2API.usage)), "summary");
	const withDaily = normalizeUsage({
		...SUB2API.usage,
		daily_usage: [{ date: "2026-08-13", requests: 1, cost: 0.01 }]
	});
	// perDay is now true but windowed is still false: the deployment publishes
	// days, not a queryable window, so it stays summary.
	assert.equal(withDaily.capabilities.perDay, true);
	assert.equal(relayLevel(withDaily), "summary");
});

test("a relay that cannot be recomputed says so", () => {
	const r = reconcileSite({
		site: "sub",
		dsh: dshBuckets({ inputTokens: 342_131, outputTokens: 2478, requests: 2 }),
		relay: normalizeUsage(SUB2API.usage),
		allTime: true
	});
	assert.equal(r.verification.available, false);
	assert.ok(r.notes.some((n) => n.includes("cannot be independently recomputed")));
});

test("DSH recording nothing while the relay charged is flagged, not silently zeroed", () => {
	const r = reconcileSite({
		site: "s",
		dsh: dshBuckets(),
		relay: windowedRelay(),
		window: { from: "a", to: "b" }
	});
	assert.equal(r.comparable, true);
	assert.ok(r.notes.some((n) => n.includes("DSH recorded nothing")));
	assert.equal(r.tokens.delta.promptTokens, 1000, "every token the relay billed is unexplained");
});

test("a mixed report takes the weakest level, not the strongest", () => {
	const report = reconcileAll([
		{ site: "strong", dsh: dshBuckets({ requests: 1 }), relay: windowedRelay(), window: { from: "a", to: "b" } },
		{ site: "weak", dsh: dshBuckets({ requests: 1 }), relay: normalizeUsage(SUB2API.usage), allTime: true },
		{ site: "unknown", dsh: dshBuckets({ requests: 1 }), relay: null }
	]);
	assert.equal(report.comparable, 2);
	assert.equal(report.incomparable, 1);
	assert.equal(report.level, "summary", "a summary-only site must not be presented at aggregate strength");
});

test("describe never renders an incomparable pair as a zero difference", () => {
	const bad = reconcileSite({ site: "mystery", dsh: dshBuckets(), relay: null });
	const text = describe(bad);
	assert.ok(text.includes("cannot compare"));
	assert.equal(text.includes(" 0 "), false);

	const good = reconcileSite({
		site: "s",
		dsh: dshBuckets({ inputTokens: 1000, requests: 1 }),
		relay: windowedRelay(),
		dshEstimate: { cost: 1.5, currency: "USD" },
		window: { from: "a", to: "b" }
	});
	assert.ok(describe(good).includes("+0.5 USD"));
});

test("New API's quota unit is carried as its own fact, not conflated with money", () => {
	const units = readQuotaUnits(NEWAPI.status);
	const relay = {
		level: "aggregate",
		fetchedAt: 1,
		window: { from: 0, to: 1 },
		currency: units.displayCurrency,
		capabilities: { perRequest: false, perModel: true, perDay: true, recomputable: true, windowed: true },
		total: { promptTokens: 12_416, outputTokens: 149, requests: 1, quota: 11_646, listCost: 0.170004 }
	};
	const r = reconcileSite({
		site: "nine",
		dsh: dshBuckets({ inputTokens: 640, cacheReadTokens: 11_776, outputTokens: 149, requests: 1 }),
		relay,
		dshEstimate: { cost: 0.17, currency: "CNY" },
		window: { from: "a", to: "b" }
	});
	assert.equal(r.tokens.delta.promptTokens, 0);
	assert.equal(r.cost.quota, 11_646, "quota stays visible beside the money, never replaced by it");
	assert.equal(r.cost.deltaCurrency, "CNY");
	assert.equal(r.cost.delta, 0.000004);
});
