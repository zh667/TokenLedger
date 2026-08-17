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

/** The real console, captured once. Tests below swap the global. */
const REAL_CONSOLE = globalThis.console;

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

	// The bundle logs its lifecycle deliberately (a silent browser half cost
	// several rounds of guessing). Silence it here so 200 tests stay readable,
	// while still asserting below that the calls happen.
	const logged = [];
	globalThis.console = {
		info: (...a) => logged.push(["info", a.join(" ")]),
		warn: (...a) => logged.push(["warn", a.join(" ")]),
		error: (...a) => logged.push(["error", a.join(" ")]),
		log: REAL_CONSOLE.log.bind(REAL_CONSOLE)
	};

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
		useMemo: (fn) => fn(),
		useRef: (initial) => ({ current: initial })
	};

	try {
		await import(`../src/client.js?t=${Date.now()}`);
	} finally {
		globalThis.console = REAL_CONSOLE;
	}

	return {
		exports: materialized,
		logged,
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
		readState: (index) => stateCells[index],
		/** Run every effect the last render registered, returning them. */
		runEffects: () => {
			const pending = effects.splice(0);
			for (const fn of pending) fn();
			return pending;
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
	assert.ok(tag.textContent.includes("var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base))"));
	assert.ok(tag.textContent.includes("var(--dsw-alias-border-l1)"));
});

test("everything that floats asks for the overlay ground, with the page ground as fallback", async () => {
	// `--dsw-alias-bg-base` is the PAGE's ground. A skin that wants a frosted
	// look sets it to `transparent`, which is right for the page and fatal for
	// anything floating above it: the panel then shows the wallpaper through its
	// own text. The failure is invisible to us because the default theme leaves
	// both tokens opaque, so only a test keeps this from being reverted by the
	// next person who reaches for the token they see everywhere else.
	const { dom } = await loadBundle();
	const css = dom.head.children[0].textContent;

	for (const selector of ["tkl_panel", "tkl_header", "tkl_tip"]) {
		const rule = css.match(new RegExp(`\\.${selector}\\{[^}]*\\}`))[0];
		assert.match(
			rule,
			/background:var\(--dsw-alias-bg-overlay,var\(--dsw-alias-bg-base\)\)/,
			`.${selector} floats, so it must not paint itself with the page's ground`
		);
	}

	// The fallback is the whole point: a theme defining no overlay token has to
	// render exactly as it did before.
	assert.equal(
		/background:var\(--dsw-alias-bg-base\)/.test(css),
		false,
		"a bare page-ground background is the bug; every one of them must carry the overlay fallback"
	);

	// Elements that sit INSIDE the panel are a different case — they inherit its
	// ground and must stay transparent, or they paint an opaque rectangle over
	// a skin's own texture.
	assert.match(css.match(/\.tkl_badge\{[^}]*\}/)[0], /background:0 0/, "the sidebar badge belongs to the sidebar");
	assert.match(css.match(/\.tkl_select\{[^}]*\}/)[0], /background:0 0/, "the picker sits on the panel's ground");
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
	const open = renderWithState(exports.TokenLedgerPanel, { wide: true }, [true, "all"]);
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

