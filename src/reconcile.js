/**
 * Reconciliation: put what TokenLedger counted beside what the relay charged,
 * and state exactly how much that comparison is worth.
 *
 * Everything here exists to stop the tool from overclaiming. Producing a
 * difference is easy; the hard part is knowing when a difference is evidence
 * and when it is an artefact of comparing two things that were never the same
 * measurement. Four rules encode that:
 *
 * **The level is the weaker of the two sides.** DSH-side rollups are always
 * per-day, per-model, per-site. A relay may be far coarser. The comparison
 * inherits the coarser one, and `request` is currently unreachable for any
 * relay: DSH's session log records no provider request id, so nothing can be
 * joined call-for-call even when the relay publishes one.
 *
 * **A cumulative total cannot answer a windowed question.** A relay that
 * reports only a lifetime figure is not comparable to "last 30 days" — pairing
 * them would silently indict the relay for every request made before the
 * window. Such a pair is returned `comparable: false` unless the DSH side is
 * also all-time.
 *
 * **Currencies are never converted.** An estimate in CNY and a charge in USD
 * are two facts, and inventing an exchange rate to subtract them would fabricate
 * the very number the user came to check.
 *
 * **A missing figure is null, never zero.** Zero is a measurement.
 *
 * @module dsh-tokenledger/reconcile
 */

import { inputTotal } from "./usage.js";
import { round6 } from "./pricing.js";

/** Evidence strength a comparison can carry, weakest first. */
export const LEVEL_ORDER = Object.freeze(["none", "summary", "aggregate", "request"]);

/**
 * Reasons a pair cannot be compared at all.
 *
 * Stable English identifiers: they are part of the API surface and callers key
 * off them. Display translation belongs to the renderer, not here — a message
 * that changes with a locale is not something a caller can branch on.
 *
 * `NO_READER` and `NO_BILLING` are deliberately distinct. "We could not
 * identify this relay's software" and "you have not given us a way to read this
 * relay's bills" are different problems with different fixes, and collapsing
 * them tells the user to go debug the wrong one.
 */
export const INCOMPARABLE = Object.freeze({
	NO_BILLING: "the relay software was not recognized, so there is no billing side to compare",
	NO_READER: "no billing reader is configured for this site, so its own figures were never fetched",
	WINDOW_MISMATCH: "the relay reports only a cumulative total, which cannot answer a windowed question",
	NO_RELAY_DATA: "the relay returned no usable billing figures",
	NO_DSH_DATA: "no DSH usage was recorded for this site in this window"
});

const weaker = (a, b) => (LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b);

/**
 * What a relay fact can support on its own.
 *
 * Derived from the adapter's declared capabilities rather than from its level
 * field, so an adapter cannot assert a strength its data does not have.
 */
export function relayLevel(fact) {
	const c = fact?.capabilities;
	if (c === undefined) return fact?.level ?? "none";
	// `request` deliberately unreachable: see the module note.
	if (c.perDay && c.windowed) return "aggregate";
	if (c.perModel && c.windowed) return "aggregate";
	return "summary";
}

function money(amount, currency) {
	if (amount === null || amount === undefined) return null;
	return { amount: Number(amount), currency: currency ?? undefined };
}

function subtractMoney(a, b) {
	if (a === null || b === null) return { amount: null, currency: undefined, currencyMismatch: false };
	if (a.currency !== b.currency) {
		return { amount: null, currency: undefined, currencyMismatch: true };
	}
	return { amount: round6(a.amount - b.amount), currency: a.currency, currencyMismatch: false };
}

function pct(delta, base) {
	if (delta === null || base === null || base === 0) return null;
	return Math.round((delta / base) * 10_000) / 100;
}

/**
 * Compare one site's DSH-side totals against that site's own reported billing.
 *
 * @param input - `{ site, dsh, relay, window, dshEstimate?, allTime? }`.
 *   - `dsh`: token buckets from `store.totals(range, site)` or `bySite()`.
 *   - `relay`: a normalized fact from an adapter, or null when unrecognized.
 *   - `window`: `{ from, to }` day strings, or omit for all-time.
 *   - `dshEstimate`: `{ cost, currency }` from the pricing module, optional.
 *   - `allTime`: set true when `dsh` covers the whole history, which is what
 *     makes a cumulative relay total comparable.
 * @returns a reconciliation record. Read `comparable` before anything else.
 */
