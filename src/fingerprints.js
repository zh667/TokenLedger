/**
 * Which relay program each site runs, and how confident we are.
 *
 * ## Why this is its own module
 *
 * It was four containers and two closures inside `apply()`, which meant the
 * only way to exercise it was to mount the whole plugin. Both bugs a real
 * install found lived here — a fingerprint written onto a directory object that
 * the next sweep threw away, and a probe that was never retried because the
 * "already asked" guard ran before the answer was stored — and neither had a
 * test, because there was no seam to write one against.
 *
 * ## The four pieces of state, and why none of them collapses into another
 *
 * - `software` — the answer. Keyed by site id and held **outside** the site
 *   directory, because the directory is rebuilt from scratch on every sweep. An
 *   earlier version wrote the answer onto the site object, so it survived until
 *   the next rebuild and then every site read "unidentified" forever, while the
 *   asked-guard made sure nothing ever asked again.
 * - `asked` — who has been probed. Separate from `software` because a site that
 *   was probed and came back unrecognized must not be probed again on the next
 *   sweep, and it has no entry in `software` to show for it.
 * - `probes` — what happened. Without it, three different situations collapse
 *   into one "unidentified": still running, probe failed, and genuinely matches
 *   no known program. Only one of those is worth retrying, and telling them
 *   apart otherwise means reading the DSH log.
 * - `inFlight` — what is still running, so a command can wait briefly for an
 *   answer that is nearly there.
 *
 * @module dsh-tokenledger/fingerprints
 */

import { detectRelaySoftware } from "./adapters/detect.js";

/**
 * @param options - `{ detect?, enabled?, logger?, onLearn? }`. `detect` is
 *   injectable so this can be driven without reaching the network. `onLearn` is
 *   called with the software map whenever it gains an entry, which is how a
 *   caller keeps a derived view current without this module knowing about it.
 * @returns `{ software, learn, request, settle, status }`.
 */
export function createFingerprintRegistry(options = {}) {
	const { detect = detectRelaySoftware, enabled = false, logger, onLearn } = options;

	const software = new Map();
	const asked = new Set();
	const probes = new Map();
	const inFlight = new Set();

	const learn = (id, name) => {
		software.set(id, name);
		onLearn?.(software);
	};

	/**
	 * Probe one relay once, in the background.
	 *
	 * Off unless asked for. Knowing whether a relay runs New API or Sub2API
	 * decides which balance scheme reads it — but the balance card already
	 * triggers that probe lazily, for the one site being asked about. Eager
	 * fingerprinting would instead mean several unauthenticated requests to a
	 * third party, per relay, at mount, for an answer usually never needed.
	 */
	const request = (site) => {
		if (!enabled) return;
		if (site.type !== undefined || asked.has(site.id)) return;
		asked.add(site.id);
		probes.set(site.id, { state: "pending" });

		const settled = detect(site.baseUrl).then(
			(result) => {
				if (result.billingAvailable) {
					learn(site.id, result.software);
					probes.set(site.id, { state: "identified", confidence: result.confidence });
				} else {
					probes.set(site.id, {
						state: "unrecognized",
						reason: result.ambiguous === undefined ? result.reason : `多个程序同样匹配：${result.ambiguous.join("、")}`
					});
				}
				logger?.info?.("tokenledger: %s looks like %s (confidence %s)", site.id, result.software, result.confidence);
			},
			(error) => {
				// A probe that could not be made is a different fact from one that
				// came back inconclusive, and only one of them is worth retrying.
				probes.set(site.id, { state: "failed", reason: error?.message ?? String(error) });
				logger?.warn?.("tokenledger: could not fingerprint %s: %s", site.id, error?.message ?? error);
			}
		);

		inFlight.add(settled);
		void settled.finally(() => inFlight.delete(settled));
	};

	/**
	 * Wait for probes started just now, but never for long.
	 *
	 * `/tokenledger site` refreshes and then renders synchronously, so on the
	 * first run after a restart every site read "unidentified" — not because
	 * detection had failed but because it had not finished. A short wait turns
	 * that into a real answer; a bounded one keeps an unreachable relay from
	 * holding the command open.
	 */
	const settle = (ms = 2500) =>
		inFlight.size === 0
			? Promise.resolve()
			: Promise.race([Promise.allSettled([...inFlight]), new Promise((resolve) => setTimeout(resolve, ms).unref?.())]);

	/** A snapshot, so a caller cannot mutate the registry by holding the map. */
	const status = () => new Map(probes);

	return { software, learn, request, settle, status };
}