test("the three windows are today, the calendar month, and all time", async () => {
	// A header selector meant changing it three times to read the three numbers
	// everyone wants at once. The cards answer all three and double as the
	// switch, so these are windows first and a control second.
	const { exports } = await loadBundle();
	assert.deepEqual(exports.RANGES.map((r) => r.id), ["today", "month", "all"]);
	assert.equal(exports.RANGES[0].days(), 1);
	// The calendar month, not a rolling thirty days.
	assert.equal(exports.RANGES[1].days(), new Date().getDate());
	assert.equal(exports.RANGES[2].days(), undefined, "`all` must send no days parameter at all");
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

/** `YYYY-MM-DD` for N days back in LOCAL time, matching how the store keys days. */
const dayBack = (n) => {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - n);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const todayKey = () => dayBack(0);

const payload = (over = {}) => ({
	ok: true,
	totals: { tokens: 77866, requests: 4, cacheHitRate: 28.8 },
	windows: {
		today: { tokens: 30781, requests: 1 },
		month: { tokens: 47085, requests: 3 },
		all: { tokens: 77866, requests: 4 }
	},
	activity: [
		{ day: dayBack(1), tokens: 47085, requests: 3 },
		{ day: dayBack(0), tokens: 30781, requests: 1 }
	],
	days: [
		{ day: dayBack(1), tokens: 47085, requests: 3 },
		{ day: dayBack(0), tokens: 30781, requests: 1 }
	],
	models: [
		{ model: "deepseek-v4-pro", requests: 3, inputTokens: 27492, cacheReadTokens: 18560, outputTokens: 1033, cacheHitRate: 40.3 },
		{ model: "gpt-5.6-sol", requests: 1, inputTokens: 27162, cacheReadTokens: 3584, outputTokens: 35, cacheHitRate: 11.7 }
	],
	sites: [
		{ site: "direct", tokens: 47085 },
		{ site: "api.relay-one.example", tokens: 30781 }
	],
	directory: [{ id: "api.relay-one.example", routes: ["api99"], discovered: true }],
	diagnostics: { lastUpdatedAt: Date.parse("2026-08-15T13:32:00"), unattributedRows: 0 },
	...over
});

test("each card shows its own window, whichever one is selected", async () => {
	// The whole reason for three cards: they are three answers, not three views
	// of the selected one.
	const { exports, render } = await loadBundle();
	const tree = render(exports.StatRow, { data: payload(), range: "today", onRange() {}, translate: T });
	const text = textOf(tree);
	assert.ok(text.includes("30,781"), "today");
	assert.ok(text.includes("47,085"), "this month");
	assert.ok(text.includes("77,866"), "all time");
	const on = findAll(tree, "tkl_stat").filter((c) => "data-on" in c.props);
	assert.equal(on.length, 1, "exactly one card reads as selected");
});

test("clicking a card switches the range for everything below", async () => {
	const { exports, render } = await loadBundle();
	const picked = [];
	const tree = render(exports.StatRow, {
		data: payload(),
		range: "all",
		onRange: (id) => picked.push(id),
		translate: T
	});
	const cards = findAll(tree, "tkl_stat");
	cards[0].props.onClick();
	cards[1].props.onClick();
	assert.deepEqual(picked, ["today", "month"]);
});

test("an unpriced range says so with an em dash, never a zero", async () => {
	const { exports, render } = await loadBundle();
	const bare = textOf(render(exports.StatCaption, { data: payload(), translate: T }));
	assert.equal(bare.includes("caption.cost"), false, "no cost line at all when nothing is priced");
	assert.equal(bare.includes("0.00"), false);

	const priced = textOf(
		render(exports.StatCaption, { data: payload({ priced: { totals: { CNY: 0.4381, USD: 1.5 } } }), translate: T })
	);
	assert.ok(priced.includes("¥0.4381"));
	assert.ok(priced.includes("$1.50"));
	assert.ok(priced.includes("+"), "separate currencies stay separate");
});

test("the site breakdown lists every site even while one is selected", async () => {
	// It is how you CHANGE the selection; hiding the others strands you on
	// whatever you last clicked.
	const { exports, render } = await loadBundle();
	const tree = render(exports.SiteRows, { data: payload(), site: "api.relay-one.example", onSelect() {}, translate: T });
	const rows = findAll(tree, "tkl_row");
	assert.equal(rows.length, 2);
	assert.equal(rows.filter((r) => "data-on" in r.props).length, 1, "exactly one row reads as selected");
});

test("clicking the selected site clears the filter rather than reselecting it", async () => {
	const { exports, render } = await loadBundle();
	const picked = [];
	const tree = render(exports.SiteRows, {
		data: payload(),
		site: "api.relay-one.example",
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
	assert.ok(text.includes("api.relay-one.example"));
});

test("the activity strip keeps its shape whatever range is selected", async () => {
	// Tied to the selected range it collapsed to a single cell on "today",
	// leaving a mostly empty seven-row grid that read as a broken chart rather
	// than as a quiet day. It has its own fixed window now.
	const { exports, render } = await loadBundle();
	const tree = render(exports.ActivityStrip, { data: payload(), translate: T });
	const cells = findAll(tree, "tkl_cell");
	assert.equal(cells.length, exports.ACTIVITY_DAYS, "one cell per day of the fixed window");
	// Idle days are present as level zero rather than absent.
	assert.ok(cells.some((c) => c.props["data-l"] === "0"));
	assert.ok(cells.some((c) => c.props["data-l"] === "4"), "the busiest day in the window anchors the ramp");
	// Whole weeks: padding either side so columns line up on a weekday.
	const total = cells.length + findAll(tree, "tkl_cellPad").length;
	assert.equal(total % 7, 0, `grid is not whole weeks: ${total}`);

	// Month labels over the column each month begins in, and only there.
	const months = findAll(tree, "tkl_month").map((m) => m.props.children).filter(Boolean);
	assert.ok(months.length >= 11, `a year should label about twelve months, got ${months.length}`);
});

test("the strip reads its own window, not the selected range's days", async () => {
	const { exports, render } = await loadBundle();
	// `days` here is a single day, as "today" would give; `activity` is the real
	// window. Reading the wrong one is what produced the one-cell chart.
	const tree = render(exports.ActivityStrip, {
		data: payload({ days: [{ day: todayKey(), tokens: 5, requests: 1 }] }),
		translate: T
	});
	assert.equal(findAll(tree, "tkl_cell").length, exports.ACTIVITY_DAYS);
});

test("hovering a day shows what ran, not just how much", async () => {
	// A `title` attribute answers "how much" after a second of waiting and
	// nothing else, which is what the strip used to do.
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.DayTip, {
			cell: { day: "2026-08-14", tokens: 47085 },
			x: 200,
			y: 300,
			level: 4,
			models: [
				{ model: "deepseek-v4-pro", tokens: 40000 },
				{ model: "gpt-5.6-sol", tokens: 7085 }
			],
			translate: T
		})
	);
	assert.ok(text.includes("2026-08-14"));
	assert.ok(text.includes("47,085"));
	assert.ok(text.includes("deepseek-v4-pro"));
	assert.ok(text.includes("85%"), "each model's share of that day");
	assert.ok(text.includes("activity.level:4"));
});

test("an idle day says so rather than showing an empty breakdown", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.DayTip, { cell: { day: "2026-05-12", tokens: 0 }, x: 10, y: 10, level: 0, models: [], translate: T })
	);
	assert.ok(text.includes("activity.quiet"));
	assert.ok(text.includes("0"));
});

