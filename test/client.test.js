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
	assert.equal(exports.translateWith(undefined)("state.placeholder", { tokens: "1,100" }), "共 1,100 tokens。");
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
