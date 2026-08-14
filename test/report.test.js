import assert from "node:assert/strict";
import test from "node:test";

import { compact, money, num, reasonText, renderReconciliation, renderReport, sparkline, table } from "../src/report.js";
import { INCOMPARABLE, reconcileSite } from "../src/reconcile.js";
import { runCommand } from "../src/plugin.js";
import { LedgerStore } from "../src/store.js";
import { applyUsageDelta } from "../src/usage.js";

const DAY = Date.parse("2026-08-14T10:00:00");
let seq = 0;
const ev = (type, data) => ({ type, seq: seq++, time: DAY, data });
const message = (turn, provider, model, usage) =>
	ev("assistant/message", {
		turn,
		step: 1,
		message: { role: "assistant", source: { kind: "model", provider, model } },
		usage
	});

test("a missing figure renders as an em dash, never a zero", () => {
	assert.equal(num(null), "—");
	assert.equal(money(null, "CNY"), "—");
	assert.equal(compact(undefined), "—");
	assert.equal(num(0), "0", "an actual zero is still a measurement and prints as one");
	assert.equal(money(0, "CNY"), "¥0.0000");
});

test("money carries its currency and does not lose small amounts to rounding", () => {
	assert.equal(money(0.4381, "CNY"), "¥0.4381");
	assert.equal(money(28.76783, "USD"), "$28.7678");
	assert.equal(money(0.000006, "CNY"), "¥0.000006", "a sub-cent delta must not round to zero");
	assert.equal(money(1.5, "EUR"), "1.5000 EUR");
});

/** Display width, counting CJK glyphs as two columns. */
const displayWidth = (s) => [...s].reduce((n, c) => n + (/[　-鿿＀-￯]/.test(c) ? 2 : 1), 0);

test("columns align on display width, counting CJK as two", () => {
	const lines = table([{ title: "站点" }, { title: "tokens", align: "right" }], [
		["直连/官方", "0"],
		["nine", "30,483"]
	]);
	assert.equal(lines.length, 3);
	// A right-aligned final column means every line ends at the same column —
	// unless CJK width was miscounted, which is the whole failure mode here.
	const widths = lines.map(displayWidth);
	assert.deepEqual(widths, [widths[0], widths[0], widths[0]], `ragged right edge: ${JSON.stringify(lines)}`);
	assert.ok(lines[1].startsWith("直连/官方"));
	assert.ok(lines[2].endsWith("30,483"));
});

test("a byte-length implementation would fail the alignment test above", () => {
	// Guards the guard: if the CJK rule were dropped, these two would differ.
	assert.notEqual(displayWidth("直连/官方"), "直连/官方".length);
	assert.equal(displayWidth("直连/官方"), 9);
});

test("the sparkline scales to its own maximum and survives all-zero input", () => {
	assert.equal(sparkline([]), "");
	assert.equal(sparkline([0, 0, 0]), "▁▁▁");
	const s = sparkline([1, 5, 10]);
	assert.equal(s.length, 3);
	assert.equal(s.at(-1), "█");
});

test("reasons are translated for display but the identifiers stay stable", () => {
	assert.notEqual(reasonText(INCOMPARABLE.WINDOW_MISMATCH), INCOMPARABLE.WINDOW_MISMATCH);
	assert.ok(reasonText(INCOMPARABLE.NO_READER).includes("账单读取器"));
	assert.equal(reasonText("something new upstream"), "something new upstream", "an unmapped reason must not vanish");
});

test("no-reader and unrecognized-software are different reasons", () => {
	const noReader = reconcileSite({ site: "s", dsh: null, relay: null, readerConfigured: false });
	const unknown = reconcileSite({ site: "s", dsh: null, relay: null });
	assert.equal(noReader.reason, INCOMPARABLE.NO_READER);
	assert.equal(unknown.reason, INCOMPARABLE.NO_BILLING);
	assert.notEqual(reasonText(noReader.reason), reasonText(unknown.reason));
});

test("an empty range explains itself instead of printing an empty table", () => {
	const text = renderReport({ range: {}, days: [], models: [], sites: [] });
	assert.ok(text.includes("没有记录到任何用量"));
	assert.ok(text.includes("reindex"), "the report should say how to force a rebuild");
});

test("the evidence badge rides the site row, not a footnote", () => {
	const text = renderReport({
		range: { from: "2026-08-14" },
		days: [{ day: "2026-08-14", tokens: 100, requests: 1 }],
		models: [{ model: "m", inputTokens: 90, cacheReadTokens: 0, outputTokens: 10, cacheHitRate: null }],
		sites: [{ site: "nine", tokens: 100 }],
		reconciliations: {
			nine: { site: "nine", comparable: true, level: "aggregate", tokens: { delta: { promptTokens: 0 } }, notes: [] }
		}
	});
	const siteLine = text.split("\n").find((l) => l.includes("nine"));
	assert.ok(siteLine.includes("〔aggregate ✓〕"), `badge missing from: ${siteLine}`);
});