test("the tooltip stays on screen at either edge", async () => {
	const { exports, render } = await loadBundle();
	globalThis.window.innerWidth = 500;
	const leftEdge = render(exports.DayTip, { cell: { day: "d", tokens: 1 }, x: 4, y: 100, level: 1, models: [], translate: T });
	const rightEdge = render(exports.DayTip, { cell: { day: "d", tokens: 1 }, x: 496, y: 100, level: 1, models: [], translate: T });
	assert.equal(leftEdge.props.style.left, "8px", "clamped away from the left edge");
	assert.equal(rightEdge.props.style.left, "242px", "clamped away from the right edge");
});

test("levels come from quantiles, so one spike does not flatten the rest", async () => {
	// Scaling to the maximum was the obvious choice and the wrong one: a single
	// outlier drives every other day to level 1, and a year of steady work
	// renders as one bright square in a pale field.
	const { exports } = await loadBundle();
	const steady = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
	const withSpike = exports.makeLevelScale([...steady, 1_000_000]);
	// Median 60, 75th 85, 90th 100 — so the ordinary days still spread across
	// the ramp even with a spike ten thousand times larger in the same window.
	assert.equal(withSpike(10), 1, "the quiet end stays at the bottom");
	assert.equal(withSpike(60), 1, "the median is the top of level 1");
	assert.equal(withSpike(70), 2);
	assert.equal(withSpike(90), 3);
	assert.equal(withSpike(1_000_000), 4);
	assert.equal(new Set(steady.map(withSpike)).size, 3, "three distinct levels among the ordinary days");

	// Guards the guard: scaling to the maximum really would collapse all of them.
	const byRatio = (v) => (v / 1_000_000 > 0.25 ? 2 : 1);
	assert.equal(new Set(steady.map(byRatio)).size, 1, "ratio-to-max gives every ordinary day the same level");
});

test("an idle day is level zero, and any usage at all is visible", async () => {
	const { exports } = await loadBundle();
	const scale = exports.makeLevelScale([5, 50, 500]);
	assert.equal(scale(0), 0);
	assert.equal(scale(5), 1, "the smallest active day must not read as idle");
	assert.equal(scale(500), 4);
	// A window with no activity at all must not divide by anything.
	assert.equal(exports.makeLevelScale([])(0), 0);
	assert.equal(exports.makeLevelScale([0, 0])(0), 0);
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

test("a relay whose software is unrecognised gets one honest line, not an empty card", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.BalanceCard, {
			state: { status: "ready", data: { ok: true, supported: false, reason: "unknown-software" } },
			translate: T
		})
	);
	assert.equal(text.trim(), "balance.unknownSoftware");
});

