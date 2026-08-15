/**
 * Relay-software fingerprinting and adapter selection.
 *
 * ## Why this exists
 *
 * An API key does not say which relay it belongs to — the **base URL** does.
 * The key only proves you may call it. So identity comes from the origin, and
 * *capability* comes from knowing which software that origin runs.
 *
 * ## Why adapters are per-software, not per-site
 *
 * There are thousands of relay sites and a handful of relay *programs*. Every
 * site running New API answers `/api/status` and bills in the same internal
 * quota unit; every Sub2API answers `/v1/usage` and bills in real currency. One
 * adapter covers every deployment of its software, so the adapter count tracks
 * the software ecosystem, not the site list. Several of these programs are also
 * forks of one another and share routes, which is why a fingerprint scores
 * families rather than matching one exact string.
 *
 * ## Why a fingerprint works at all
 *
 * The programs disagree about which routes exist, and an absent route answers
 * 404 while a present one answers 401. That difference needs no credential.
 * Measured on two live sites, 2026-08-14:
 *
 * ```text
 * endpoint            Sub2API   New API
 * /api/status           404       200
 * /v1/usage             401       404
 * /api/usage/token      404       401
 * /api/log/self         404       401
 * /api/v1/usage         401       404
 * ```
 *
 * Disjoint, so an unauthenticated probe identifies the software.
 *
 * ## What happens to an unknown relay
 *
 * It still works, with less. {@link GENERIC} reports that no billing source was
 * recognized, and reconciliation falls back to DSH-side figures alone — usage
 * accounting keeps working, only the comparison is unavailable. An unrecognized
 * site is never guessed into a known adapter, because reading a Sub2API balance
 * with New API's quota conversion would produce a confident wrong number, which
 * is worse than an honest gap.
 *
 * @module dsh-tokenledger/adapters/detect
 */

import { normalizeOrigin } from "../relay-sites.js";

/** A route answering anything other than 404 is taken to exist. */
const EXISTS = (status) => status !== 404 && status !== 0;

/**
 * Known relay programs and the routes that distinguish them.
 *
 * `required` routes must exist, `absent` routes must not. Both directions
 * matter: New API and Sub2API each have a `/v1/...` usage-ish route, and only
 * the negative evidence separates a fork cleanly.
 */
export const SIGNATURES = [
	{
		software: "newapi",
		// One API, VoAPI and other forks of this lineage share these routes and
		// the quota unit, so they score here too and get a usable adapter.
		family: "oneapi-lineage",
		required: ["/api/status", "/api/usage/token"],
		absent: ["/v1/usage"],
		supporting: ["/api/log/self", "/api/data/self"]
	},
	{
		software: "sub2api",
		family: "sub2api",
		required: ["/v1/usage"],
		absent: ["/api/status", "/api/usage/token"],
		supporting: ["/api/v1/usage"]
	}
];

/** Every route any signature cares about, probed once each. */
export const PROBE_PATHS = [
	...new Set(SIGNATURES.flatMap((s) => [...s.required, ...s.absent, ...(s.supporting ?? [])]))
];

/** The result for an origin no signature claims. */
export const GENERIC = Object.freeze({
	software: "unknown",
	family: null,
	confidence: 0,
	billingAvailable: false,
	reason: "no known relay program recognized at this origin"
});

/**
 * Score an already-collected probe table against every signature.
 *
 * Separated from the network so it is testable, and so a caller that already
 * knows a site's software can skip probing entirely.
 *
 * @param statuses - `{ [path]: httpStatus }`.
 * @returns `{ software, family, confidence, billingAvailable, evidence }` for
 *   the best match, or {@link GENERIC}. `confidence` is the fraction of the
 *   signature's routes that agreed, so a partial match is visible rather than
 *   being rounded up to certainty.
 */
