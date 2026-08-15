/**
 * The usage report, rendered as monospace text.
 *
 * A chat stream is the surface, so the report is typography rather than
 * layout: fixed columns, digits that line up, and no glyph doing decorative
 * work. Three rules keep it readable in a window whose width nobody controls.
 *
 * **Numbers align on their last digit.** Token counts are right-aligned and
 * thousands-separated so magnitude reads at a glance; a column of
 * left-aligned numbers is a column nobody compares.
 *
 * **A missing figure prints an em dash, never a zero.** The reconciliation
 * engine is careful to return null rather than 0, and the renderer must not
 * undo that at the last step — `0` in a cost column reads as free.
 *
 * **The evidence level travels with every relay row.** It is the one thing
 * this report says that no other usage plugin does, and burying it in a
 * footnote would waste the whole design.
 *
 * @module dsh-tokenledger/report
 */

import { INCOMPARABLE } from "./reconcile.js";

const DASH = "—";

/** The route component the fold writes when DSH reported no provider. */
const UNKNOWN_LABEL = "unknown";

/**
 * Display text for the engine's stable reason identifiers.
 *
 * The identifiers stay English so callers can branch on them; only what a human
 * reads is translated. An unknown reason falls through verbatim rather than
 * being swallowed — a missing translation should look like a missing
 * translation, not like no reason at all.
 */
const REASON_TEXT = new Map([
	[INCOMPARABLE.NO_BILLING, "认不出这个中转站跑的是哪套软件，没有账单侧可比"],
	[INCOMPARABLE.NO_READER, "没有为这个站配置账单读取器，从未去取过它自己的数字"],
	[INCOMPARABLE.WINDOW_MISMATCH, "该站只提供生涯累计，回答不了带时间窗的问题"],
	[INCOMPARABLE.NO_RELAY_DATA, "该站没有返回可用的账单数字"],
	[INCOMPARABLE.NO_DSH_DATA, "这个区间内 DSH 没有记录到该站的用量"]
]);

/** Translate a reason for display, leaving anything unmapped intact. */
export function reasonText(reason) {
	return REASON_TEXT.get(reason) ?? reason;
}

/** Thousands-separated integer, or an em dash for nothing. */
export function num(value) {
	if (value === null || value === undefined) return DASH;
	return Number(value).toLocaleString("en-US");
}