test("a relay balance renders through the same card as the vendor's", async () => {
	// Every scheme returns one shape, so New API and Sub2API need no branch of
	// their own — the point of doing the normalising on the host.
	const { exports, render } = await loadBundle();
	const newapi = textOf(
		render(exports.BalanceCard, {
			state: {
				status: "ready",
				data: {
					ok: true,
					displayName: "api.relay-one.example",
					scheme: "newapi",
					supported: true,
					fetched: true,
					isAvailable: true,
					currency: "CNY",
					total: 16
				}
			},
			translate: T
		})
	);
	assert.ok(newapi.includes("api.relay-one.example"));
	assert.ok(newapi.includes("New API"), "the software is named, not just the host");
	assert.ok(newapi.includes("¥16.00"));

	// A site that publishes no unit price still has a true answer to give.
	const quotaOnly = textOf(
		render(exports.BalanceCard, {
			state: {
				status: "ready",
				data: { ok: true, displayName: "r.example", scheme: "newapi", supported: true, fetched: true, quota: { available: 4000000 } }
			},
			translate: T
		})
	);
	assert.ok(quotaOnly.includes("balance.quota:4,000,000"));
	assert.equal(quotaOnly.includes("¥"), false, "money must not be invented from an unknown scale");
});

test("the picker only appears when there is a choice to make", async () => {
	const { exports, render } = await loadBundle();
	assert.equal(render(exports.AccountPicker, { accounts: [], value: undefined, onChange() {}, translate: T }), null);
	assert.equal(
		render(exports.AccountPicker, { accounts: [{ id: "a", displayName: "A" }], value: "a", onChange() {}, translate: T }),
		null,
		"one account is not a choice"
	);
	const two = render(exports.AccountPicker, {
		accounts: [{ id: "a", displayName: "DeepSeek" }, { id: "b", displayName: "api.relay-one.example" }],
		value: "b",
		onChange() {},
		translate: T
	});
	assert.ok(textOf(two).includes("api.relay-one.example"));
});

test("a balance that could not be read never becomes an error banner", async () => {
	const { exports, render } = await loadBundle();
	assert.equal(render(exports.BalanceCard, { state: { status: "off" }, translate: T }), null);
});

test("a real balance renders its amount and currency", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.BalanceCard, {
			state: {
				status: "ready",
				data: { ok: true, displayName: "DeepSeek", scheme: "deepseek", supported: true, fetched: true, isAvailable: true, currency: "CNY", total: 36.44, granted: 5 }
			},
			translate: T
		})
	);
	assert.ok(text.includes("¥36.44"));
	assert.ok(text.includes("balance.active"));
	assert.ok(text.includes("balance.granted:¥5.00"), "granted credit expires and top-ups do not");
});

// --- quota windows -------------------------------------------------------------

/** Three windows in the shape `readBalance` normalizes them into. */
const WINDOWS = [
	{ kind: "session", minutes: 300, usedPercent: 4, resetsAt: "2026-08-16T04:17:00.000Z" },
	{ kind: "weekly", usedPercent: 82, resetsAt: "2026-08-17T08:00:00.000Z" },
	{ kind: "monthly", usedPercent: 100 }
];

const subscription = (windows) => ({
	status: "ready",
	data: {
		ok: true,
		displayName: "opencode.ai",
		scheme: "deepseek",
		supported: true,
		fetched: true,
		isAvailable: true,
		plan: "Go",
		windows
	}
});

test("a card with no windows renders exactly what it did before they existed", async () => {
	// The card became a column to make room for them. With none, it holds a
	// single child, the gap never applies, and nothing moves.
	const { exports, render } = await loadBundle();
	const tree = render(exports.BalanceCard, {
		state: { status: "ready", data: { ok: true, displayName: "DeepSeek", scheme: "deepseek", supported: true, fetched: true, isAvailable: true, currency: "CNY", total: 36.44 } },
		translate: T
	});
	assert.equal(findAll(tree, "tkl_wins").length, 0);
	assert.equal(findAll(tree, "tkl_balanceTop").length, 1);
	assert.ok(textOf(tree).includes("¥36.44"));
});

