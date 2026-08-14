/**
 * TokenLedger public surface.
 *
 * @module tokenledger
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
