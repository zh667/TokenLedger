/**
 * Rate tables and cost estimation.
 *
 * Pricing is what turns a token count into a figure you can compare with a bill.
 * A relay sets its own prices, so a local estimate and a site's reported charge
 * differing is normal — the point is to say by how much and why, not to force
 * them to agree.
 *
 * Three rules the shape here exists to enforce:
 *
 * - **Rates have effective dates.** A price change does not rewrite what
 *   yesterday cost. `rateFor` selects the newest rate whose `effectiveFrom` is
 *   on or before the day being priced, so re-running an old day reproduces the
 *   old number.
 * - **Each bucket has its own rate.** Cache reads are usually an order of
 *   magnitude cheaper than uncached input, and cache writes are sometimes
 *   dearer than both. Collapsing them into one input price is the single
 *   largest source of bogus estimates.
 * - **An unpriced model costs `null`, never zero.** A missing rate is missing
 *   information. Reporting it as free would silently understate a bill and is
 *   exactly the failure this project exists to catch.
 *
 * @module dsh-tokenledger/pricing
 */

/** Cost buckets a rate must price, in the order they are reported. */
export const RATE_BUCKETS = Object.freeze([
	"inputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"outputTokens"
]);

/**
 * Build a rate entry.
 *
 * Prices are per million tokens, the unit every provider publishes, so a rate
 * table can be transcribed from a price page without arithmetic.
 *
 * @param input - `{ model, currency, effectiveFrom, perMillion, window? }`.
 *   `perMillion` maps bucket names to numbers; omitted buckets are free only if
 *   explicitly set to 0. `window` optionally restricts the rate to a peak or
 *   off-peak period (see {@link definePeriod}).
 */
export function defineRate(input) {
	const { model, currency, effectiveFrom, perMillion } = input;
	if (typeof model !== "string" || model === "") throw new TypeError("rate requires a model");
	if (typeof currency !== "string" || currency === "") throw new TypeError("rate requires a currency");
	if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom ?? "")) {
		throw new TypeError(`rate for ${model} requires an effectiveFrom date`);
	}
	const prices = {};
	for (const bucket of RATE_BUCKETS) {
		const value = perMillion?.[bucket];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new TypeError(`rate for ${model} has an invalid ${bucket} price`);
		}
		prices[bucket] = value;
	}
	if (Object.keys(prices).length === 0) throw new TypeError(`rate for ${model} prices nothing`);
	return Object.freeze({
		model,
		currency,
		effectiveFrom,
		window: input.window,
		perMillion: Object.freeze(prices)
	});
}

/**
 * A peak/off-peak period, anchored to a timezone offset rather than the host's
 * local time, so a laptop that travels does not reprice history.
 *
 * @param input - `{ name, utcOffsetMinutes, fromHour, toHour }`, hours in
 *   `0..24` in the anchored zone. A period that wraps midnight (`fromHour >
 *   toHour`) is supported.
 */
export function definePeriod(input) {
	const { name, utcOffsetMinutes, fromHour, toHour } = input;
	if (typeof name !== "string" || name === "") throw new TypeError("period requires a name");
	for (const [label, hour] of [["fromHour", fromHour], ["toHour", toHour]]) {
		if (typeof hour !== "number" || !Number.isFinite(hour) || hour < 0 || hour > 24) {
			throw new TypeError(`period ${name} has an invalid ${label}`);
		}
	}
	return Object.freeze({
		name,
		utcOffsetMinutes: utcOffsetMinutes ?? 0,
		fromHour,
		toHour
	});
}

/** Whether a millisecond epoch falls inside a period. */
export function inPeriod(period, timeMs) {
	const shifted = new Date(timeMs + period.utcOffsetMinutes * 60_000);
	const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
	if (period.fromHour <= period.toHour) {
		return hour >= period.fromHour && hour < period.toHour;
	}
	// Wraps midnight, e.g. 00:30–08:30 expressed as fromHour 23 toHour 8.
	return hour >= period.fromHour || hour < period.toHour;
}

/**
 * A set of rates, queryable by model, day, and (optionally) time of day.
 */
export class RateTable {
	#byModel = new Map();

	constructor(rates = []) {
		for (const rate of rates) this.add(rate);
	}