test("each window is one row naming itself, its reset and how full it is", async () => {
	const { exports, render } = await loadBundle();
	const tree = render(exports.BalanceCard, { state: subscription(WINDOWS), translate: T });
	assert.equal(findAll(tree, "tkl_win").length, 3);

	const text = textOf(tree);
	assert.ok(text.includes("balance.window.hours:5"), "a five-hour window says five hours");
	assert.ok(text.includes("balance.window.weekly"));
	assert.ok(text.includes("balance.window.monthly"));
	assert.ok(text.includes("balance.window.used:4"));
	assert.ok(text.includes("balance.window.used:82"));
	assert.ok(text.includes("balance.window.reset:"), "a reset instant is shown when there is one");
});

test("money and windows both show, because an account can hold both", async () => {
	// A plan with a top-up wallet behind it is ordinary. A `mode` flag would
	// force a choice reality does not make.
	const { exports, render } = await loadBundle();
	const state = subscription(WINDOWS);
	state.data.currency = "USD";
	state.data.total = 12.5;
	const text = textOf(render(exports.BalanceCard, { state, translate: T }));
	assert.ok(text.includes("$12.50"));
	assert.ok(text.includes("balance.window.used:4"));
});

test("the bar's width is the percentage, and its colour only repeats it", async () => {
	// Colour is a second channel. The number sits beside every bar, so the
	// three bands are readable without distinguishing green from amber.
	const { exports, render } = await loadBundle();
	const fills = findAll(render(exports.BalanceCard, { state: subscription(WINDOWS), translate: T }), "tkl_winFill");
	assert.deepEqual(fills.map((f) => f.props.style.width), ["4%", "82%", "100%"]);
	assert.equal(fills[0].props.className.includes("tkl_winWarn"), false, "4% is not a warning");
	assert.ok(fills[1].props.className.includes("tkl_winWarn"), "82% is close enough to matter");
	assert.ok(fills[2].props.className.includes("tkl_winFull"), "100% is spent, not merely close");
});

test("every bar is a labelled progressbar", async () => {
	const { exports, render } = await loadBundle();
	for (const bar of findAll(render(exports.BalanceCard, { state: subscription(WINDOWS), translate: T }), "tkl_winBar")) {
		assert.equal(bar.props.role, "progressbar");
		assert.equal(bar.props["aria-valuemin"], 0);
		assert.equal(bar.props["aria-valuemax"], 100);
		assert.equal(typeof bar.props["aria-valuenow"], "number");
		assert.ok(String(bar.props["aria-label"]).startsWith("balance.window."), "a bar with no name is a bar nobody can read");
	}
});

test("an unlimited window says so and draws no bar", async () => {
	// A bar at 0% would read as "none used of a finite allowance", which is the
	// opposite of what unlimited means.
	const { exports, render } = await loadBundle();
	const tree = render(exports.BalanceCard, { state: subscription([{ kind: "weekly", unlimited: true }]), translate: T });
	assert.ok(textOf(tree).includes("balance.window.unlimited"));
	assert.equal(findAll(tree, "tkl_winBar").length, 0);
	assert.equal(findAll(tree, "tkl_win").length, 1, "it still gets a row — unlimited is worth saying");
});

test("a window with no reset shows its bar and stays quiet about the clock", async () => {
	const { exports, render } = await loadBundle();
	const tree = render(exports.BalanceCard, { state: subscription([{ kind: "monthly", usedPercent: 30 }]), translate: T });
	assert.equal(findAll(tree, "tkl_winReset").length, 0);
	assert.equal(findAll(tree, "tkl_winBar").length, 1);
});

test("a session window with no reported length falls back to naming the kind", async () => {
	// The length is only shown when the upstream sent one. Hard-coding five
	// hours would be a number the panel made up, and plans differ.
	const { exports, render } = await loadBundle();
	const text = textOf(render(exports.QuotaWindows, { windows: [{ kind: "session", usedPercent: 9 }], translate: T }));
	assert.ok(text.includes("balance.window.session"));
	assert.equal(text.includes("balance.window.hours"), false);
});

test("a window length is spoken in whichever unit divides it evenly", async () => {
	const { exports, render } = await loadBundle();
	const label = (minutes) =>
		textOf(render(exports.QuotaWindows, { windows: [{ kind: "session", usedPercent: 1, minutes }], translate: T }));
	assert.ok(label(300).includes("balance.window.hours:5"));
	assert.ok(label(1440).includes("balance.window.days:1"));
	assert.ok(label(90).includes("balance.window.minutes:90"));
});

test("nothing renders for an absent or empty window list", async () => {
	const { exports, render } = await loadBundle();
	for (const windows of [undefined, [], null, "weekly"]) {
		assert.equal(render(exports.QuotaWindows, { windows, translate: T }), null, JSON.stringify(windows));
	}
});

