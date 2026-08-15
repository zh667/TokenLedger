/**
 * TokenLedger public surface.
 *
 * @module dsh-tokenledger
 */

export {
	DIRECT,
	UNKNOWN,
	applyUsageDelta,
	bucketsOf,
	byModel,
	bySite,
	cacheHitRate,
	createUsageState,
	dayKey,
	foldUsage,
	inputTotal,
	mergeInto,
	parseRouteKey,
	renderUsage,
	routeKey,
	sumRange,
	totalTokens,
	zeroBuckets
} from "./usage.js";

export {
	RelaySiteRegistry,
	SITE_TYPES,
	createSiteResolver,
	credentialFingerprint,
	defineSite,
	domainOf,
	normalizeOrigin
} from "./relay-sites.js";

export {
	DEEPSEEK_OFF_PEAK,
	RATE_BUCKETS,
	RateTable,
	defineRate,
	definePeriod,
	estimateCost,
	inPeriod,
	priceRows
} from "./pricing.js";

export { LedgerStore, SCHEMA_VERSION } from "./store.js";

export {
	CONSUME_LOG_TYPE,
	DEFAULT_QUOTA_PER_UNIT,
	LEVELS,
	NewApiClient,
	normalizeRow,
	quotaToMoney,
	readQuotaUnits,
	summarizeRows,
	verifyCharge
} from "./adapters/newapi.js";

export { Sub2ApiClient, normalizeUsage } from "./adapters/sub2api.js";

export {
	GENERIC,
	PROBE_PATHS,
	SIGNATURES,
	detectRelaySoftware,
	scoreFingerprint
} from "./adapters/detect.js";

export {
	INCOMPARABLE,
	LEVEL_ORDER,
	describe,
	reconcileAll,
	reconcileSite,
	relayLevel
} from "./reconcile.js";

export { compact, money, num, reasonText, renderReconciliation, renderReport, sparkline, table } from "./report.js";

// The package root is BOTH the library barrel and the Cordis plugin, and it has
// to be: the client-module scanner treats a Loader entry's name as a package
// specifier and resolves `<name>/package.json` from it. A subpath entry name
// like `dsh-tokenledger/plugin` fails that resolve, the failure is swallowed as
// "not a client package", and the verdict is cached forever — so the browser
// half never loads and nothing says why. The entry name must be the bare
// package name, which makes this file the plugin.
export { apply, buildResolver, inject, name, normalizeRelayConfig, runCommand, sweep } from "./plugin.js";

export { discoverFromContext, discoverSites, mergeSites, readAtPath } from "./discovery.js";

export { BASE_PATH, USAGE_PATH, BALANCE_PATH, parseQuery, registerRoutes, screenRequest, usagePayload } from "./http.js";

export { SCHEMES, createBalanceReader, isOfficialDeepSeek, listAccounts, readBalance } from "./balance.js";
