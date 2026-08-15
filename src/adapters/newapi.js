/**
 * New API relay-site billing adapter. Read-only.
 *
 * Endpoints and response shapes here were read from New API's router source and
 * then confirmed against a live deployment on 2026-08-14, not taken from docs.
 *
 * ## The quota unit is not money
 *
 * New API bills in an internal integer called `quota`. Turning it into money
 * needs two site-configured numbers from `/api/status`:
 *
 * ```text
 * USD = quota / quota_per_unit            # quota_per_unit is 500000 by convention
 * CNY = USD * price                       # `price` is what the site charges per unit
 * ```
 *
 * Both are site settings, so the same quota figure means different money at
 * different relays. Quota, USD, and the display currency are therefore kept as
 * three separate fields and converted only on explicit request.
 *
 * ## Its prompt_tokens is not our inputTokens
 *
 * This is the trap that makes naive reconciliation report constant false
 * discrepancies. New API's `prompt_tokens` is the **whole** prompt side and
 * already contains `other.cache_tokens`. DSH's `TokenUsage.inputTokens`
 * **excludes** cache. The correct comparison is:
 *
 * ```text
 * newapi.prompt_tokens      ↔  dsh.inputTokens + dsh.cacheReadTokens + dsh.cacheWriteTokens
 * newapi.other.cache_tokens ↔  dsh.cacheReadTokens
 * newapi.completion_tokens  ↔  dsh.outputTokens
 * ```
 *
 * `inputTotal()` in the usage module computes the left-hand side of the first
 * line, which is why reconciliation compares against that rather than against
 * `inputTokens`.
 *
 * ## The charge can be recomputed, not just read
 *
 * Every ratio New API used is recorded on the row, so the adapter derives what
 * the charge should have been and compares it with what was charged:
 *
 * ```text
 * quota = round( (effectivePrompt + completion * completion_ratio)
 *                * model_ratio * group_ratio )
 * ```
 *
 * `effectivePrompt` is where the conventions diverge — see {@link VARIANTS}.
 * Rounding is half-away-from-zero, matching Go's `math.Round`, and the whole
 * expression is evaluated as an exact rational rather than in floating point.
 *
 * Measured against a live deployment on 2026-08-14: of 1960 consumption rows,
 * the OpenAI-convention rows reproduce exactly once the arithmetic is exact,
 * and the Anthropic-convention rows need the second variant — scored under the
 * first they yield a negative expected charge. Rows priced per call
 * (`model_price >= 0`) or missing ratios are reported unverifiable rather than
 * silently passed.
 *
 * A charge that no known convention reproduces is reported as **unexplained**,
 * not as an overcharge. See {@link verifyCharge}.
 *
 * @module dsh-tokenledger/adapters/newapi
 */

/** Log `type` for consumption rows. Other types are logins, top-ups, admin ops. */
export const CONSUME_LOG_TYPE = 2;

/** New API's conventional quota-per-unit, used only when a site omits it. */
export const DEFAULT_QUOTA_PER_UNIT = 500_000;

/** What a set of facts can honestly support in a comparison. */
export const LEVELS = Object.freeze({ REQUEST: "request", AGGREGATE: "aggregate", SUMMARY: "summary" });