test("both dictionaries carry every window key", async () => {
	// A missing key renders the key itself, which on a card of numbers looks
	// like a bug in the data rather than a gap in the translations.
	const { exports } = await loadBundle();
	const keys = Object.keys(exports.zh).filter((key) => key.startsWith("balance.window."));
	assert.ok(keys.length >= 10, `expected every kind, unit and label: ${keys.length}`);
	for (const key of keys) {
		assert.equal(typeof exports.en[key], "string", `${key} is missing from en`);
		assert.notEqual(exports.en[key], "", key);
	}
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
	assert.ok(text.trim().startsWith("balance.noKey"), text);
});

test("the bundle announces each lifecycle step it reaches", async () => {
	// A browser half that fails silently is indistinguishable from one that was
	// never delivered, and telling those apart by reasoning cost several rounds.
	// These lines are the difference between "the panel is missing" and "the
	// bundle never executed" / "a require is absent" / "the seat was refused".
	const { logged, exports } = await loadBundle();
	const text = logged.map(([, m]) => m).join("\n");
	assert.ok(text.includes("bundle script executing"), "stage zero: was the script even fetched");
	assert.ok(text.includes("factory materializing"));
	assert.ok(text.includes("factory ready"));

	const seatLogs = [];
	globalThis.console = { info: (...a) => seatLogs.push(a.join(" ")), warn() {}, error() {} };
	try {
		exports.apply({
			effect: (fn) => fn(),
			locale: { register() {} },
			slots: { inject: (_n, run) => run(), register() {} }
		});
	} finally {
		globalThis.console = REAL_CONSOLE;
	}
	assert.ok(seatLogs.join("\n").includes("registering the footer seat"));
	assert.ok(seatLogs.join("\n").includes("sidebar.footer.action is available"));
});

test("a locale service that throws costs the dictionaries, not the seat", async () => {
	// The seat is the point; translations are a nicety. Before this, one throw
	// took both.
	const { exports } = await loadBundle();
	const registered = [];
	globalThis.console = { info() {}, warn() {}, error() {} };
	try {
		exports.apply({
			effect: (fn) => fn(),
			locale: {
				register() {
					throw new Error("no locale service");
				}
			},
			slots: { inject: (_n, run) => run(), register: (spec) => registered.push(spec) }
		});
	} finally {
		globalThis.console = REAL_CONSOLE;
	}
	assert.equal(registered.length, 1, "the seat must still be taken");
});

test("the footer-action container is made to wrap, or a second plugin lands off-screen", async () => {
	// `sidebar.footer.action` is a list slot whose container is a NOWRAP row.
	// Every occupant claims the full column width, so the first takes all of it
	// and the next is laid out past the sidebar's right edge — rendered,
	// visible, opacity 1, and completely outside the panel. On a real install
	// this badge measured x:268 in a column ending at 268, which is
	// indistinguishable from "the plugin never loaded" and was diagnosed only
	// by querying the DOM.
	//
	// Shrinking is not enough: the other occupant is flex:none and will not
	// yield. The container has to wrap.
	const { dom } = await loadBundle();
	const css = dom.head.children[0].textContent;
	assert.ok(
		css.includes("div:has(> [data-slot='sidebar.footer.action']){flex-wrap:wrap}"),
		"without this rule a second footer action is pushed outside the sidebar"
	);
	// Reached through the slot marker, never the container's hashed CSS-module
	// class, which is not ours to depend on.
	assert.equal(/hHd-|_footerActions_/.test(css), false, "must not target the host's hashed class");
	assert.match(css, /\.tkl_layer\{flex:0 0 100%/, "and the layer must claim a full row of its own");
});

test("a lone busy day is not rendered as the palest green", async () => {
	// Quantiles need a distribution. With one distinct total every threshold is
	// that same number, so the only active day in the window came out level 1 —
	// which reads as "nothing happened" on the one day something did.
	const { exports } = await loadBundle();
	assert.equal(exports.makeLevelScale([74722])(74722), 4);

	// Two and three distinct values rank rather than collapse.
	const two = exports.makeLevelScale([100, 900]);
	assert.equal(two(100), 1);
	assert.equal(two(900), 4);
	const three = exports.makeLevelScale([10, 100, 900]);
	assert.deepEqual([three(10), three(100), three(900)], [1, 3, 4]);

	// Four or more hands back to the quantile path.
	const many = exports.makeLevelScale([1, 2, 3, 4, 5, 6, 7, 8]);
	assert.equal(many(1), 1);
	assert.equal(many(8), 4);
});

test("the badge icon is not pushed in by a centring box", async () => {
	// A fixed-width wrapper centred a 16px icon inside 24px, landing it 4px
	// further in than the Settings row directly below — measured at x=22 against
	// x=18 for both neighbours, which reads as a misalignment rather than as
	// deliberate spacing. In the rail the badge itself does the centring.
	const { dom } = await loadBundle();
	const css = dom.head.children[0].textContent;
	const rule = css.match(/\.tkl_badgeIcon\{[^}]*\}/)[0];
	assert.equal(/width:\s*24px/.test(rule), false, rule);
	assert.equal(/justify-content/.test(rule), false, "centring belongs to the rail badge, not the icon");
	// The rail still centres, via the badge.
	assert.ok(css.includes(".tkl_layer.tkl_rail .tkl_badge{border-radius:50%;justify-content:center"));
});

