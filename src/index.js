/**
 * TokenLedger's public surface.
 *
 * ## The rule
 *
 * This entry point exports two things and nothing else:
 *
 * 1. **The Cordis plugin contract** — `apply`, `inject`, `name`. The loader
 *    entry in `cordis.patch.yml` names the bare package, so DSH loads *this*
 *    module as the plugin and these three are what it looks for.
 * 2. **The library entry the README documents** — the usage fold and its two
 *    standard rollups, for a consumer outside DSH.
 *
 * ## Why it is this short
 *
 * It used to re-export 88 symbols, including `zeroBuckets`, `normalizeRow`,
 * `parseRouteKey`, `scoreFingerprint`. There was no line between what this
 * package promises and what happens to be defined inside it, and the cost was
 * concrete: every internal rename became a breaking change, which is what had
 * blocked cleaning up the modules underneath.
 *
 * Nothing became unreachable. Every module keeps its own subpath export in
 * `package.json` — `dsh-tokenledger/store`, `/balance`, `/pricing`, `/usage`,
 * and the rest — so a consumer who wants an internal reaches for it by name and
 * can see from the import that it is one.
 *
 * @module dsh-tokenledger
 */

export { apply, inject, name } from "./plugin.js";

export { byModel, bySite, foldUsage } from "./usage.js";
