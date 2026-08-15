/**
 * The `tokenledger` user-settings namespace.
 *
 * Isolated in its own module, and loaded with a dynamic import, because it is
 * the one part of this package that needs a dependency. Everything else runs on
 * Node built-ins. If `@deepseek-ai/schemastery` is missing — a composition
 * assembled by hand, an upstream that moved it — the import fails here, the
 * plugin logs it and carries on with its entry config, and no other capability
 * is lost.
 *
 * ## Why register at all
 *
 * Two things, neither available from entry config alone:
 *
 * - configuration lands in the `settings.yaml` the user already edits, instead
 *   of in `cordis.patch.yml`, which most users never open;
 * - `watch` makes an edit take effect without restarting DSH.
 *
 * Registration is also the prerequisite for writing: `update()` only works on a
 * registered namespace, which is what lets `/tokenledger site add` persist
 * without the user opening a file at all.
 *
 * @module dsh-tokenledger/settings-schema
 */

/**
 * Build the namespace schema.
 *
 * @param z - the schemastery module's default export.
 * @returns the schema for the `tokenledger` settings section.
 */
export function buildSchema(z) {
	// A relay may be written as a bare URL — the common case, and the shortest
	// thing that can express it — or as an object when something needs
	// overriding. Both forms mean the same site.
	const relay = z.union([
		z.string(),
		z.object({
			baseUrl: z.string(),
			id: z.string(),
			displayName: z.string(),
			type: z.string()
		})
	]);

	return z.object({
		/**
		 * Relay overrides, keyed by DSH provider route. Normally empty: sites are
		 * discovered from the host's own provider configuration. An entry here is
		 * for what discovery cannot see — a composition with no settings provider,
		 * or a provider mounted by an agent preset.
		 */
		relays: z.dict(relay),
		/** Origins that are a vendor's own endpoint, so not a relay site. */
		officialOrigins: z.array(z.string()),
		/** Rollup database path. */
		database: z.string().default("tokenledger.sqlite"),
		/** Milliseconds between background sweeps; 0 disables the timer. */
		sweepIntervalMs: z.number().step(1).min(0).default(60_000),
		/** Whether to sweep once at startup. */
		sweepOnStart: z.boolean().default(true),
		/**
		 * Rate table for cost estimation. Left unvalidated on purpose: rates are a
		 * nested, evolving shape owned by `pricing.js`, which already reports a
		 * malformed table by dropping the cost column rather than failing. A
		 * schema here would be a second, drifting definition of the same thing.
		 */
		rates: z.any()
	});
}

/** The namespace this plugin owns. */
export const NAMESPACE = "tokenledger";

/**
 * Register the namespace and keep the resolved value current.
 *
 * @param settings - the `settings` service, from `ctx.get('settings')`.
 * @param base - the plugin's entry config, which becomes the composition layer
 *   beneath the user's document section.
 * @param onChange - called with each newly resolved value, including the first.
 * @returns `{ scope, value }`, or undefined if registration was not possible.
 */
export async function registerNamespace(settings, base, onChange) {
	const { default: z } = await import("@deepseek-ai/schemastery");
	const scope = settings.register(NAMESPACE, buildSchema(z), { base });
	const value = scope.get();
	onChange?.(value);
	scope.watch?.((next) => onChange?.(next));
	return { scope, value };
}