export function scoreFingerprint(statuses) {
	const results = [];

	for (const signature of SIGNATURES) {
		const evidence = [];
		let agreed = 0;
		let total = 0;
		let disqualified = false;

		for (const path of signature.required) {
			total++;
			const present = EXISTS(statuses[path]);
			evidence.push({ path, expected: "present", status: statuses[path], ok: present });
			if (present) agreed++;
			else disqualified = true;
		}
		for (const path of signature.absent) {
			total++;
			const present = EXISTS(statuses[path]);
			evidence.push({ path, expected: "absent", status: statuses[path], ok: !present });
			if (!present) agreed++;
			else disqualified = true;
		}
		for (const path of signature.supporting ?? []) {
			if (statuses[path] === undefined) continue;
			total++;
			const present = EXISTS(statuses[path]);
			evidence.push({ path, expected: "present", status: statuses[path], ok: present, supporting: true });
			if (present) agreed++;
		}

		if (disqualified) continue;
		results.push({
			software: signature.software,
			family: signature.family,
			confidence: total === 0 ? 0 : Math.round((agreed / total) * 100) / 100,
			billingAvailable: true,
			evidence
		});
	}

	if (results.length === 0) return { ...GENERIC, evidence: Object.entries(statuses).map(([path, status]) => ({ path, status })) };

	results.sort((a, b) => b.confidence - a.confidence);
	// Two signatures both fully satisfied means the fingerprint is not
	// discriminating; say so rather than picking the first one.
	if (results.length > 1 && results[0].confidence === results[1].confidence) {
		return {
			...results[0],
			ambiguous: results.map((r) => r.software),
			reason: "more than one relay program matches this origin equally well"
		};
	}
	return results[0];
}

/**
 * Probe an origin and identify its relay program. Unauthenticated: this asks
 * only which routes exist, never for data.
 *
 * @param origin - `scheme://host[:port]`.
 * @param options - `{ fetch?, timeoutMs?, paths? }`.
 */
export async function detectRelaySoftware(origin, options = {}) {
	const doFetch = options.fetch ?? globalThis.fetch;
	const paths = options.paths ?? PROBE_PATHS;
	// Every probe path is absolute from the origin, so anything after the host
	// must be dropped. Callers hand over a provider's configured base URL, which
	// normally ends in `/v1`: appending `/api/status` to that asks for
	// `https://host/v1/api/status`, which every relay answers 404. Six 404s then
	// disqualify every signature, and the site reports as unrecognized while the
	// same host fingerprints perfectly from its bare origin. That is a real
	// install's "unidentified", diagnosed only after the probe table was printed.
	const base = normalizeOrigin(origin) ?? String(origin).replace(/\/+$/, "");
	const statuses = {};

	await Promise.all(
		paths.map(async (path) => {
			try {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
				try {
					const response = await doFetch(base + path, {
						headers: { accept: "application/json" },
						signal: controller.signal
					});
					statuses[path] = response.status;
				} finally {
					clearTimeout(timer);
				}
			} catch {
				// A transport failure is not evidence of absence, and must not be
				// scored as a 404 that would flip a signature's negative test.
				statuses[path] = 0;
			}
		})
	);

	const scored = scoreFingerprint(statuses);
	if (scored.billingAvailable) return { origin: base, statuses, ...scored };
	// A failure to match is not automatically "this origin runs nothing we know".
	// Two common situations produce exactly the same empty score while meaning
	// something quite different, and both are actionable where the generic answer
	// is not.
	return { origin: base, statuses, ...scored, ...diagnoseMiss(statuses) };
}

/** `path=status` pairs, compact enough to put in a one-line reason. */
export function summarizeProbes(statuses) {
	return Object.entries(statuses)
		.map(([path, status]) => `${path}=${status === 0 ? "×" : status}`)
		.join(" ");
}

/**
 * Explain a score that matched nothing.
 *
 * The scorer only sees a status table, so every miss reads alike. But a table
 * of transport failures means the origin was never reached, and a table where
 * every route answers identically means the probe cannot discriminate — a WAF
 * or login wall answering 403 everywhere makes each signature's "this route
 * must NOT exist" test fail, disqualifying all of them. Reporting either as
 * "no known relay program recognized at this origin" claims more than the
 * evidence supports, and sends the reader looking for the wrong problem.
 *
 * @param statuses - `{ [path]: httpStatus }`, 0 for a transport failure.
 * @returns fields to merge over the generic result, always including the
 *   observed table so the reason can be checked rather than trusted.
 */
export function diagnoseMiss(statuses) {
	const values = Object.values(statuses);
	const summary = summarizeProbes(statuses);
	if (values.length === 0) return { reason: "没有探测任何路由" };

	if (values.every((s) => s === 0)) {
		return { unreachable: true, reason: `连不上这个 origin——每个探测请求都在传输层失败（${summary}）` };
	}
	const distinct = new Set(values);
	if (distinct.size === 1) {
		return {
			undiscriminating: true,
			reason: `所有探测路由都返回 ${[...distinct][0]}，无法区分是哪套程序——通常是 WAF 或登录墙挡在前面（${summary}）`
		};
	}
	return { reason: `没有匹配到已知的中转站程序（${summary}）` };
}