	add(rate) {
		const record = Object.isFrozen(rate) && rate.perMillion !== undefined ? rate : defineRate(rate);
		const list = this.#byModel.get(record.model) ?? [];
		list.push(record);
		// Newest effective date first; a windowed rate outranks a general one on
		// the same date because it is the more specific statement.
		list.sort((a, b) => {
			if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
			return (b.window === undefined ? 0 : 1) - (a.window === undefined ? 0 : 1);
		});
		this.#byModel.set(record.model, list);
		return record;
	}

	/**
	 * The rate in force for a model on a given day, optionally narrowed by the
	 * moment within that day.
	 * @param model - provider model id.
	 * @param day - `YYYY-MM-DD`.
	 * @param timeMs - optional epoch ms, required to resolve windowed rates.
	 * @returns the rate, or undefined when the model is unpriced on that day.
	 */
	rateFor(model, day, timeMs = undefined) {
		const list = this.#byModel.get(model);
		if (list === undefined) return undefined;
		for (const rate of list) {
			if (rate.effectiveFrom > day) continue;
			if (rate.window !== undefined) {
				if (timeMs === undefined || !inPeriod(rate.window, timeMs)) continue;
			}
			return rate;
		}
		return undefined;
	}

	models() {
		return [...this.#byModel.keys()];
	}
}

/**
 * Price one bucket set.
 *
 * @param buckets - token buckets, as produced by the usage fold.
 * @param rate - the rate to apply, or undefined.
 * @returns `{ cost, currency, priced, unpricedBuckets }`. `cost` is `null` when
 *   no rate applies — never `0`. `unpricedBuckets` names buckets that carried
 *   tokens the rate does not price, so a partial rate cannot silently
 *   understate a total.
 */
export function estimateCost(buckets, rate) {
	if (rate === undefined) {
		return { cost: null, currency: undefined, priced: false, unpricedBuckets: [...RATE_BUCKETS] };
	}
	let cost = 0;
	const unpriced = [];
	for (const bucket of RATE_BUCKETS) {
		const tokens = buckets[bucket] ?? 0;
		const price = rate.perMillion[bucket];
		if (price === undefined) {
			if (tokens > 0) unpriced.push(bucket);
			continue;
		}
		cost += (tokens / 1_000_000) * price;
	}
	return {
		cost: round6(cost),
		currency: rate.currency,
		priced: true,
		unpricedBuckets: unpriced
	};
}

/**
 * The project's one money-rounding rule: six decimals.
 *
 * Six rather than the two a currency displays, because bucket pricing works in
 * per-token unit prices around 1e-6 — round a single call's cost to fewer
 * places and small calls become exactly zero, which then sum to zero. Six is
 * also short of the point where float noise starts showing through, so the
 * figures stay addable.
 *
 * Everything that produces a money figure rounds here, so a total and its parts
 * cannot disagree about the last digit.
 */
export function round6(value) {
	return Math.round(value * 1e6) / 1e6;
}

/**
 * Price a `byModel`/`bySite` style row list, attaching cost to each row and
 * returning the per-currency totals.
 *
 * Totals are kept per currency and never summed across currencies: a site
 * billing in USD and another in CNY produce two totals, not one wrong one.
 *
 * @param rows - rows carrying `model` and token buckets.
 * @param table - the rate table.
 * @param day - `YYYY-MM-DD` used to select the effective rate.
 * @returns `{ rows, totals, unpricedModels }` where `totals` maps currency to
 *   summed cost and `unpricedModels` lists models that produced no estimate.
 */
export function priceRows(rows, table, day) {
	const totals = new Map();
	const unpricedModels = [];
	const priced = rows.map((row) => {
		const rate = table.rateFor(row.model, day);
		const estimate = estimateCost(row, rate);
		if (!estimate.priced) {
			unpricedModels.push(row.model);
		} else {
			totals.set(estimate.currency, round6((totals.get(estimate.currency) ?? 0) + estimate.cost));
		}
		return { ...row, ...estimate };
	});
	return { rows: priced, totals: Object.fromEntries(totals), unpricedModels };
}

/**
 * DeepSeek's published off-peak discount window, 00:30–08:30 Beijing time.
 *
 * Exported as a period rather than baked into a rate so a rate table can pair
 * it with whatever prices are current — the window has outlived several price
 * changes, and the prices will outlive this constant.
 */
export const DEEPSEEK_OFF_PEAK = definePeriod({
	name: "off-peak",
	utcOffsetMinutes: 8 * 60,
	fromHour: 0.5,
	toHour: 8.5
});