export function reconcileSite(input) {
	const { site, dsh, relay, window, dshEstimate = null, allTime = false } = input;
	const notes = [];

	const fetchedAt = relay?.fetchedAt ?? null;
	const base = {
		site,
		window: window ?? (allTime ? "all-time" : undefined),
		freshness: { dshAt: input.dshAt ?? null, relayAt: fetchedAt },
		notes
	};

	if (relay === null || relay === undefined) {
		return {
			...base,
			level: "none",
			comparable: false,
			reason: input.readerConfigured === false ? INCOMPARABLE.NO_READER : INCOMPARABLE.NO_BILLING
		};
	}

	const level = weaker(relayLevel(relay), "aggregate");

	// A cumulative-only relay figure paired with a windowed DSH figure would
	// blame the relay for everything that happened before the window.
	const relayIsCumulative = relay.window === null || relay.window === undefined;
	if (relayIsCumulative && !allTime) {
		return {
			...base,
			level,
			comparable: false,
			reason: INCOMPARABLE.WINDOW_MISMATCH,
			relayBalance: relay.balance
				? money(relay.balance.remaining ?? relay.balance.amount, relay.balance.currency)
				: null
		};
	}

	const relayTotals = relay.total ?? relay.totals ?? null;
	if (relayTotals === null) {
		return { ...base, level, comparable: false, reason: INCOMPARABLE.NO_RELAY_DATA };
	}
	if (dsh === null || dsh === undefined || (dsh.requests ?? 0) === 0) {
		notes.push("DSH recorded nothing for this site; any relay charge here is unexplained by this machine");
	}

	// Token comparison. Both adapters normalize to a prompt-side total that
	// includes cache, which is what `inputTotal()` computes on the DSH side —
	// comparing against `inputTokens` alone is the classic false discrepancy.
	const dshPrompt = dsh ? inputTotal(dsh) : null;
	const relayPrompt = relayTotals.promptTokens ?? null;
	const tokens = {
		dsh: dsh
			? {
					promptTokens: dshPrompt,
					outputTokens: dsh.outputTokens,
					cacheReadTokens: dsh.cacheReadTokens,
					cacheWriteTokens: dsh.cacheWriteTokens,
					requests: dsh.requests
				}
			: null,
		relay: {
			promptTokens: relayPrompt,
			outputTokens: relayTotals.outputTokens ?? null,
			cacheReadTokens: relayTotals.cacheReadTokens ?? null,
			cacheWriteTokens: relayTotals.cacheWriteTokens ?? null,
			requests: relayTotals.requests ?? null
		}
	};
	tokens.delta =
		dsh && relayPrompt !== null
			? {
					promptTokens: relayPrompt - dshPrompt,
					outputTokens: (relayTotals.outputTokens ?? 0) - dsh.outputTokens,
					requests: (relayTotals.requests ?? 0) - dsh.requests
				}
			: null;
	tokens.deltaPercent =
		tokens.delta === null ? null : { promptTokens: pct(tokens.delta.promptTokens, dshPrompt) };

	// Cost. Five separate facts, never merged: our estimate, the relay's list
	// price, what the relay actually deducted, its internal quota unit, and the
	// wallet balance.
	const estimate = dshEstimate?.cost === null || dshEstimate === null ? null : money(dshEstimate.cost, dshEstimate.currency);
	const listCost = money(relayTotals.listCost ?? relayTotals.reportedCost ?? null, relay.currency);
	const actualCost = money(relayTotals.actualCost ?? null, relay.currency);
	const chargeToCompare = actualCost ?? listCost;

	const costDelta = subtractMoney(chargeToCompare, estimate);
	if (costDelta.currencyMismatch) {
		notes.push(
			`estimate is in ${estimate?.currency} and the relay reports ${chargeToCompare?.currency}; they are not converted`
		);
	}
	if (listCost !== null && actualCost !== null && listCost.amount !== actualCost.amount) {
		notes.push("the relay's list price and actually-deducted cost differ; the deducted figure is the one compared");
	}
	if (relay.capabilities?.recomputable === false) {
		notes.push("this relay does not publish its pricing ratios, so its charge cannot be independently recomputed");
	}

	return {
		...base,
		level,
		comparable: true,
		tokens,
		cost: {
			dshEstimate: estimate,
			relayListCost: listCost,
			relayActualCost: actualCost,
			quota: relayTotals.quota ?? null,
			delta: costDelta.amount,
			deltaCurrency: costDelta.currency,
			currencyMismatch: costDelta.currencyMismatch,
			deltaPercent: pct(costDelta.amount, estimate?.amount ?? null)
		},
		relayBalance: relay.balance
			? money(relay.balance.remaining ?? relay.balance.amount, relay.balance.currency)
			: null,
		verification:
			relay.verification ?? (relay.capabilities?.recomputable ? { available: true } : { available: false })
	};
}

/**
 * A one-line human summary of a reconciliation, suitable for a table cell.
 *
 * Deliberately says "cannot compare" rather than showing a zero, because a zero
 * in this column would be read as agreement.
 */
export function describe(result) {
	if (!result.comparable) return `${result.site}: cannot compare — ${result.reason}`;
	const { cost, tokens, level } = result;
	if (cost.currencyMismatch) {
		return `${result.site} [${level}]: estimate ${fmt(cost.dshEstimate)} vs charged ${fmt(
			cost.relayActualCost ?? cost.relayListCost
		)} — different currencies, not compared`;
	}
	if (cost.delta === null) {
		return `${result.site} [${level}]: ${tokens.relay.promptTokens ?? "?"} prompt tokens reported, no cost comparison available`;
	}
	const sign = cost.delta > 0 ? "+" : "";
	return `${result.site} [${level}]: charged ${fmt(cost.relayActualCost ?? cost.relayListCost)} vs estimate ${fmt(
		cost.dshEstimate
	)} (${sign}${cost.delta} ${cost.deltaCurrency}${cost.deltaPercent === null ? "" : `, ${sign}${cost.deltaPercent}%`})`;
}

function fmt(m) {
	if (m === null || m === undefined) return "n/a";
	return `${m.amount}${m.currency ? ` ${m.currency}` : ""}`;
}

/**
 * Reconcile several sites at once.
 *
 * @param sites - array of `reconcileSite` inputs.
 * @returns `{ results, comparable, incomparable, level }` where `level` is the
 *   weakest level across everything that could be compared — a report is only
 *   as strong as its weakest row, and presenting a mixed set at the strongest
 *   row's level is how a summary-only site gets mistaken for a verified one.
 */
export function reconcileAll(sites) {
	const results = sites.map((input) => reconcileSite(input));
	const comparable = results.filter((r) => r.comparable);
	return {
		results,
		comparable: comparable.length,
		incomparable: results.length - comparable.length,
		level: comparable.reduce((acc, r) => weaker(acc, r.level), "request")
	};
}
