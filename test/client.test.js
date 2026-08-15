/**
 * The browser half, materialized in Node.
 *
 * There is no build step, so the bundle is a plain script that calls
 * `window.__ModuleLoader__.load({id, factory})`. That makes it loadable here
 * with a stub loader, a stub `require`, and a minimal DOM — enough to prove the
 * factory runs, the seat registers, and the panel renders, none of which a
 * screenshot would tell us and all of which break silently in a browser.
 */

import assert from "node:assert/strict";
import test from "node:test";

/** Enough of `document` for the one-time style injection. */
function fakeDom() {
	const children = [];
	const head = { children, appendChild: (tag) => void children.push(tag) };
	return {
		head,
		querySelector: (selector) =>
			children.find((tag) => selector.includes(JSON.stringify(tag.dataset.pluginCss))) ?? null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
}

/** React's jsx runtime, recorded rather than rendered. */
const jsxRuntime = {
	jsx: (type, props, key) => ({ type, props, key }),
	jsxs: (type, props, key) => ({ type, props, key })
};

/** Load the bundle and return its exports plus what it registered. */
async function loadBundle(options = {}) {
	const registered = [];
	const effects = [];
	const dictionaries = [];
	const dom = options.document ?? fakeDom();
	let materialized;

	globalThis.window = {
		__ModuleLoader__: {
			load: ({ id, factory }) => {
				assert.equal(id, "dsh-tokenledger", "the id must match the package name");
				materialized = factory((name) => {
					if (name === "react") return reactStub;
					if (name === "react/jsx-runtime") return jsxRuntime;
					if (name === "@deepseek-ai/dsh-client-ui-primitives") {
						return { IconDataOutline16: "IconData", IconRefreshOutline14: "IconRefresh", IconCloseOutline16: "IconClose" };
					}
					throw new Error(`unexpected require: ${name}`);
				});
			}
		},
		addEventListener() {},
		removeEventListener() {}
	};
	globalThis.document = dom;

	// A React stub that records hooks rather than running a renderer: the panel
	// only needs useState/useEffect/useCallback to be callable for its module
	// body and one render pass to be observable.
	let stateCells = [];
	let cell = 0;
	const reactStub = {
		useState: (initial) => {
			const index = cell++;
			if (!(index in stateCells)) stateCells[index] = typeof initial === "function" ? initial() : initial;
			return [stateCells[index], (next) => {
				stateCells[index] = typeof next === "function" ? next(stateCells[index]) : next;
			}];
		},
		useEffect: (fn) => void effects.push(fn),
		useCallback: (fn) => fn,
		useRef: (initial) => ({ current: initial })
	};

	await import(`../src/client.js?t=${Date.now()}`);

	return {
		exports: materialized,
		dom,
		registered,
		effects,
		dictionaries,
		render: (Component, props) => {
			cell = 0;
			stateCells = [];
			return Component(props);
		},
		setState: (index, value) => {
			stateCells[index] = value;
		},
		renderWithState: (Component, props, cells) => {
			cell = 0;
			stateCells = cells.slice();
			return Component(props);
		}
	};
}

test("the bundle registers a factory under the package id and exports its seat", async () => {
	const { exports } = await loadBundle();
	assert.equal(typeof exports.apply, "function");
	assert.deepEqual(exports.inject, ["slots", "locale"]);
	assert.equal(typeof exports.TokenLedgerPanel, "function");
});

test("styles are injected once, tagged so a re-execution can find them", async () => {
	const { dom } = await loadBundle();
	assert.equal(dom.head.children.length, 1);

	// HMR re-executes the bundle against the live document. Without the guard
	// every reload appends another copy of the sheet, and the tab accumulates
	// them until something else breaks.
	await loadBundle({ document: dom });
	assert.equal(dom.head.children.length, 1, "a second execution appended a duplicate stylesheet");

	const tag = dom.head.children[0];
	assert.equal(tag.dataset.plugin, "dsh-tokenledger");
	assert.ok(tag.textContent.includes(".tkl_panel"));
	// Every colour must come from a DSH token or a scoped --tkl-* value, or the
	// panel will not follow the user's theme.
	assert.ok(tag.textContent.includes("var(--dsw-alias-bg-base)"));
	assert.ok(tag.textContent.includes("var(--dsw-alias-border-l1)"));
});

test("the activity ramp is defined for both themes and for an explicit choice", async () => {
	// A colour whose only definition sits inside a media query is wrong the
	// moment a user picks a theme that disagrees with their system.
	const { dom } = await loadBundle();
	const css = dom.head.children[0].textContent;
	assert.ok(css.includes("--tkl-level-0"));
	assert.ok(css.includes("prefers-color-scheme:dark"));
	assert.ok(css.includes("[data-theme='dark'] .tkl_panel"));
	assert.ok(css.includes("[data-theme='light'] .tkl_panel"));
});

test("apply registers dictionaries and the footer seat", async () => {
	const { exports } = await loadBundle();
	const registered = [];
	const dictionaries = [];
	exports.apply({
		effect: (fn) => fn(),
		locale: { register: (ns, dicts) => dictionaries.push([ns, dicts]) },
		slots: {
			inject: (name, run) => {
				assert.equal(name, "sidebar.footer.action", "the only seat open to third parties");
				run();
			},
			register: (spec, Component) => registered.push({ spec, Component })
		}
	});
	assert.equal(dictionaries[0][0], "tokenLedger");
	assert.deepEqual(Object.keys(dictionaries[0][1]).sort(), ["en", "zh"]);
	assert.equal(registered[0].spec.id, "tokenledger");
	assert.equal(registered[0].spec.locale, "tokenLedger");
	assert.equal(registered[0].Component, exports.TokenLedgerPanel);
});

test("the seat collapses to the rail when the sidebar does", async () => {
	const { exports, render } = await loadBundle();
	assert.equal(render(exports.TokenLedgerPanel, { wide: true }).props.className, "tkl_layer");
	assert.ok(render(exports.TokenLedgerPanel, { wide: false }).props.className.includes("tkl_rail"));
});

test("closed renders the badge alone; open adds the panel", async () => {
	const { exports, render, renderWithState } = await loadBundle();
	const closed = render(exports.TokenLedgerPanel, { wide: true });
	assert.equal(closed.props.children.filter(Boolean).length, 1, "a closed seat must not mount the panel");

	// [open, range]
	const open = renderWithState(exports.TokenLedgerPanel, { wide: true }, [true, "30"]);
	const panel = open.props.children.filter(Boolean)[1];
	assert.equal(panel.props.role, "dialog");
});

test("translation falls back to words, never to raw keys", async () => {
	const { exports } = await loadBundle();
	// No locale service at all.
	assert.equal(exports.translateWith(undefined)("panel.title"), "用量账本");
	// A service that does not know the key echoes it back; that is not an answer.
	assert.equal(exports.translateWith((k) => k)("action.close"), "关闭");
	// A service that does know it wins.
	assert.equal(exports.translateWith(() => "Ledger")("panel.title"), "Ledger");
	// Interpolation applies either way.
	assert.equal(exports.translateWith(undefined)("filter.clear", { site: "a.example" }), "只看 a.example ×");
	// A placeholder with no matching parameter is left alone rather than blanked:
	// showing the brace is a visible bug, showing nothing hides one.
	assert.equal(exports.translateWith(undefined)("filter.clear", {}), "只看 {site} ×");
});

test("both dictionaries carry the same keys, so one locale is never half-translated", async () => {
	const { exports } = await loadBundle();
	assert.deepEqual(Object.keys(exports.zh).sort(), Object.keys(exports.en).sort());
});

test("an absent figure is an em dash, never a zero", async () => {
	const { exports } = await loadBundle();
	assert.equal(exports.fmt(undefined), "—");
	assert.equal(exports.fmt(null), "—");
	assert.equal(exports.fmt(Number.NaN), "—");
	assert.equal(exports.fmt(0), "0");
});

test("the range tabs mirror the command's day argument", async () => {
	const { exports } = await loadBundle();
	assert.deepEqual(
		exports.RANGES.map((r) => r.days),
		[1, 7, 30, undefined],
		"`all` must send no days parameter at all"
	);
});

// --- the panel body ----------------------------------------------------------

/** Walk a recorded element tree collecting every string leaf. */
function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	if (typeof node.type === "function") return textOf(node.type(node.props));
	return textOf(node.props?.children);
}

