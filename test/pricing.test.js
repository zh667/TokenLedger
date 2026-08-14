import assert from "node:assert/strict";
import test from "node:test";

import {
	DEEPSEEK_OFF_PEAK,
	RATE_BUCKETS,
	RateTable,
	defineRate,
	definePeriod,
	estimateCost,
	inPeriod,
	priceRows
} from "../src/pricing.js";

const buckets = (o = {}) => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	requests: 0,
	...o
});

test("a rate must declare a model, currency, effective date, and some price", () => {
	assert.throws(() => defineRate({ currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 1 } }), /model/);
	assert.throws(() => defineRate({ model: "m", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 1 } }), /currency/);
	assert.throws(() => defineRate({ model: "m", currency: "CNY", perMillion: { inputTokens: 1 } }), /effectiveFrom/);
	assert.throws(() => defineRate({ model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: {} }), /prices nothing/);
	assert.throws(
		() => defineRate({ model: "m", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: -1 } }),
		/invalid inputTokens/
	);
});

test("each bucket is priced separately", () => {
	const rate = defineRate({
		model: "v4",
		currency: "CNY",
		effectiveFrom: "2026-01-01",
		perMillion: { inputTokens: 4, cacheReadTokens: 0.4, cacheWriteTokens: 8, outputTokens: 12 }
	});
	const result = estimateCost(
		buckets({ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 }),
		rate
	);
	assert.equal(result.cost, 24.4);
	assert.equal(result.currency, "CNY");
	assert.equal(result.priced, true);
});

test("an unpriced model costs null, never zero", () => {
	const result = estimateCost(buckets({ inputTokens: 5_000_000 }), undefined);
	assert.equal(result.cost, null);
	assert.equal(result.priced, false);
	assert.deepEqual(result.unpricedBuckets, [...RATE_BUCKETS]);
});

test("a partial rate names the buckets it could not price", () => {
	const rate = defineRate({
		model: "v4",
		currency: "CNY",
		effectiveFrom: "2026-01-01",
		perMillion: { inputTokens: 4, outputTokens: 12 }
	});
	const result = estimateCost(buckets({ inputTokens: 1_000_000, cacheReadTokens: 500_000 }), rate);
	assert.equal(result.cost, 4);
	assert.deepEqual(result.unpricedBuckets, ["cacheReadTokens"], "silence here would understate the bill");
});

test("a bucket the rate omits but that carried no tokens is not reported unpriced", () => {
	const rate = defineRate({ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } });
	assert.deepEqual(estimateCost(buckets({ inputTokens: 1_000_000 }), rate).unpricedBuckets, []);
});

test("a price change does not rewrite what an earlier day cost", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-06-01", perMillion: { inputTokens: 2 } }
	]);
	const million = buckets({ inputTokens: 1_000_000 });
	assert.equal(estimateCost(million, table.rateFor("v4", "2026-05-31")).cost, 4);
	assert.equal(estimateCost(million, table.rateFor("v4", "2026-06-01")).cost, 2, "effective date is inclusive");
	assert.equal(estimateCost(million, table.rateFor("v4", "2026-12-31")).cost, 2);
});

test("a day before any effective date has no rate", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-06-01", perMillion: { inputTokens: 2 } }
	]);
	assert.equal(table.rateFor("v4", "2026-05-31"), undefined);
	assert.equal(table.rateFor("unknown-model", "2026-06-01"), undefined);
});

test("periods are anchored to a timezone, not the host clock", () => {
	const beijingNight = definePeriod({ name: "off-peak", utcOffsetMinutes: 480, fromHour: 0.5, toHour: 8.5 });
	// 2026-08-14 02:00 Beijing == 2026-08-13 18:00 UTC.
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-13T18:00:00Z")), true);
	// 2026-08-14 12:00 Beijing == 04:00 UTC.
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-14T04:00:00Z")), false);
	// Boundary: 08:30 Beijing is outside, 08:29 inside.
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-14T00:30:00Z")), false);
	assert.equal(inPeriod(beijingNight, Date.parse("2026-08-14T00:29:00Z")), true);
});

test("a period that wraps midnight is supported", () => {
	const night = definePeriod({ name: "night", utcOffsetMinutes: 0, fromHour: 23, toHour: 6 });
	assert.equal(inPeriod(night, Date.parse("2026-08-14T23:30:00Z")), true);
	assert.equal(inPeriod(night, Date.parse("2026-08-14T03:00:00Z")), true);
	assert.equal(inPeriod(night, Date.parse("2026-08-14T12:00:00Z")), false);
});

test("DeepSeek's published off-peak window is 00:30-08:30 Beijing", () => {
	assert.equal(DEEPSEEK_OFF_PEAK.utcOffsetMinutes, 480);
	assert.equal(inPeriod(DEEPSEEK_OFF_PEAK, Date.parse("2026-08-13T17:00:00Z")), true, "01:00 Beijing");
	assert.equal(inPeriod(DEEPSEEK_OFF_PEAK, Date.parse("2026-08-14T06:00:00Z")), false, "14:00 Beijing");
});

test("a windowed rate outranks a general rate of the same date, and needs the time to apply", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{
			model: "v4",
			currency: "CNY",
			effectiveFrom: "2026-01-01",
			window: DEEPSEEK_OFF_PEAK,
			perMillion: { inputTokens: 1 }
		}
	]);
	const offPeak = Date.parse("2026-08-13T17:00:00Z"); // 01:00 Beijing
	const peak = Date.parse("2026-08-14T06:00:00Z"); // 14:00 Beijing

	assert.equal(table.rateFor("v4", "2026-08-14", offPeak).perMillion.inputTokens, 1);
	assert.equal(table.rateFor("v4", "2026-08-14", peak).perMillion.inputTokens, 4);
	assert.equal(table.rateFor("v4", "2026-08-14").perMillion.inputTokens, 4, "no time given falls back to the general rate");
});

test("priceRows totals per currency and never sums across them", () => {
	const table = new RateTable([
		{ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 4 } },
		{ model: "gpt", currency: "USD", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 10 } }
	]);
	const { rows, totals, unpricedModels } = priceRows(
		[
			{ model: "v4", ...buckets({ inputTokens: 2_000_000 }) },
			{ model: "gpt", ...buckets({ inputTokens: 1_000_000 }) },
			{ model: "mystery", ...buckets({ inputTokens: 9_000_000 }) }
		],
		table,
		"2026-08-14"
	);
	assert.deepEqual(totals, { CNY: 8, USD: 10 });
	assert.deepEqual(unpricedModels, ["mystery"]);
	assert.equal(rows[2].cost, null);
	assert.equal(rows[2].priced, false);
});

test("costs are rounded to six decimals, not float noise", () => {
	const rate = defineRate({ model: "v4", currency: "CNY", effectiveFrom: "2026-01-01", perMillion: { inputTokens: 0.7 } });
	assert.equal(estimateCost(buckets({ inputTokens: 3 }), rate).cost, 0.000002);
});