/** Compact magnitude for wide columns: 1.83M, 54.5K, 947. */
export function compact(value) {
	if (value === null || value === undefined) return DASH;
	const n = Number(value);
	if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}K`;
	return n.toLocaleString("en-US");
}

/** Money with its currency, or an em dash. Never bare zero for "unknown". */
export function money(amount, currency) {
	if (amount === null || amount === undefined) return DASH;
	const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
	const text = Math.abs(amount) < 0.01 && amount !== 0 ? amount.toFixed(6) : amount.toFixed(4);
	return symbol === "" ? `${text} ${currency ?? ""}`.trim() : `${symbol}${text}`;
}

function pad(text, width, align = "left") {
	const s = String(text);
	// Count display width crudely: CJK glyphs occupy two columns.
	const w = [...s].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 2 : 1), 0);
	const fill = " ".repeat(Math.max(0, width - w));
	return align === "right" ? fill + s : s + fill;
}

/** Render a table from a column spec and rows. */
export function table(columns, rows) {
	const widths = columns.map((c, i) =>
		Math.max(
			[...String(c.title)].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0),
			...rows.map((r) => {
				const s = String(r[i] ?? "");
				return [...s].reduce((n, ch) => n + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
			})
		)
	);
	const line = (cells) =>
		cells.map((cell, i) => pad(cell, widths[i], columns[i].align ?? "left")).join("  ").trimEnd();
	return [line(columns.map((c) => c.title)), ...rows.map(line)];
}

/** A sparkline over daily totals, or an empty string when there is nothing. */
export function sparkline(values) {
	if (values.length === 0) return "";
	const bars = "▁▂▃▄▅▆▇█";
	const max = Math.max(...values);
	if (max <= 0) return bars[0].repeat(values.length);
	return values.map((v) => bars[Math.min(bars.length - 1, Math.round((v / max) * (bars.length - 1)))]).join("");
}

/**
 * The evidence badge for a relay row. The reconciliation engine already
 * refuses to overstate; this only renders what it decided.
 */
function badge(reconciliation) {
	if (reconciliation === undefined) return "";
	if (!reconciliation.comparable) return "⚠ 无法比对";
	const tick = reconciliation.tokens?.delta?.promptTokens === 0 ? " ✓" : "";
	return `〔${reconciliation.level}${tick}〕`;
}

/**
 * Render the usage report.
 *
 * @param input - `{ range, days, models, sites, reconciliations?, priced?,
 *   fetchedAt?, width? }` where `days`/`models`/`sites` come straight from the
 *   store's query methods and `reconciliations` maps site id to a
 *   `reconcileSite` result.
 * @returns markdown-safe monospace text.
 */
export function renderReport(input) {
	const {
		range,
		days = [],
		models = [],
		sites = [],
		reconciliations = {},
		providers = [],
		priced = null,
		siteFilter
	} = input;

	const out = [];
	const rangeLabel = range?.from && range?.to ? `${range.from} 至 ${range.to}` : range?.from ? `${range.from} 起` : "全部时间";
	out.push(`── 用量 ${"─".repeat(40)}`);
	out.push(`  ${rangeLabel}${siteFilter ? ` · 中转站：${siteFilter}` : " · 中转站：全部"}`);
	out.push("");

	const total = days.reduce(
		(acc, d) => {
			acc.tokens += d.tokens;
			acc.requests += d.requests;
			return acc;
		},
		{ tokens: 0, requests: 0 }
	);

	if (total.requests === 0) {
		out.push("  这个区间内没有记录到任何用量。");
		out.push("");
		out.push("  如果你确信用过：采集器按会话日志的 revision 增量扫描，");
		out.push("  新会话最多一个扫描周期后出现；`reindex` 可强制全量重建。");
		return out.join("\n");
	}

	const costLine = priced?.totals ? Object.entries(priced.totals).map(([c, v]) => money(v, c)).join(" + ") : DASH;
	out.push(`  ${num(total.tokens)} tokens      ${costLine} 估算      ${num(total.requests)} 请求`);
	const spark = sparkline(days.map((d) => d.tokens));
	if (spark !== "") out.push(`  ${spark}`);
	out.push("");

	// Models are the primary dimension.
	const modelRows = models.map((m) => {
		const p = priced?.rows?.find((r) => r.model === m.model);
		const hit = m.cacheHitRate === null ? "" : `(${m.cacheHitRate}%)`;
		return [
			m.model,
			num(m.requests),
			num(m.inputTokens),
			`${num(m.cacheReadTokens)}${hit}`,
			num(m.outputTokens),
			p === undefined || p.cost === null ? DASH : money(p.cost, p.currency)
		];
	});
	out.push(
		...table(
			[
				{ title: "模型" },
				// The request count is what makes the cache percentage readable. A
				// single request cannot have a meaningful hit rate — it either found
				// a prefix already cached or it did not — and without n on the row,
				// 11.7% invites the conclusion that a relay is caching badly.
				{ title: "请求", align: "right" },
				{ title: "输入", align: "right" },
				{ title: "缓存", align: "right" },
				{ title: "输出", align: "right" },
				{ title: "估算", align: "right" }
			],
			modelRows
		).map((l) => `  ${l}`)
	);

	if (priced?.unpricedModels?.length) {
		out.push(`  ${DASH} 表示该模型没有配置费率，不是没花钱。未定价：${priced.unpricedModels.join("、")}`);
	}

	// Attribution has two levels. Provider routes are free — the name rides every
	// record — so any install answers "where did it go". Relay sites are the
	// grouping by origin, discovered from the host's provider configuration
	// rather than configured here, and the level that can carry billing evidence.
	const configured = sites.some((s) => s.site !== "direct");
	out.push("");
	if (configured) {
		out.push("  中转站分布");
		const siteRows = sites.map((s) => {
			const r = reconciliations[s.site];
			return [s.site === "direct" ? "直连/官方" : s.site, num(s.tokens), badge(r)];
		});
		out.push(...table([{ title: "" }, { title: "tokens", align: "right" }, { title: "" }], siteRows).slice(1).map((l) => `  ${l}`));
	} else if (providers.length > 0) {
		out.push("  Provider 路由分布");
		const rows = providers.map((p) => [p.provider === UNKNOWN_LABEL ? "未知路由" : p.provider, num(p.tokens)]);
		out.push(...table([{ title: "" }, { title: "tokens", align: "right" }], rows).slice(1).map((l) => `  ${l}`));
		out.push("");
		// Sites are read from DSH's own provider configuration, so an empty site
		// list normally means "direct", not "you forgot to configure something".
		// Only the case where that read failed is actionable, and it is the one
		// this line names.
		out.push("  没有发现中转站——直连的话这就是全部。");
		out.push("  如果你在用中转站却没显示，用 `/tokenledger site add <路由名> <地址>` 补一条。");
	}

	// Anything the comparison refused to do is stated, not omitted.
	const refused = Object.entries(reconciliations).filter(([, r]) => !r.comparable);
	if (refused.length > 0) {
		out.push("");
		for (const [site, r] of refused) {
			out.push(`  ⚠ ${site}：${reasonText(r.reason)}`);
			if (r.relayBalance) out.push(`     余额 ${money(r.relayBalance.amount, r.relayBalance.currency)}`);
		}
	}

	const notes = Object.values(reconciliations).flatMap((r) => r.notes ?? []);
	if (notes.length > 0) {
		out.push("");
		for (const note of [...new Set(notes)]) out.push(`  · ${note}`);
	}

	return out.join("\n");
}

/**
 * Render the reconciliation view: one block per site, our figures beside the
 * relay's.
 */
export function renderReconciliation(results) {
	const out = [`── 对账 ${"─".repeat(40)}`, ""];
	if (results.length === 0) {
		out.push("  还没有配置任何中转站，所以没有账单侧可比。");
		out.push("");
		out.push("  用量统计不受影响——`/tokenledger` 已经按 Provider 路由归属。");
		out.push("  要对账，在插件配置里加 `relays`，每个中转站一行：");
		out.push("");
		out.push("    - id: tokenledger");
		out.push("      config:");
		out.push("        relays:");
		out.push("          你的路由名: https://中转站域名/v1");
		return out.join("\n");
	}

	for (const r of results) {
		out.push(`  ${r.site}  ${badge(r)}`);
		if (!r.comparable) {
			out.push(`  ⚠ ${reasonText(r.reason)}`);
			if (r.relayBalance) out.push(`     余额 ${money(r.relayBalance.amount, r.relayBalance.currency)}`);
			out.push("");
			continue;
		}
		const rows = [
			["prompt", num(r.tokens.dsh?.promptTokens), num(r.tokens.relay.promptTokens), signed(r.tokens.delta?.promptTokens)],
			["output", num(r.tokens.dsh?.outputTokens), num(r.tokens.relay.outputTokens), signed(r.tokens.delta?.outputTokens)],
			["请求", num(r.tokens.dsh?.requests), num(r.tokens.relay.requests), signed(r.tokens.delta?.requests)],
			[
				"费用",
				money(r.cost.dshEstimate?.amount, r.cost.dshEstimate?.currency),
				money((r.cost.relayActualCost ?? r.cost.relayListCost)?.amount, (r.cost.relayActualCost ?? r.cost.relayListCost)?.currency),
				r.cost.currencyMismatch ? "币种不同" : signedMoney(r.cost.delta, r.cost.deltaCurrency)
			]
		];
		out.push(
			...table(
				[{ title: "" }, { title: "TokenLedger 算的", align: "right" }, { title: "站点收的", align: "right" }, { title: "差", align: "right" }],
				rows
			).map((l) => `  ${l}`)
		);
		for (const note of r.notes ?? []) out.push(`  · ${note}`);
		out.push("");
	}
	return out.join("\n").trimEnd();
}

function signed(v) {
	if (v === null || v === undefined) return DASH;
	if (v === 0) return "0";
	return v > 0 ? `+${num(v)}` : num(v);
}

function signedMoney(v, currency) {
	if (v === null || v === undefined) return DASH;
	if (v === 0) return "0";
	return (v > 0 ? "+" : "") + money(v, currency).replace(/^([¥$])-/, "-$1");
}