/** Collect every node whose className matches. */
function findAll(node, className, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, className, out);
		return out;
	}
	if (typeof node.props?.className === "string" && node.props.className.split(" ").includes(className)) {
		out.push(node);
	}
	if (typeof node.type === "function") return findAll(node.type(node.props), className, out);
	return findAll(node.props?.children, className, out);
}

const T = (key, params) => {
	if (params === undefined) return key;
	return `${key}:${Object.values(params).join(",")}`;
};

const payload = (over = {}) => ({
	ok: true,
	totals: { tokens: 77866, requests: 4 },
	days: [
		{ day: "2026-08-14", tokens: 47085, requests: 3 },
		{ day: "2026-08-15", tokens: 30781, requests: 1 }
	],
	models: [
		{ model: "deepseek-v4-pro", requests: 3, inputTokens: 27492, cacheReadTokens: 18560, outputTokens: 1033, cacheHitRate: 40.3 },
		{ model: "gpt-5.6-sol", requests: 1, inputTokens: 27162, cacheReadTokens: 3584, outputTokens: 35, cacheHitRate: 11.7 }
	],
	sites: [
		{ site: "direct", tokens: 47085 },
		{ site: "api.9zyx.xyz", tokens: 30781 }
	],
	directory: [{ id: "api.9zyx.xyz", routes: ["api99"], discovered: true }],
	diagnostics: { lastUpdatedAt: Date.parse("2026-08-15T13:32:00"), unattributedRows: 0 },
	...over
});