test("sites get distinct colours, and direct is not one of the relays", async () => {
	// Two relays drawn in the same grey cannot be told apart, which is the one
	// thing this section exists to do. `direct` sits outside the ramp because
	// "the vendor" versus "someone reselling the vendor" is its whole subject.
	const { exports } = await loadBundle();
	assert.equal(exports.colorOf("direct", 0), "var(--tkl-direct)");
	assert.equal(exports.colorOf("a.example", 0), "var(--tkl-series-0)");
	assert.equal(exports.colorOf("b.example", 1), "var(--tkl-series-1)");
	// More relays than the palette holds wrap rather than fall off it.
	assert.equal(exports.colorOf("g.example", 6), "var(--tkl-series-0)");
});

test("direct does not consume a ramp slot and shift the relays along", async () => {
	const { exports, render } = await loadBundle();
	const tree = render(exports.SiteRows, {
		data: {
			sites: [
				{ site: "direct", tokens: 100 },
				{ site: "a.example", tokens: 200 },
				{ site: "b.example", tokens: 300 }
			]
		},
		onSelect() {},
		translate: T
	});
	const swatches = findAll(tree, "tkl_swatch").map((n) => n.props.style.background);
	assert.deepEqual(swatches, ["var(--tkl-direct)", "var(--tkl-series-0)", "var(--tkl-series-1)"]);
});

test("the distribution is one segmented bar, sized by share of the whole", async () => {
	// A row of separate bars each scaled to the largest made two sites look
	// comparable when one was triple the other.
	const { exports, render } = await loadBundle();
	const tree = render(exports.SiteRows, {
		data: { sites: [{ site: "a", tokens: 750 }, { site: "b", tokens: 250 }] },
		onSelect() {},
		translate: T
	});
	assert.equal(findAll(tree, "tkl_stack").length, 1, "one bar, not one per row");
	assert.deepEqual(
		findAll(tree, "tkl_stackSeg").map((n) => n.props.style.width),
		["75%", "25%"]
	);
	// And the rows state the same share in words.
	const text = textOf(tree);
	assert.ok(text.includes("75%"));
	assert.ok(text.includes("25%"));
});

test("selecting a site dims the rest of the bar rather than hiding them", async () => {
	const { exports, render } = await loadBundle();
	const tree = render(exports.SiteRows, {
		data: { sites: [{ site: "a", tokens: 1 }, { site: "b", tokens: 1 }] },
		site: "a",
		onSelect() {},
		translate: T
	});
	assert.ok("data-dim" in findAll(tree, "tkl_stack")[0].props);
	assert.equal(findAll(tree, "tkl_stackSeg").filter((n) => "data-on" in n.props).length, 1);
});

test("the activity header names the host's zone, not the browser's", async () => {
	// Days are grouped by the clock of the process that folded them. A harness on
	// a server in UTC read from a browser in UTC+8 cuts its days at a boundary
	// the reader does not share, and labelling the browser would be confidently
	// wrong.
	const { exports, render } = await loadBundle();
	const text = textOf(
		render(exports.Body, {
			state: { status: "ready", data: payload({ timeZone: { name: "Asia/Shanghai", offset: "UTC+08:00" } }) },
			balance: { status: "off" },
			onSelect() {},
			onRange() {},
			translate: T
		})
	);
	assert.ok(text.includes("UTC+08:00"));
});

