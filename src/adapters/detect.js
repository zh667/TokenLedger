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
 * @module tokenledger/adapters/detect
 */

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
	const base = String(origin).replace(/\/+$/, "");
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

	return { origin: base, statuses, ...scoreFingerprint(statuses) };
}