test("the stat row shows an em dash for cost, never a zero, when nothing is priced", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(render(exports.StatRow, { data: payload(), translate: T }));
	assert.ok(text.includes("77,866"));
	assert.ok(text.includes("—"), "an unpriced range must not read as free");
	assert.equal(text.includes("0.00"), false);
});

test("a priced range shows its currency, and two currencies are never added", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.StatRow, { data: payload({ priced: { totals: { CNY: 0.4381, USD: 1.5 } } }), translate: T })
	);
	assert.ok(text.includes("¥0.4381"));
	assert.ok(text.includes("$1.50"));
	assert.ok(text.includes("+"), "separate currencies stay separate");
});

test("the site breakdown lists every site even while one is selected", async () => {
	// It is how you CHANGE the selection; hiding the others strands you on
	// whatever you last clicked.
	const { exports, render } = await loadBundle();
	const tree = render(exports.SiteRows, { data: payload(), site: "api.9zyx.xyz", onSelect() {}, translate: T });
	const rows = findAll(tree, "tkl_row");
	assert.equal(rows.length, 2);
	assert.equal(rows.filter((r) => "data-on" in r.props).length, 1, "exactly one row reads as selected");
});

test("clicking the selected site clears the filter rather than reselecting it", async () => {
	const { exports, render } = await loadBundle();
	const picked = [];
	const tree = render(exports.SiteRows, {
		data: payload(),
		site: "api.9zyx.xyz",
		onSelect: (id) => picked.push(id),
		translate: T
	});
	const rows = findAll(tree, "tkl_row");
	rows.find((r) => "data-on" in r.props).props.onClick();
	rows.find((r) => !("data-on" in r.props)).props.onClick();
	assert.deepEqual(picked, [undefined, "direct"]);
});

test("direct is labelled, not shown as the raw key", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(render(exports.SiteRows, { data: payload(), onSelect() {}, translate: T }));
	assert.ok(text.includes("sites.direct"));
	assert.ok(text.includes("api.9zyx.xyz"));
});

test("the activity strip pads to whole weeks and scales to the busiest day in view", async () => {
	const { exports, render } = await loadBundle();
	const tree = render(exports.ActivityStrip, { data: payload(), translate: T });
	const cells = findAll(tree, "tkl_cell");
	assert.equal(cells.length, 2, "one cell per day in range");
	// 47,085 is the max, so it is level 4; 30,781 is 65% of it, so level 3.
	assert.deepEqual(cells.map((c) => c.props["data-l"]), ["4", "3"]);
	assert.ok(findAll(tree, "tkl_cellPad").length > 0, "the first week must start on its weekday");
});

test("an idle day is level zero and a barely-used one is not", async () => {
	const { exports } = await loadBundle();
	assert.equal(exports.levelOf(0, 100), 0);
	assert.equal(exports.levelOf(1, 100), 1, "any usage at all must be visible");
	assert.equal(exports.levelOf(100, 100), 4);
});

test("the model table sorts, and reverses on a second click of the same column", async () => {
	const { exports, render, renderWithState } = await loadBundle();
	const first = render(exports.ModelTable, { data: payload(), translate: T });
	// Default: descending input tokens.
	assert.match(textOf(first), /deepseek-v4-pro[\s\S]*gpt-5\.6-sol/);

	const ascending = renderWithState(exports.ModelTable, { data: payload(), translate: T }, [
		{ by: "inputTokens", desc: false }
	]);
	assert.match(textOf(ascending), /gpt-5\.6-sol[\s\S]*deepseek-v4-pro/);
});

