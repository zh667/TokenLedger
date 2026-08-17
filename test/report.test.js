import assert from "node:assert/strict";
import test from "node:test";

import { compact, money, num, renderReport, sparkline, table } from "../src/report.js";
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

test("an empty range explains itself instead of printing an empty table", () => {
	const text = renderReport({ range: {}, days: [], models: [], sites: [] });
	assert.ok(text.includes("没有记录到任何用量"));
	assert.ok(text.includes("reindex"), "the report should say how to force a rebuild");
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

test("with no relays configured the report shows provider routes, not a useless direct row", () => {
	const text = renderReport({
		range: {},
		days: [{ day: "2026-08-14", tokens: 47_085, requests: 3 }],
		models: [{ model: "deepseek-v4-pro", inputTokens: 27_492, cacheReadTokens: 18_560, outputTokens: 1033, cacheHitRate: 40.3 }],
		sites: [{ site: "direct", tokens: 47_085 }],
		providers: [{ provider: "deepseek-official", tokens: 47_085 }]
	});
	assert.ok(text.includes("Provider 路由分布"));
	assert.ok(text.includes("deepseek-official"));
	assert.equal(text.includes("中转站分布"), false, "one useless row is worse than the real breakdown");
	// Sites are discovered from DSH's provider configuration, so an empty list
	// normally means "direct". Telling a direct user to write `relays` — which is
	// what this line used to do — was instructions for a problem they do not have.
	assert.ok(text.includes("直连的话这就是全部"));
	assert.ok(text.includes("site add"), "and the one actionable case still has a way out");
	assert.equal(text.includes("relays:"), false, "no longer asks for hand-written config");
});

test("once a relay is configured the site breakdown takes over", () => {
	const text = renderReport({
		range: {},
		days: [{ day: "2026-08-14", tokens: 100, requests: 1 }],
		models: [],
		sites: [{ site: "api.relay-one.example", tokens: 90 }, { site: "direct", tokens: 10 }],
		providers: [{ provider: "ninerelay", tokens: 90 }, { provider: "official", tokens: 10 }]
	});
	assert.ok(text.includes("中转站分布"));
	assert.ok(text.includes("api.relay-one.example"));
	assert.equal(text.includes("Provider 路由分布"), false);
});

// --- the command body, against a real store -------------------------------

const seeded = () => {
	const store = LedgerStore.open(":memory:");
	const state = store.loadState("s");
	applyUsageDelta(state, [message(1, "p", "gpt", { inputTokens: 1000, outputTokens: 100 })]);
	store.commitSession("s", state);
	return store;
};

test("diagnostics says which route landed in which bucket", async () => {
	// Three rounds of debugging a missing relay row went by without this,
	// reasoning about the resolver from the outside — while the answer sat in
	// the index the whole time, because the rollup row keys on the ROUTE name.
	const { LedgerStore } = await import("../src/store.js");
	const { RelaySiteRegistry, createSiteResolver } = await import("../src/relay-sites.js");
	const { applyUsageDelta } = await import("../src/usage.js");

	const registry = new RelaySiteRegistry([{ id: "relay.example", type: "newapi", baseUrl: "https://relay.example/v1" }]);
	const providerBaseUrls = { nine: "https://relay.example/v1", official: "https://api.deepseek.com" };
	const directory = { sites: registry.list(), providerBaseUrls, resolveSite: createSiteResolver(registry, providerBaseUrls) };

	const store = LedgerStore.open(":memory:");
	try {
		// Folded when the directory did NOT yet know the relay, which is how the
		// traffic ends up somewhere its current configuration disagrees with.
		const past = createSiteResolver(new RelaySiteRegistry([]), {});
		const state = store.loadState("s1");
		applyUsageDelta(
			state,
			[
				{
					seq: 1,
					time: Date.parse("2026-08-17T10:00:00Z"),
					type: "assistant/message",
					data: { turn: 1, step: 1, message: { role: "assistant", source: { kind: "model", provider: "nine", model: "v4" } }, usage: { inputTokens: 900, outputTokens: 0 } }
				}
			],
			{ resolveSite: past }
		);
		store.commitSession("s1", state, {});

		const text = await runCommand("diagnostics", { store, sites: () => directory.sites, directory: () => directory });

		// Half one: what the CURRENT configuration says.
		assert.match(text, /路由归属/);
		assert.match(text, /nine\s+https:\/\/relay\.example\/v1\s+relay\.example/, "the route resolves now");
		assert.match(text, /official\s+https:\/\/api\.deepseek\.com\s+直连/, "and this one really is direct");

		// Half two: where the traffic actually sits, which is the half that
		// exposes the disagreement.
		assert.match(text, /索引里的路由/);
		assert.match(text, /未知路由\s+nine\s+900/, "the route name is what makes this diagnosable");
		assert.match(text, /用同一个路由名把它配回去/, "and it has to say what to do about it");
	} finally {
		store.close();
	}
});

test("diagnostics is honest when there is no directory to report", async () => {
	const { LedgerStore } = await import("../src/store.js");
	const store = LedgerStore.open(":memory:");
	try {
		const text = await runCommand("diagnostics", { store, sites: () => [] });
		assert.match(text, /自动发现没有看到任何带 baseURL 的 provider 路由/);
		assert.match(text, /索引里还没有任何用量/);
		// A composition with no relays is a normal state, not a fault, and the
		// wording has to leave room for that while naming the other causes.
		assert.match(text, /这本身可能是对的/);
	} finally {
		store.close();
	}
});

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
		// A word that names no site is now a mistake to report, not a filter to
		// honour: rendering an empty report headed "site: nowhere" reads as a
		// finding about your usage rather than a typo.
		const filtered = await runCommand("30 nowhere", { store, config: {} });
		assert.ok(filtered.includes("不认识"));
		assert.equal(filtered.includes("1,100"), false, "and it must not show other sites' numbers");
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

test("each model row carries its request count, so a percentage can be read", () => {
	// Without n on the row, a single request reporting 11.7% cache hits invites
	// the conclusion that a relay caches badly, when the only honest reading is
	// that one request is not a sample.
	const text = renderReport({
		range: {},
		days: [{ day: "2026-08-15", tokens: 30_781, requests: 1 }],
		models: [
			{ model: "gpt-5.6-sol", requests: 1, inputTokens: 27_162, cacheReadTokens: 3584, outputTokens: 35, cacheHitRate: 11.7 }
		],
		sites: []
	});
	const row = text.split("\n").find((l) => l.includes("gpt-5.6-sol"));
	assert.ok(/\s1\s/.test(row), `no request count on the row: ${row}`);
	assert.ok(row.includes("11.7%"));
	assert.ok(text.includes("请求"), "and the column is labelled");
});