test("freshness is stated as elapsed time, not as a clock reading", async () => {
	// The sweep runs every minute, so an absolute timestamp is always "about a
	// minute ago" written as a time the reader has to subtract from. The line
	// also said "index updated" — this package's internal word for its rollup
	// table — and a user reasonably asked what an index was.
	const { exports } = await loadBundle();
	const now = Date.UTC(2026, 7, 15, 12, 0, 0);
	assert.equal(exports.agoLabel(now - 5_000, T, now), "footer.justNow");
	assert.equal(exports.agoLabel(now - 89_000, T, now), "footer.justNow", "a sweep-interval gap is not staleness");
	assert.equal(exports.agoLabel(now - 5 * 60_000, T, now), "footer.minutes:5");
	assert.equal(exports.agoLabel(now - 3 * 3_600_000, T, now), "footer.hours:3");
	assert.equal(exports.agoLabel(now - 2 * 86_400_000, T, now), "footer.days:2");
	assert.equal(exports.agoLabel(undefined, T, now), "footer.never");
	// A clock skew that puts the last sweep in the future must not print a
	// negative age.
	assert.equal(exports.agoLabel(now + 60_000, T, now), "footer.justNow");
});

test("the footer says nothing about an index", async () => {
	const { exports } = await loadBundle();
	for (const dict of [exports.zh, exports.en]) {
		for (const [key, value] of Object.entries(dict)) {
			if (!key.startsWith("footer.")) continue;
			assert.equal(/索引|\bindex\b/i.test(value), false, `${key} leaks internal vocabulary: ${value}`);
		}
	}
});

test("freshness reports when the logs were READ, not when they last changed", async () => {
	// The checkpoint table only advances on a session that moved, so after a
	// quiet half hour it sat half an hour behind while the figures were exactly
	// right — reported as freshness, that reads as a stuck panel, and it was
	// reported as one.
	const { exports, render } = await loadBundle();
	const now = Date.now();
	const text = textOf(
		render(exports.Footer, {
			data: {
				lastSweepAt: now - 4_000,
				diagnostics: { lastUpdatedAt: now - 35 * 60_000, unattributedRows: 0 }
			},
			translate: T
		})
	);
	assert.ok(text.includes("footer.updated:footer.justNow"), `stale freshness: ${text}`);
	// The other fact is still worth stating, just not as freshness.
	assert.ok(text.includes("footer.lastActivity:footer.minutes:35"), text);
});

test("a panel that has never swept says so rather than claiming to be current", async () => {
	const { exports, render } = await loadBundle();
	const text = textOf(render(exports.Footer, { data: { diagnostics: {} }, translate: T }));
	assert.ok(text.includes("footer.never"));
});

test("a press outside closes the panel; one inside does not", async () => {
	const harness = await loadBundle();
	const listeners = [];
	globalThis.document.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
	globalThis.document.removeEventListener = () => {};
	try {
		// [open, range, site, account, nonce]
		harness.renderWithState(exports_of(harness).TokenLedgerPanel, { wide: true }, [true, "all", undefined, undefined, 0]);
		harness.runEffects();

		const onDown = listeners.find((l) => l.type === "pointerdown");
		assert.ok(onDown, "the panel listens for a press while it is open");
		assert.equal(onDown.capture, true, "capture, so a handler that stops propagation cannot trap it open");

		// The ref is never attached by this stub renderer, so `contains` is asked
		// of nothing — which must not close the panel either, or a render race
		// would dismiss it.
		onDown.fn({ target: {} });
		assert.equal(harness.readState(0), true, "an unattached root must not be read as 'outside'");
	} finally {
		delete globalThis.document.addEventListener;
		delete globalThis.document.removeEventListener;
	}
});

test("the outside-press listener is only registered while the panel is open", async () => {
	// A global handler that outlives the panel would swallow presses from
	// whatever owns the page next.
	const harness = await loadBundle();
	const listeners = [];
	globalThis.document.addEventListener = (type, fn) => listeners.push(type);
	globalThis.document.removeEventListener = () => {};
	try {
		harness.render(exports_of(harness).TokenLedgerPanel, { wide: true }); // closed
		harness.runEffects();
		assert.equal(listeners.includes("pointerdown"), false);
	} finally {
		delete globalThis.document.addEventListener;
		delete globalThis.document.removeEventListener;
	}
});

/** The bundle's exports, named for readability at the call sites above. */
function exports_of(harness) {
	return harness.exports;
}