test("the model table carries request counts, so a hit rate can be read", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(render(exports.ModelTable, { data: payload(), translate: T }));
	assert.ok(text.includes("40.3%"));
	assert.ok(text.includes("11.7%"));
	assert.ok(text.includes("27,492"));
});

test("a relay-only deployment gets one honest line, not an empty balance card", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.BalanceCard, {
			state: { status: "ready", data: { ok: true, supported: false, reason: "no-official-route" } },
			translate: T
		})
	);
	assert.equal(text.trim(), "balance.noRoute");
});

test("a balance that could not be read never becomes an error banner", async () => {
	const { exports, render } = await loadBundle();
	assert.equal(render(exports.BalanceCard, { state: { status: "off" }, translate: T }), null);
});

test("a real balance renders its amount and currency", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.BalanceCard, {
			state: { status: "ready", data: { ok: true, supported: true, fetched: true, isAvailable: true, currency: "CNY", total: "36.44" } },
			translate: T
		})
	);
	assert.ok(text.includes("¥36.44"));
	assert.ok(text.includes("balance.active"));
});

test("unattributed rows are surfaced on the page, not only in a command", async () => {
	const { exports, render } = await loadBundle();
	const clean = textOf(render(exports.Footer, { data: payload(), translate: T }));
	assert.equal(clean.includes("footer.unattributed"), false);

	const lossy = textOf(
		render(exports.Footer, { data: payload({ diagnostics: { lastUpdatedAt: 1, unattributedRows: 7 } }), translate: T })
	);
	assert.ok(lossy.includes("footer.unattributed:7"));
});

test("an empty range shows the sites list but not an empty chart and table", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.Body, {
			state: { status: "ready", data: payload({ totals: { tokens: 0, requests: 0 }, days: [], models: [] }) },
			balance: { status: "off" },
			onSelect() {},
			translate: T
		})
	);
	assert.ok(text.includes("state.empty"));
	assert.ok(text.includes("section.sites"), "the site list is how you clear a filter, so it stays");
	assert.equal(text.includes("section.models"), false);
});

test("an error offers a retry and shows what went wrong", async () => {
	const { exports, render } = await loadBundle();
	let retried = 0;
	const tree = render(exports.Body, {
		state: { status: "error", message: "HTTP 500" },
		balance: { status: "off" },
		translate: T,
		onRetry: () => retried++
	});
	const text = textOf(tree);
	assert.ok(text.includes("error.load"));
	assert.ok(text.includes("HTTP 500"), "the cause belongs on screen, not only in a console");
	findAll(tree, "tkl_retry")[0].props.onClick();
	assert.equal(retried, 1);
});

test("the first load shows a skeleton rather than an empty panel", async () => {
	const { exports, render } = await loadBundle();
	const tree = render(exports.Body, { state: { status: "loading" }, balance: { status: "loading" }, translate: T });
	assert.ok(findAll(tree, "tkl_skel").length > 0);
});

test("the query mirrors the command's two arguments", async () => {
	const { exports } = await loadBundle();
	assert.equal(exports.buildQuery(undefined, undefined), "");
	assert.equal(exports.buildQuery(7, undefined), "?days=7");
	assert.equal(exports.buildQuery(undefined, "a.example"), "?site=a.example");
	assert.equal(exports.buildQuery(30, "a b"), "?days=30&site=a%20b", "a site name must survive the URL");
});

test("day keys come from local components, never from toISOString", async () => {
	// toISOString formats in UTC while the store keys days in local time. Mixing
	// them shifts every cell by a day for anyone east or west of UTC — the strip
	// grows a leading blank and credits each day's usage to the one before. Only
	// caught because this machine sits at UTC+9.
	const { exports } = await loadBundle();
	const midnight = new Date(2026, 7, 15, 0, 0, 0);
	assert.equal(exports.localDayKey(midnight), "2026-08-15");
	const lateEvening = new Date(2026, 7, 15, 23, 30, 0);
	assert.equal(exports.localDayKey(lateEvening), "2026-08-15");
	assert.notEqual(
		exports.localDayKey(midnight),
		midnight.toISOString().slice(0, 10) === "2026-08-15" ? "" : midnight.toISOString().slice(0, 10)
	);
});

test("a served balance request with no key names the missing key, rather than rendering nothing", async () => {
	// The envelope's `ok` means the route answered; the balance's own `fetched`
	// means a figure came back. Conflating them made this case invisible.
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.BalanceCard, {
			state: { status: "ready", data: { ok: true, supported: true, fetched: false, reason: "no-credential" } },
			translate: T
		})
	);
	assert.equal(text.trim(), "balance.noKey");
});