test("an unpriced model is called out so an em dash is not read as free", () => {
	const text = renderReport({
		range: {},
		days: [{ day: "2026-08-14", tokens: 100, requests: 1 }],
		models: [{ model: "mystery", inputTokens: 100, cacheReadTokens: 0, outputTokens: 0, cacheHitRate: null }],
		sites: [],
		priced: { rows: [{ model: "mystery", cost: null }], totals: {}, unpricedModels: ["mystery"] }
	});
	assert.ok(text.includes("不是没花钱"));
	assert.ok(text.includes("mystery"));
});

test("a refused comparison is printed, not omitted", () => {
	const text = renderReport({
		range: { from: "2026-08-01" },
		days: [{ day: "2026-08-14", tokens: 10, requests: 1 }],
		models: [],
		sites: [{ site: "sub", tokens: 10 }],
		reconciliations: {
			sub: {
				site: "sub",
				comparable: false,
				reason: INCOMPARABLE.WINDOW_MISMATCH,
				relayBalance: { amount: 4.768, currency: "USD" },
				notes: []
			}
		}
	});
	assert.ok(text.includes("⚠ 无法比对"));
	assert.ok(text.includes("生涯累计"));
	assert.ok(text.includes("$4.7680"), "the balance is still worth showing when the comparison is refused");
});

test("the reconciliation view shows both sides and the difference", () => {
	const result = reconcileSite({
		site: "nine",
		dsh: { inputTokens: 640, cacheReadTokens: 11_776, cacheWriteTokens: 0, outputTokens: 149, reasoningTokens: 0, requests: 1 },
		relay: {
			level: "aggregate",
			fetchedAt: 1,
			window: { from: 0, to: 1 },
			currency: "CNY",
			capabilities: { perRequest: false, perModel: true, perDay: true, recomputable: true, windowed: true },
			total: { promptTokens: 12_416, outputTokens: 149, requests: 1, quota: 11_646, listCost: 0.17 }
		},
		dshEstimate: { cost: 0.17, currency: "CNY" },
		window: { from: "a", to: "b" }
	});
	const text = renderReconciliation([result]);
	assert.ok(text.includes("TokenLedger 算的"));
	assert.ok(text.includes("站点收的"));
	assert.ok(text.includes("12,416"));
	assert.ok(text.includes("〔aggregate ✓〕"));
});

test("renderReconciliation with nothing configured says so", () => {
	const text = renderReconciliation([]);
	assert.ok(text.includes("还没有配置任何中转站"));
	assert.ok(text.includes("providerBaseUrls"));
});

// --- the command body, against a real store -------------------------------

const seeded = () => {
	const store = LedgerStore.open(":memory:");
	const state = store.loadState("s");
	applyUsageDelta(state, [message(1, "p", "gpt", { inputTokens: 1000, outputTokens: 100 })]);
	store.commitSession("s", state);
	return store;
};

test("the command renders a report from the store", async () => {
	const store = seeded();
	try {
		const text = await runCommand("", { store, config: {} });
		assert.ok(text.includes("1,100 tokens"));
		assert.ok(text.includes("gpt"));
	} finally {
		store.close();
	}
});

test("a day argument narrows the range, a word argument filters the site", async () => {
	const store = seeded();
	try {
		assert.ok((await runCommand("30", { store, config: {} })).includes("起"));
		const filtered = await runCommand("30 nowhere", { store, config: {} });
		assert.ok(filtered.includes("中转站：nowhere"));
		assert.ok(filtered.includes("没有记录到任何用量"), "a filter matching nothing must not show other sites' numbers");
	} finally {
		store.close();
	}
});

test("reindex reports what it did rather than rendering a report", async () => {
	const store = seeded();
	try {
		const text = await runCommand("reindex", {
			store,
			config: {},
			reindex: async () => ({ scanned: 3, updated: 1, failed: 0 })
		});
		assert.ok(text.includes("已重建索引"));
		assert.ok(text.includes("扫描 3"));
	} finally {
		store.close();
	}
});

test("the command sweeps before reporting so figures are not stale", async () => {
	const store = seeded();
	let swept = 0;
	try {
		await runCommand("", { store, config: {}, sweep: async () => void swept++ });
		assert.equal(swept, 1);
	} finally {
		store.close();
	}
});

test("a site with no billing reader is reported as unread, not as agreeing", async () => {
	const store = seeded();
	try {
		const text = await runCommand("reconcile", {
			store,
			config: { sites: [{ id: "nine", type: "newapi", baseUrl: "https://relay.example.com" }] }
		});
		assert.ok(text.includes("账单读取器"));
		assert.equal(text.includes("〔aggregate"), false, "never imply a clean bill it has not earned");
	} finally {
		store.close();
	}
});

test("a billing reader that throws degrades to unread rather than failing the command", async () => {
	const store = seeded();
	try {
		const text = await runCommand("reconcile", {
			store,
			config: {
				sites: [{ id: "nine", type: "newapi", baseUrl: "https://relay.example.com" }],
				billing: {
					nine: async () => {
						throw new Error("relay down");
					}
				}
			},
			logger: { warn() {} }
		});
		assert.ok(text.includes("nine"));
		assert.ok(text.includes("⚠"));
	} finally {
		store.close();
	}
});
