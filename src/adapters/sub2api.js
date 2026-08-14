/**
 * Sub2API relay-site billing adapter. Read-only.
 *
 * Confirmed against a live deployment on 2026-08-14. Its shape is nothing like
 * New API's, which is the concrete reason relay adapters exist at all:
 *
 * | | New API | Sub2API |
 * |---|---|---|
 * | money unit | internal `quota` int, needs `/api/status` to convert | real currency, `unit: "USD"` |
 * | granularity | per-request logs | today + lifetime totals only |
 * | prompt tokens | include cache (OpenAI convention) | exclude cache, like DSH |
 * | ratios exposed | yes, charge is recomputable | no |
 * | cost figures | one | **two** — `cost` and `actual_cost` |
 *
 * ## Two cost figures, and they disagree
 *
 * A live account showed `cost: 0.33138075` against `actual_cost: 0.231966525`
 * for the same traffic — a 30% gap. They are list price and what was actually
 * deducted, and collapsing them into "the cost" would either overstate the bill
 * or hide the discount. Both are carried through, unreconciled, and the
 * reconciliation layer decides which one a given question is about.
 *
 * ## What this adapter cannot do
 *
 * `daily_usage` is present in the response but came back empty under every
 * window parameter tried (`days`, `start`/`end`, `start_date`/`end_date`,
 * `detail`). With an API key this deployment therefore exposes cumulative
 * totals and a today bucket, and nothing else — `summary` level, no time
 * window, no per-model split, and no way to recompute a charge. Saying so is
 * the point; a comparison built on this must not claim more.
 *
 * @module tokenledger/adapters/sub2api
 */

import { LEVELS } from "./newapi.js";

export { LEVELS };

/** Token buckets Sub2API reports, in its own naming. */
const BUCKETS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens"];

function normalizeBuckets(raw = {}) {
	const inputTokens = Number(raw.input_tokens ?? 0);
	const cacheReadTokens = Number(raw.cache_read_tokens ?? 0);
	const cacheWriteTokens = Number(raw.cache_creation_tokens ?? 0);
	return {
		requests: Number(raw.requests ?? 0),
		// Sub2API's input_tokens excludes cache, matching DSH's inputTokens. That
		// is the opposite of New API, and assuming either convention globally is
		// how a reconciler invents discrepancies.
		inputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		outputTokens: Number(raw.output_tokens ?? 0),
		promptTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
		reportedTotalTokens: raw.total_tokens === undefined ? undefined : Number(raw.total_tokens),
		// List price and what was actually deducted. Never merged.
		listCost: raw.cost === undefined ? null : Number(raw.cost),
		actualCost: raw.actual_cost === undefined ? null : Number(raw.actual_cost)
	};
}

/**
 * Normalize a raw `/v1/usage` body.
 *
 * @param body - the parsed response.
 * @returns a `summary`-level fact: cumulative `total`, a `today` bucket, the
 *   wallet balance, and an explicit statement of what is missing.
 */
export function normalizeUsage(body) {
	const usage = body?.usage ?? {};
	const currency = body?.unit ?? undefined;
	const dailyRows = Array.isArray(body?.daily_usage) ? body.daily_usage : [];

	return {
		level: LEVELS.SUMMARY,
		fetchedAt: Date.now(),
		window: null,
		currency,
		keyValid: body?.isValid !== false,
		plan: { name: body?.planName ?? undefined, mode: body?.mode ?? undefined },
		balance: {
			amount: body?.balance === undefined ? null : Number(body.balance),
			remaining: body?.remaining === undefined ? null : Number(body.remaining),
			currency
		},
		total: normalizeBuckets(usage.total),
		today: normalizeBuckets(usage.today),
		rate: {
			rpm: usage.rpm === undefined ? undefined : Number(usage.rpm),
			tpm: usage.tpm === undefined ? undefined : Number(usage.tpm),
			averageDurationMs:
				usage.average_duration_ms === undefined ? undefined : Number(usage.average_duration_ms)
		},
		daily: dailyRows.map((row) => ({
			day: row.date ?? row.day ?? undefined,
			...normalizeBuckets(row)
		})),
		capabilities: {
			perRequest: false,
			perModel: false,
			// A deployment that populates daily_usage upgrades itself to aggregate.
			perDay: dailyRows.length > 0,
			recomputable: false,
			windowed: false
		}
	};
}

/**
 * Read-only client for one Sub2API deployment.
 *
 * The credential is fetched through a getter and sent as an `Authorization`
 * header. There is no query-string form, and the client refuses to build one.
 */
export class Sub2ApiClient {
	#origin;
	#getCredential;
	#fetch;

	constructor(options) {
		const origin = String(options.origin ?? "").replace(/\/+$/, "");
		if (origin === "") throw new TypeError("Sub2ApiClient requires an origin");
		this.#origin = origin;
		this.#getCredential = options.getCredential;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async #get(path) {
		const url = new URL(this.#origin + path);
		if (/key|token|secret|password/i.test(url.search)) {
			throw new Error("refusing to put a credential in a query string");
		}
		const credential = await this.#getCredential();
		const response = await this.#fetch(url, {
			headers: { accept: "application/json", authorization: `Bearer ${credential.value}` }
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			const error = new Error(`Sub2API ${path} failed: ${response.status} ${body.message ?? ""}`.trim());
			error.status = response.status;
			throw error;
		}
		return body;
	}

	/** Key-scoped usage, balance, and plan. The only billing view a key affords. */
	async usage() {
		return normalizeUsage(await this.#get("/v1/usage"));
	}

	/** Models the key may call. Useful for attribution, not for billing. */
	async models() {
		const body = await this.#get("/v1/models");
		return (body?.data ?? []).map((m) => ({
			id: m.id,
			type: m.type ?? undefined,
			displayName: m.display_name ?? undefined
		}));
	}
}