const dayKeyUtcOffset = (unixSeconds, offsetMinutes) => {
	const d = new Date((unixSeconds + offsetMinutes * 60) * 1000);
	const m = String(d.getUTCMonth() + 1).padStart(2, "0");
	return `${d.getUTCFullYear()}-${m}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

/**
 * How a row's `prompt_tokens` relates to its `cache_tokens`. New API records
 * both conventions depending on the upstream it proxied, and getting this wrong
 * inverts the arithmetic — an Anthropic row scored under the OpenAI convention
 * produces a *negative* expected charge.
 */
const VARIANTS = [
	{
		// OpenAI convention: prompt_tokens is the whole prompt side, cache included.
		name: "openai",
		effective: ({ prompt, cache, cacheWrite, r }) =>
			addFraction(
				{ n: (prompt - cache) * r.cache.d, d: r.cache.d },
				addFraction(
					{ n: cache * r.cache.n, d: r.cache.d },
					{ n: cacheWrite * r.cacheCreation.n, d: r.cacheCreation.d }
				)
			)
	},
	{
		// Anthropic convention: prompt_tokens is uncached input only, and cache
		// creation is a third bucket at its own ratio.
		name: "anthropic",
		effective: ({ prompt, cache, cacheWrite, r }) =>
			addFraction(
				{ n: prompt, d: 1n },
				addFraction(
					{ n: cache * r.cache.n, d: r.cache.d },
					{ n: cacheWrite * r.cacheCreation.n, d: r.cacheCreation.d }
				)
			)
	},
	{
		// Some rows record cache figures that were not billed at all.
		name: "prompt-only",
		effective: ({ prompt }) => ({ n: prompt, d: 1n })
	}
];

/**
 * Check a consumption row's charge against the ratios the row itself records.
 *
 * The conclusion on a mismatch is deliberately **"cannot explain this charge"**,
 * not "you were overcharged". New API's billing shape varies with the upstream
 * it proxied and with its own version, so an unrecognized row is far more likely
 * to be a gap in this adapter's knowledge than theft by the relay. A
 * reconciliation tool that cries wolf on its own blind spots is worse than none.
 *
 * @param row - a raw `/api/log/self` or `/api/log/token` item.
 * @returns `{ verifiable, consistent, variant, expectedQuota, chargedQuota,
 *   delta, candidates, reason? }`. When `consistent` is true, `variant` names
 *   the convention that reproduced the charge exactly. When it is false,
 *   `candidates` lists what each known convention would have charged, so the
 *   difference can be judged rather than guessed at.
 */
export function verifyCharge(row) {
	const other = parseOther(row.other);
	const charged = Number(row.quota ?? 0);
	const unverifiable = (reason) => ({
		verifiable: false,
		consistent: null,
		variant: null,
		expectedQuota: null,
		chargedQuota: charged,
		delta: null,
		candidates: [],
		reason
	});

	if (other === undefined) return unverifiable("no ratio detail");
	if (Number(other.model_price) >= 0) return unverifiable("per-call flat price");
	if (typeof other.model_ratio !== "number") return unverifiable("no model_ratio");

	const prompt = BigInt(Math.trunc(Number(row.prompt_tokens ?? 0)));
	const completion = BigInt(Math.trunc(Number(row.completion_tokens ?? 0)));
	const cache = BigInt(Math.trunc(Number(other.cache_tokens ?? 0)));
	const cacheWrite = BigInt(
		Math.trunc(Number(other.cache_write_tokens ?? other.cache_creation_tokens ?? 0))
	);

	// Exact rational arithmetic, not floating point. The naive float version is
	// wrong on roughly 2% of real rows: 2.5 * 0.35 evaluates to
	// 0.8749999999999999, which drags a charge whose true value is exactly
	// 14360.5 down to 14360.499999999998 and rounds it the wrong way. A phantom
	// one-unit overcharge on 2% of requests would bury the real ones.
	const r = {
		cache: toFraction(other.cache_ratio ?? 1),
		cacheCreation: toFraction(other.cache_creation_ratio ?? 1),
		completion: toFraction(other.completion_ratio ?? 1),
		model: toFraction(other.model_ratio),
		group: toFraction(other.group_ratio ?? 1)
	};

	const candidates = VARIANTS.map((variant) => {
		let acc = variant.effective({ prompt, cache, cacheWrite, r });
		acc = addFraction(acc, { n: completion * r.completion.n, d: r.completion.d });
		acc = { n: acc.n * r.model.n * r.group.n, d: acc.d * r.model.d * r.group.d };
		return { variant: variant.name, quota: Number(roundHalfAwayFromZero(acc)) };
	});

	// Prefer the convention the row declares, then any exact match.
	const declared = other.usage_semantic === "anthropic" || other.claude === true ? "anthropic" : "openai";
	const ordered = [
		...candidates.filter((c) => c.variant === declared),
		...candidates.filter((c) => c.variant !== declared)
	];
	const hit = ordered.find((c) => c.quota === charged);

	if (hit !== undefined) {
		return {
			verifiable: true,
			consistent: true,
			variant: hit.variant,
			// A charge explained only by a fallback convention is weaker evidence
			// than one explained by the convention the row itself declares. The
			// `prompt-only` fallback in particular coincides with `openai` whenever
			// `cache_ratio` is 1, so it can absorb a genuine discrepancy. Callers
			// that care about strength must read this rather than `consistent`.
			matchedDeclared: hit.variant === declared,
			expectedQuota: hit.quota,
			chargedQuota: charged,
			delta: 0,
			candidates
		};
	}

	const best = ordered[0];
	return {
		verifiable: true,
		consistent: false,
		variant: null,
		expectedQuota: best.quota,
		chargedQuota: charged,
		delta: charged - best.quota,
		candidates,
		reason: "no known pricing convention reproduces this charge"
	};
}

/** Decimal number → exact `{ n, d }` BigInt fraction. */
function toFraction(value) {
	const text = String(value);
	const exponent = text.indexOf("e") >= 0 || text.indexOf("E") >= 0 ? Number(text.split(/e/i)[1]) : 0;
	const mantissa = exponent === 0 ? text : text.split(/e/i)[0];
	const dot = mantissa.indexOf(".");
	const digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
	let scale = dot < 0 ? 0 : mantissa.length - dot - 1;
	scale -= exponent;
	let n = BigInt(digits);
	let d = 1n;
	if (scale > 0) d = 10n ** BigInt(scale);
	else if (scale < 0) n *= 10n ** BigInt(-scale);
	return { n, d };
}

function addFraction(a, b) {
	return { n: a.n * b.d + b.n * a.d, d: a.d * b.d };
}

/** Round a fraction the way Go's `math.Round` does: halves go away from zero. */
function roundHalfAwayFromZero({ n, d }) {
	const negative = n < 0n !== d < 0n;
	const an = n < 0n ? -n : n;
	const ad = d < 0n ? -d : d;
	const quotient = an / ad;
	const remainder = an % ad;
	const rounded = remainder * 2n >= ad ? quotient + 1n : quotient;
	return negative ? -rounded : rounded;
}

function parseOther(other) {
	if (other === undefined || other === null || other === "") return undefined;
	if (typeof other === "object") return other;
	try {
		return JSON.parse(other);
	} catch {
		return undefined;
	}
}

/**
 * Money conversion parameters read from `/api/status`.
 */
export function readQuotaUnits(status) {
	const data = status?.data ?? status ?? {};
	return {
		quotaPerUnit: Number(data.quota_per_unit) || DEFAULT_QUOTA_PER_UNIT,
		pricePerUnit: typeof data.price === "number" ? data.price : undefined,
		displayCurrency: data.quota_display_type ?? undefined,
		usdExchangeRate: typeof data.usd_exchange_rate === "number" ? data.usd_exchange_rate : undefined
	};
}

/**
 * Convert quota into money using a site's own parameters.
 *
 * @returns `{ quota, usd, display, currency }`. `usd` and `display` are null
 *   when the site did not publish the parameter needed, never zero and never
 *   guessed from another site's settings.
 */
export function quotaToMoney(quota, units) {
	const amount = Number(quota ?? 0);
	const usd = units.quotaPerUnit > 0 ? round6(amount / units.quotaPerUnit) : null;
	const display =
		usd !== null && units.pricePerUnit !== undefined ? round6(usd * units.pricePerUnit) : null;
	return { quota: amount, usd, display, currency: units.displayCurrency };
}

function round6(v) {
	return Math.round(v * 1e6) / 1e6;
}

/**
 * Normalize a consumption row into the shape reconciliation compares against.
 * Token names are kept, request content is not — this adapter never reads or
 * carries prompt or response bodies, because New API does not expose them here
 * and TokenLedger would not store them if it did.
 */
export function normalizeRow(row, units, options = {}) {
	const other = parseOther(row.other) ?? {};
	const offset = options.utcOffsetMinutes ?? 0;
	const promptTokens = Number(row.prompt_tokens ?? 0);
	const cachedTokens = Number(other.cache_tokens ?? 0);
	return {
		at: Number(row.created_at ?? 0) * 1000,
		day: dayKeyUtcOffset(Number(row.created_at ?? 0), offset),
		model: row.model_name ?? "",
		requestId: row.request_id ?? undefined,
		upstreamRequestId: row.upstream_request_id ?? undefined,
		tokenName: row.token_name ?? undefined,
		group: row.group ?? other.billing_source ?? undefined,
		requests: 1,
		// Whole prompt side, cache included — matches inputTotal() on the DSH side.
		promptTokens,
		cachedTokens,
		uncachedPromptTokens: promptTokens - cachedTokens,
		completionTokens: Number(row.completion_tokens ?? 0),
		streamed: Boolean(row.is_stream),
		...quotaToMoney(row.quota, units),
		verification: verifyCharge(row)
	};
}

/**
 * Read-only client for one New API deployment.
 *
 * Credentials are supplied as a getter so the caller can keep them in an
 * OS-protected store and this object never holds a long-lived copy. They travel
 * in an `Authorization` header only — never a query string, which would leak
 * into browser history, reverse-proxy logs and any diagnostic bundle.
 */
export class NewApiClient {
	#origin;
	#getCredential;
	#userId;
	#fetch;

	/**
	 * @param options - `{ origin, getCredential, userId?, fetch? }`.
	 *   `getCredential()` returns `{ mode: 'pat' | 'key', value }`.
	 *   `userId` is required for PAT mode; New API expects it in `New-Api-User`.
	 */
	constructor(options) {
		const origin = String(options.origin ?? "").replace(/\/+$/, "");
		if (origin === "") throw new TypeError("NewApiClient requires an origin");
		this.#origin = origin;
		this.#getCredential = options.getCredential;
		this.#userId = options.userId;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async #get(path, params = {}) {
		const url = new URL(this.#origin + path);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
		}
		if (/key|token|secret|password/i.test(url.search)) {
			throw new Error("refusing to put a credential in a query string");
		}
		const credential = await this.#getCredential();
		const headers = { accept: "application/json", authorization: `Bearer ${credential.value}` };
		if (credential.mode === "pat" && this.#userId !== undefined) {
			headers["new-api-user"] = String(this.#userId);
		}
		const response = await this.#fetch(url, { headers });
		const body = await response.json().catch(() => ({}));
		if (!response.ok || body.success === false) {
			const error = new Error(`New API ${path} failed: ${response.status} ${body.message ?? ""}`.trim());
			error.status = response.status;
			throw error;
		}
		return body;
	}

	/** Site money parameters. Public on most deployments. */
	async units() {
		return readQuotaUnits(await this.#get("/api/status"));
	}

	/**
	 * Account balance and lifetime totals. PAT mode.
	 * @returns a `summary`-level fact — cumulative only, not attributable to a
	 *   time window, so it can never support a per-period comparison.
	 */
	async summary(units) {
		const body = await this.#get("/api/user/self");
		const data = body.data ?? {};
		return {
			level: LEVELS.SUMMARY,
			fetchedAt: Date.now(),
			group: data.group,
			requestCount: Number(data.request_count ?? 0),
			remaining: quotaToMoney(data.quota, units),
			used: quotaToMoney(data.used_quota, units)
		};
	}

	/**
	 * Per-day, per-model aggregates over a window. PAT mode.
	 *
	 * `token_used` here is the site's own combined token count; it is reported
	 * as-is and never split into prompt and completion, because the endpoint does
	 * not say how it was combined.
	 */
	async aggregate({ from, to, utcOffsetMinutes = 0 }, units) {
		const body = await this.#get("/api/data/self", {
			start_timestamp: Math.floor(from / 1000),
			end_timestamp: Math.floor(to / 1000),
			default_time: "day"
		});
		const rows = (body.data ?? []).map((row) => ({
			day: dayKeyUtcOffset(Number(row.created_at ?? 0), utcOffsetMinutes),
			model: row.model_name ?? "",
			requests: Number(row.count ?? 0),
			combinedTokens: Number(row.token_used ?? 0),
			...quotaToMoney(row.quota, units)
		}));
		return { level: LEVELS.AGGREGATE, fetchedAt: Date.now(), window: { from, to }, rows };
	}

	/**
	 * Request-level consumption rows over a window.
	 *
	 * PAT mode reads `/api/log/self`; key mode reads `/api/log/token`, which is
	 * scoped to that one key. Both are `TokenAuthReadOnly`/`UserAuth` GETs.
	 *
	 * The returned level is `request` because the rows are individual calls —
	 * but that describes the *relay's* side only. A comparison may still be
	 * `aggregate` if the DSH side cannot be joined call-for-call, which it
	 * currently cannot: DSH's session log records no provider request id.
	 */
	async requests({ from, to, utcOffsetMinutes = 0, pageSize = 100, maxPages = 20 }, units) {
		const credential = await this.#getCredential();
		const path = credential.mode === "key" ? "/api/log/token" : "/api/log/self";
		const rows = [];
		let truncated = false;

		for (let page = 1; page <= maxPages; page++) {
			const body = await this.#get(path, {
				p: page,
				page_size: pageSize,
				type: CONSUME_LOG_TYPE,
				start_timestamp: Math.floor(from / 1000),
				end_timestamp: Math.floor(to / 1000)
			});
			const items = body.data?.items ?? body.data ?? [];
			for (const item of items) rows.push(normalizeRow(item, units, { utcOffsetMinutes }));
			if (items.length < pageSize) break;
			if (page === maxPages) truncated = true;
		}

		return { level: LEVELS.REQUEST, fetchedAt: Date.now(), window: { from, to }, rows, truncated };
	}
}

/**
 * Collapse request rows into per-day, per-model totals, carrying the
 * verification outcome forward.
 *
 * `unverifiedRequests` is surfaced rather than folded away: a day where half the
 * rows could not be recomputed is not the same as a day that reconciled, and
 * flattening the two is how a reconciliation tool starts lying.
 */
export function summarizeRows(rows) {
	const byKey = new Map();
	for (const row of rows) {
		const key = `${row.day}\u0000${row.model}`;
		let bucket = byKey.get(key);
		if (bucket === undefined) {
			bucket = {
				day: row.day,
				model: row.model,
				requests: 0,
				promptTokens: 0,
				cachedTokens: 0,
				uncachedPromptTokens: 0,
				completionTokens: 0,
				quota: 0,
				expectedQuota: 0,
				unverifiedRequests: 0,
				currency: row.currency
			};
			byKey.set(key, bucket);
		}
		bucket.requests += row.requests;
		bucket.promptTokens += row.promptTokens;
		bucket.cachedTokens += row.cachedTokens;
		bucket.uncachedPromptTokens += row.uncachedPromptTokens;
		bucket.completionTokens += row.completionTokens;
		bucket.quota += row.quota;
		if (row.verification.consistent === true) bucket.expectedQuota += row.verification.expectedQuota;
		else bucket.unverifiedRequests += 1;
	}
	return [...byKey.values()]
		.map((b) => ({ ...b, quotaDelta: b.unverifiedRequests === 0 ? b.quota - b.expectedQuota : null }))
		.sort((a, b) => (a.day === b.day ? b.quota - a.quota : a.day < b.day ? -1 : 1));
}
