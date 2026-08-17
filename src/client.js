/**
 * TokenLedger — browser half.
 *
 * A hand-written `__ModuleLoader__` bundle. There is deliberately **no build
 * step**: the module system materializes a registered factory and hands it a
 * synchronous `require`, so React arrives from the host and a bundler would add
 * a toolchain without adding a capability. That also means no JSX syntax — the
 * runtime's `jsx`/`jsxs` are called directly.
 *
 * ## Why it looks the way it does
 *
 * The style follows DSH itself, read from its own token file rather than from a
 * screenshot: the harness is **achromatic** (`--dsw-alias-brand-primary`
 * resolves to a neutral, not a hue), depth comes from alpha borders rather than
 * from fills — in light mode `bg-layer-1` and `bg-layer-2` are the same white —
 * radii run 12 / 8 / 6, and the type scale is tight at 11–14px. A panel built
 * to some other product's look reads as foreign inside the harness, which is
 * the whole reason this is not styled after a relay dashboard.
 *
 * Colour is reserved for state and for data. The activity strip is green
 * because green-for-activity is read at a glance; nothing else is tinted.
 *
 * ## What this file is not
 *
 * It renders; it does not compute. Every figure comes from the host half's
 * `/api/tokenledger/usage`, which serves the same store queries `/tokenledger`
 * renders — so the panel and the command have no second aggregation to drift
 * apart, and "the numbers match the command" is a meaningful test.
 *

 * ## Why this is one file, and has to stay one
 *
 * It is long — CSS, both dictionaries, every component, the data hooks. That
 * looks like a file begging to be split, and it cannot be. Checked against
 * `dsh-client-modules` rather than assumed:
 *
 * - The host resolves `exports["./client"]` to **one** path, reads it with
 *   `readFileSync`, and serves it as-is (`lib/index.js`). There is no bundler
 *   in the path, so one graph row is one URL is one file.
 * - The synchronous `require` handed to a factory resolves seed words, shell
 *   modules, and **already-registered factories** — it has no load branch,
 *   because loading is async (`lib/client.js`, `makeRequire`). A sibling file
 *   nothing fetched can therefore never be required; the panel would die at
 *   materialization.
 *
 * Two `load()` calls inside *this* file would work — `factories` is keyed only
 * by what was registered, with no boot-graph check — but that splits nothing.
 *
 * One thing that would break even then: `claimStyles` tags untagged `<style>`
 * elements with whichever id is materializing, for HMR bookkeeping. Injecting
 * the stylesheet from a child module would file it under the child, and
 * invalidating the panel would leave the stylesheet behind. The injection
 * belongs to the factory whose id owns it.
 *
 * A build step would dissolve all of this, and cost the property this file is
 * shaped around: with no toolchain, the browser half can be materialized and
 * tested in Node, which is what `test/client.test.js` does.
 *
 * @module dsh-tokenledger/client
 */

// Stage zero. If this line never prints, the bundle was never fetched or never
// executed, and every later explanation is beside the point — the delivery is
// what to look at, not the code. Logged unconditionally because the only
// alternative when a panel does not appear is guessing, which has cost several
// rounds already.
console.info("[tokenledger] bundle script executing (client half present)");

window.__ModuleLoader__.load({
	id: "dsh-tokenledger",
	factory: (require) => {
		console.info("[tokenledger] factory materializing");
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react;
		let jsx;
		let jsxs;
		let primitives;
		try {
			react = require("react");
			({ jsx, jsxs } = require("react/jsx-runtime"));
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			// A require that throws inside a factory takes the whole bundle down
			// with no other trace. Naming the specifier turns "the panel is missing"
			// into "this dependency is not in the graph".
			console.error("[tokenledger] a require failed; the panel cannot mount:", error);
			throw error;
		}

		const NS = "tokenLedger";
		const USAGE_PATH = "/api/tokenledger/usage";
		const BALANCE_PATH = "/api/tokenledger/balance";
		/** A year of whole weeks; must match the host's window or the strip has holes. */
		const ACTIVITY_DAYS = 371;

		//#region style
		//
		// Injected once as a single tag. Every colour is a DSH token so the panel
		// follows whatever theme the user runs; the handful of `--tkl-*` values
		// are for what DSH has no token for, and are defined on the panel itself
		// so they cannot leak into the host.
		const css = [
			// -- the seat, beside the settings gear -------------------------------
			// `sidebar.footer.action` is a LIST slot, but its container is a
			// **nowrap row**, and every occupant so far claims `width:100%`. With
			// one action that is fine. With two, the first takes the whole column
			// and the second is laid out past the sidebar's right edge — rendered,
			// visible, `opacity: 1`, and completely off the panel. That is exactly
			// what happened here: the badge measured `x: 268` in a column ending
			// at 268, which looks identical to "the plugin never loaded".
			//
			// Shrinking alone does not fix it. The other occupant is `flex:none`
			// and will not yield, so a shrinkable item just gets squeezed to a
			// sliver still positioned after it. The container has to wrap, and
			// wrapping it is the only change that also holds when a third plugin
			// takes this seat.
			//
			// Reached through `:has()` on the slot marker rather than the
			// container's hashed CSS-module class, which is not ours to depend on.
			"div:has(> [data-slot='sidebar.footer.action']){flex-wrap:wrap}",
			".tkl_layer{flex:0 0 100%;min-width:0;align-items:center;height:49px;margin:8px 0 0;display:flex;position:relative}",
			".tkl_badge{width:100%;min-width:0;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}",
			".tkl_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".tkl_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}",
			// No fixed width: a 24px centring box pushed a 16px icon 4px further in
			// than the Settings row beside it, which reads as a misalignment rather
			// than as spacing. In the rail the badge itself does the centring.
			".tkl_badgeIcon{flex:none;display:inline-flex;align-items:center}",
			".tkl_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
			".tkl_badgeValue{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}",
			// Collapsed sidebar: the shell narrows to a 56px rail and every control
			// becomes a 36px circle. Without this the badge keeps its full width and
			// spills out of the rail.
			".tkl_layer.tkl_rail{flex:none;width:36px;height:36px;margin:0}",
			".tkl_layer.tkl_rail .tkl_badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}",
			".tkl_layer.tkl_rail .tkl_badgeLabel,.tkl_layer.tkl_rail .tkl_badgeValue{display:none}",

			// -- the panel ---------------------------------------------------------
			//
			// Everything that floats reaches for `--dsw-alias-bg-overlay` first.
			// `--dsw-alias-bg-base` is the PAGE's ground, and a skin that wants a
			// frosted look sets it to `transparent` — correct for the page, fatal
			// for a panel sitting on top of it, which then shows the wallpaper
			// through its own text. Themes that define no overlay token fall back
			// to the old value, so the default look is unchanged.
			".tkl_panel{z-index:30;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));width:460px;max-width:calc(100vw - 24px);max-height:76vh;box-shadow:var(--dsw-shadow-lv2);border-radius:12px;flex-direction:column;display:flex;position:fixed;bottom:128px;left:12px;overflow:hidden;" +
				// Scoped here rather than on :root so nothing escapes into the host.
				"--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);" +
				"--tkl-radius:12px;--tkl-radius-sm:8px;--tkl-radius-xs:6px;" +
				// The activity ramp: Tailwind's emerald over GitHub's neutral zero.
				// Level 0 is an alpha grey so it reads on both themes without a swap.
				"--tkl-level-0:rgba(128,128,128,0.16);--tkl-level-1:#a7f3d0;--tkl-level-2:#6ee7b7;--tkl-level-3:#34d399;--tkl-level-4:#10b981;" +
				// Categorical, mid-tone so each reads on either surface. `direct` is
				// the neutral one; the rest are the relay ramp.
				"--tkl-direct:#8b93a7;--tkl-series-0:#0ea5e9;--tkl-series-1:#f59e0b;--tkl-series-2:#8b5cf6;--tkl-series-3:#14b8a6;--tkl-series-4:#ec4899;--tkl-series-5:#84cc16}",
			"@media (prefers-color-scheme:dark){.tkl_panel{--tkl-level-1:#065f46;--tkl-level-2:#059669;--tkl-level-3:#10b981;--tkl-level-4:#34d399;--tkl-direct:#6b7280;--tkl-series-0:#38bdf8;--tkl-series-1:#fbbf24;--tkl-series-2:#a78bfa;--tkl-series-3:#2dd4bf;--tkl-series-4:#f472b6;--tkl-series-5:#a3e635}}",
			// An explicit theme choice must win over the media query in BOTH
			// directions, so each is stated rather than inherited.
			"[data-theme='dark'] .tkl_panel{--tkl-level-1:#065f46;--tkl-level-2:#059669;--tkl-level-3:#10b981;--tkl-level-4:#34d399;--tkl-direct:#6b7280;--tkl-series-0:#38bdf8;--tkl-series-1:#fbbf24;--tkl-series-2:#a78bfa;--tkl-series-3:#2dd4bf;--tkl-series-4:#f472b6;--tkl-series-5:#a3e635}",
			"[data-theme='light'] .tkl_panel{--tkl-level-1:#a7f3d0;--tkl-level-2:#6ee7b7;--tkl-level-3:#34d399;--tkl-level-4:#10b981;--tkl-direct:#8b93a7;--tkl-series-0:#0ea5e9;--tkl-series-1:#f59e0b;--tkl-series-2:#8b5cf6;--tkl-series-3:#14b8a6;--tkl-series-4:#ec4899;--tkl-series-5:#84cc16}",

			".tkl_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex;gap:8px}",
			".tkl_headerLeft{align-items:center;gap:8px;display:flex;min-width:0}",
			".tkl_title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;white-space:nowrap}",
			".tkl_headerActions{align-items:center;gap:2px;display:flex;flex:none}",
			".tkl_iconButton{cursor:pointer;width:26px;height:26px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:var(--tkl-radius-xs);justify-content:center;align-items:center;padding:0;display:inline-flex}",
			".tkl_iconButton:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_iconButton[data-busy]{opacity:.5;cursor:default}",
			".tkl_body{flex:1;min-height:0;padding:12px 14px 14px;overflow-y:auto}",
			".tkl_note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}",
			".tkl_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}",
			".tkl_retry{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-xs);margin-top:8px;padding:3px 10px;font:inherit;font-size:12px}",
			".tkl_retry:hover{background:var(--dsw-alias-interactive-bg-hover)}",

			// -- the range selector ------------------------------------------------
			// The stat cards ARE the range control, so they are buttons that read
			// as cards rather than a separate selector duplicating the same three
			// words in the header.
			".tkl_stat{cursor:pointer;font:inherit;text-align:left;transition:background .12s}",
			".tkl_stat:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_stat[data-on]{border-color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-active)}",
			".tkl_zone{color:var(--dsw-alias-label-caption);margin-left:auto;font-size:10px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tkl_caption{color:var(--dsw-alias-label-tertiary);margin:6px 0 0;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",

			// -- sections ----------------------------------------------------------
			".tkl_section{margin-top:14px}",
			".tkl_section:first-child{margin-top:0}",
			".tkl_sectionTitle{color:var(--dsw-alias-label-tertiary);margin:0 0 6px;font-size:11px;line-height:16px;font-weight:500;display:flex;align-items:center;gap:4px;min-height:18px}",
			".tkl_filter{color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-interactive-bg-active);border:none;border-radius:999px;margin-left:6px;padding:1px 8px;font:inherit;font-size:11px;line-height:16px}",
			".tkl_filter:hover{color:var(--dsw-alias-label-primary)}",
			".tkl_picker{display:inline-flex;align-items:center;gap:5px;margin-left:auto}",
			".tkl_pickerLabel{color:var(--dsw-alias-label-caption);font-size:10px}",
			".tkl_select{color:var(--dsw-alias-label-secondary);background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-xs);padding:1px 4px;font:inherit;font-size:11px;line-height:16px;max-width:150px}",
			".tkl_select:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",

			// -- stat row ----------------------------------------------------------
			".tkl_stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}",
			".tkl_stat{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);padding:8px 10px;min-width:0}",
			".tkl_statValue{color:var(--dsw-alias-label-primary);font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".tkl_statLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:2px}",

			// -- the site breakdown ------------------------------------------------
			//
			// Categorical colour, and ONLY here. DSH's chrome is achromatic and the
			// panel keeps it that way; a distribution is data, and two relays drawn
			// in the same grey cannot be told apart at a glance — which is the one
			// thing this section exists to do.
			//
			// `direct` gets its own slot rather than a place in the ramp: it is not
			// a relay, and the whole point of the section is that distinction.
			".tkl_stack{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-fill-l2);margin-bottom:8px}",
			".tkl_stackSeg{height:8px;min-width:2px;transition:opacity .12s}",
			".tkl_stack[data-dim] .tkl_stackSeg:not([data-on]){opacity:.32}",
			".tkl_swatch{width:8px;height:8px;border-radius:2px;flex:none}",

			// -- generic rows (sites) ----------------------------------------------
			".tkl_rows{flex-direction:column;display:flex}",
			".tkl_row{width:100%;align-items:center;gap:8px;border:0;background:0 0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 4px;font:inherit;text-align:left;cursor:pointer;display:flex;border-radius:var(--tkl-radius-xs)}",
			".tkl_row:last-child{border-bottom:0}",
			".tkl_row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_row[data-on]{background:var(--dsw-alias-interactive-bg-active)}",
			".tkl_rowName{color:var(--dsw-alias-label-primary);flex:none;width:150px;min-width:0;font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".tkl_rowValue{color:var(--dsw-alias-label-primary);flex:none;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right;min-width:64px}",
			".tkl_rowMeta{color:var(--dsw-alias-label-tertiary);flex:none;width:44px;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right}",

			// -- activity strip ----------------------------------------------------
			// A strip, not a month grid: one row of weeks reads at a glance and
			// costs 90px instead of a viewport.
			".tkl_strip{overflow-x:auto;padding-bottom:2px;display:flex;gap:4px}",
			".tkl_weekdays{display:grid;grid-template-rows:repeat(7,12px);gap:3px;flex:none;padding-top:15px}",
			".tkl_weekday{color:var(--dsw-alias-label-caption);font-size:9px;line-height:12px;text-align:right;width:14px}",
			".tkl_stripCols{min-width:0}",
			".tkl_months{display:grid;grid-auto-flow:column;gap:3px;height:12px;margin-bottom:3px}",
			".tkl_month{color:var(--dsw-alias-label-caption);font-size:9px;line-height:12px;white-space:nowrap;overflow:visible}",
			// `grid-auto-columns` is the whole fix for the cells drifting apart:
			// without it the implicit columns are `auto` and stretch to fill the
			// panel, so twelve weeks of 12px cells spread across 430px and the
			// chart reads as a sparse scatter rather than a heatmap.
			".tkl_stripGrid{display:grid;grid-auto-flow:column;grid-auto-columns:12px;grid-template-rows:repeat(7,12px);gap:3px;justify-content:start}",
			".tkl_cell{width:12px;height:12px;border-radius:2px;background:var(--tkl-level-0);border:0;padding:0;cursor:pointer}",
			".tkl_cell:hover{outline:1px solid var(--dsw-alias-label-tertiary);outline-offset:1px}",
			".tkl_cell[data-l='1']{background:var(--tkl-level-1)}",
			".tkl_cell[data-l='2']{background:var(--tkl-level-2)}",
			".tkl_cell[data-l='3']{background:var(--tkl-level-3)}",
			".tkl_cell[data-l='4']{background:var(--tkl-level-4)}",
			".tkl_cellPad{width:12px;height:12px}",
			".tkl_legend{align-items:center;gap:3px;margin-top:5px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption);display:flex}",
			".tkl_legendSwatch{width:10px;height:10px;border-radius:2px}",

			// -- the day tooltip ---------------------------------------------------
			// A cell that only carries a `title` attribute answers "how much" after
			// a second of hovering and nothing else. The panel already has the
			// per-model split for that day, so showing it is nearly free and turns
			// the strip from decoration into something you read.
			// The tooltip floats over the panel's own content, so it needs an
			// opaque ground even more than the panel does.
			".tkl_tip{position:fixed;z-index:40;pointer-events:none;min-width:180px;max-width:250px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);box-shadow:var(--dsw-shadow-lv2);padding:8px 10px}",
			".tkl_tipHead{display:flex;align-items:center;gap:6px;justify-content:space-between}",
			".tkl_tipDate{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tkl_tipLevel{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 6px;flex:none}",
			".tkl_tipTotal{color:var(--dsw-alias-label-primary);font-size:15px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}",
			".tkl_tipUnit{color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:400;margin-left:4px}",
			".tkl_tipModels{margin-top:6px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px;display:flex;flex-direction:column;gap:5px}",
			".tkl_tipRow{font-size:11px;line-height:15px}",
			".tkl_tipRowHead{display:flex;gap:6px;align-items:baseline}",
			".tkl_tipName{color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tkl_tipValue{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;flex:none}",
			".tkl_tipPct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;width:30px;text-align:right}",
			".tkl_tipBar{background:var(--dsw-alias-fill-l2);border-radius:2px;height:3px;margin-top:2px;overflow:hidden}",
			".tkl_tipBarFill{background:var(--tkl-level-4);border-radius:2px;height:3px}",
			".tkl_tipQuiet{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:6px 0 0}",

			// -- model table -------------------------------------------------------
			".tkl_table{width:100%;border-collapse:collapse;font-size:12px}",
			".tkl_table th{color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:11px;line-height:16px;text-align:right;padding:0 0 5px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;cursor:pointer;user-select:none}",
			".tkl_table th:first-child{text-align:left}",
			".tkl_table th:hover{color:var(--dsw-alias-label-secondary)}",
			".tkl_table td{color:var(--dsw-alias-label-primary);text-align:right;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;white-space:nowrap}",
			".tkl_table td:first-child{text-align:left;max-width:130px;overflow:hidden;text-overflow:ellipsis}",
			".tkl_table tr:last-child td{border-bottom:0}",
			".tkl_hit{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:3px}",
			".tkl_sortMark{color:var(--dsw-alias-label-secondary);margin-left:2px}",

			// -- balance -----------------------------------------------------------
			// The card is a column so quota windows can stack under the amount.
			// With no windows it holds a single child, the gap never applies, and
			// the row renders exactly as it did before they existed.
			".tkl_balance{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);padding:9px 11px;display:flex;flex-direction:column;gap:9px}",
			".tkl_balanceTop{display:flex;align-items:center;gap:8px}",
			".tkl_balanceMain{min-width:0}",
			".tkl_balanceWho{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".tkl_balanceOk{color:var(--dsw-alias-state-success-primary)}",
			".tkl_balanceBad{color:var(--dsw-alias-state-warn-primary)}",
			".tkl_balanceAmount{color:var(--dsw-alias-label-primary);font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}",
			".tkl_balanceMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-left:auto;text-align:right}",

			// -- quota windows -------------------------------------------------------
			// A subscription's allowances: one row per window, each naming itself,
			// when it next empties, and how full it is. The percentage sits beside
			// the bar rather than inside it, so the state is legible without
			// relying on the fill colour — the colour is a second channel, never
			// the only one.
			".tkl_wins{display:flex;flex-direction:column;gap:7px}",
			".tkl_win{display:flex;flex-direction:column;gap:3px}",
			".tkl_winHead{display:flex;align-items:baseline;gap:6px;min-width:0}",
			".tkl_winName{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}",
			".tkl_winReset{color:var(--dsw-alias-label-caption);font-size:10px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tkl_winPct{color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;margin-left:auto;flex:none}",
			".tkl_winBar{height:4px;border-radius:999px;background:var(--tkl-level-0);overflow:hidden}",
			// The three states reuse DSH's own state tokens rather than inventing
			// colours, so they follow whatever the active theme or skin decided
			// those states should look like.
			".tkl_winFill{height:100%;border-radius:999px;background:var(--dsw-alias-state-success-primary)}",
			".tkl_winFill.tkl_winWarn{background:var(--dsw-alias-state-warn-primary)}",
			".tkl_winFill.tkl_winFull{background:var(--dsw-alias-state-error-primary)}",

			// -- footer ------------------------------------------------------------
			".tkl_footer{color:var(--dsw-alias-label-caption);border-top:1px solid var(--dsw-alias-border-l1);margin-top:14px;padding-top:8px;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tkl_warn{color:var(--dsw-alias-state-warn-primary)}",

			// -- skeleton ----------------------------------------------------------
			".tkl_skel{background:var(--dsw-alias-bg-skeleton);border-radius:var(--tkl-radius-xs);height:12px;animation:tkl_pulse 1.4s ease-in-out infinite}",
			".tkl_skelStat{height:52px;border-radius:var(--tkl-radius-sm)}",
			"@keyframes tkl_pulse{0%,100%{opacity:1}50%{opacity:.45}}",
			"@media (prefers-reduced-motion:reduce){.tkl_skel{animation:none}}"
		].join("");

		const STYLE_ID = "dsh-tokenledger/panel.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-tokenledger";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const S = {
			layer: "tkl_layer",
			rail: "tkl_rail",
			badge: "tkl_badge",
			badgeIcon: "tkl_badgeIcon",
			badgeLabel: "tkl_badgeLabel",
			badgeValue: "tkl_badgeValue",
			panel: "tkl_panel",
			header: "tkl_header",
			headerLeft: "tkl_headerLeft",
			title: "tkl_title",
			headerActions: "tkl_headerActions",
			iconButton: "tkl_iconButton",
			body: "tkl_body",
			note: "tkl_note",
			error: "tkl_error",
			retry: "tkl_retry",
			zone: "tkl_zone",
			caption: "tkl_caption",
			section: "tkl_section",
			sectionTitle: "tkl_sectionTitle",
			filter: "tkl_filter",
			picker: "tkl_picker",
			pickerLabel: "tkl_pickerLabel",
			select: "tkl_select",
			stats: "tkl_stats",
			stat: "tkl_stat",
			statValue: "tkl_statValue",
			statLabel: "tkl_statLabel",
			stack: "tkl_stack",
			stackSeg: "tkl_stackSeg",
			swatch: "tkl_swatch",
			rows: "tkl_rows",
			row: "tkl_row",
			rowName: "tkl_rowName",
			rowValue: "tkl_rowValue",
			rowMeta: "tkl_rowMeta",
			strip: "tkl_strip",
			weekdays: "tkl_weekdays",
			weekday: "tkl_weekday",
			stripCols: "tkl_stripCols",
			months: "tkl_months",
			month: "tkl_month",
			stripGrid: "tkl_stripGrid",
			tip: "tkl_tip",
			tipHead: "tkl_tipHead",
			tipDate: "tkl_tipDate",
			tipLevel: "tkl_tipLevel",
			tipTotal: "tkl_tipTotal",
			tipUnit: "tkl_tipUnit",
			tipModels: "tkl_tipModels",
			tipRow: "tkl_tipRow",
			tipRowHead: "tkl_tipRowHead",
			tipName: "tkl_tipName",
			tipValue: "tkl_tipValue",
			tipPct: "tkl_tipPct",
			tipBar: "tkl_tipBar",
			tipBarFill: "tkl_tipBarFill",
			tipQuiet: "tkl_tipQuiet",
			cell: "tkl_cell",
			cellPad: "tkl_cellPad",
			legend: "tkl_legend",
			legendSwatch: "tkl_legendSwatch",
			table: "tkl_table",
			hit: "tkl_hit",
			sortMark: "tkl_sortMark",
			balance: "tkl_balance",
			balanceTop: "tkl_balanceTop",
			balanceMain: "tkl_balanceMain",
			balanceWho: "tkl_balanceWho",
			balanceOk: "tkl_balanceOk",
			balanceBad: "tkl_balanceBad",
			balanceAmount: "tkl_balanceAmount",
			balanceMeta: "tkl_balanceMeta",
			wins: "tkl_wins",
			win: "tkl_win",
			winHead: "tkl_winHead",
			winName: "tkl_winName",
			winReset: "tkl_winReset",
			winPct: "tkl_winPct",
			winBar: "tkl_winBar",
			winFill: "tkl_winFill",
			winWarn: "tkl_winWarn",
			winFull: "tkl_winFull",
			footer: "tkl_footer",
			warn: "tkl_warn",
			skel: "tkl_skel",
			skelStat: "tkl_skelStat"
		};
		//#endregion

		//#region data

		/**
		 * The three windows, which are also the range control.
		 *
		 * A separate selector in the header made you change it three times to
		 * read three numbers everyone wants at once. Showing the windows as
		 * cards answers all three at a glance and doubles as the switch for
		 * everything below.
		 *
		 * `days` is what the request asks for; the card's own figure comes from
		 * the payload's `windows`, so all three are correct whichever is active.
		 */
		const RANGES = [
			{ id: "today", key: "today", days: () => 1 },
			// Day-of-month, so "this month" means the calendar month rather than
			// a rolling thirty days.
			{ id: "month", key: "month", days: () => new Date().getDate() },
			{ id: "all", key: "all", days: () => undefined }
		];

		/** Thousands separators plus tabular figures; an absent count is an em dash. */
		function fmt(value) {
			return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
		}

		/** Percentage of a whole, guarding the zero denominator. */
		function share(part, whole) {
			return typeof part === "number" && typeof whole === "number" && whole > 0 ? (part / whole) * 100 : 0;
		}

		/** A cache hit rate as text; `null` is "no prompt tokens", not "0%". */
		function fmtHit(rate) {
			return typeof rate === "number" && Number.isFinite(rate) ? `${rate}%` : "";
		}

		/** Money with its own currency symbol, or an em dash when unpriced. */
		function fmtMoney(amount, currency) {
			if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
			const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
			const text = amount.toFixed(amount < 1 ? 4 : 2);
			return symbol === "" ? `${text} ${currency ?? ""}`.trim() : `${symbol}${text}`;
		}

		async function fetchJson(path, signal) {
			const response = await fetch(path, { headers: { accept: "application/json" }, signal });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				throw new Error("unexpected response");
			}
			return payload;
		}

		/** `?days=&site=`, mirroring the command's two arguments. */
		function buildQuery(days, site) {
			const parts = [];
			if (days !== undefined) parts.push(`days=${days}`);
			if (site !== undefined && site !== "") parts.push(`site=${encodeURIComponent(site)}`);
			return parts.length === 0 ? "" : `?${parts.join("&")}`;
		}

		function fetchUsage(days, site, signal) {
			return fetchJson(USAGE_PATH + buildQuery(days, site), signal);
		}

		/**
		 * Load the payload for a range, cancelling whatever is in flight.
		 *
		 * A stale response must never paint over a newer one: switching ranges
		 * quickly is the normal way to use this panel, and without the abort the
		 * slower of two requests wins whenever it happens to land last.
		 */
		function useUsage(open, days, site, nonce) {
			const [state, setState] = react.useState({ status: "idle" });

			react.useEffect(() => {
				if (!open) return undefined;
				const controller = new AbortController();
				// Keep the previous data while reloading: blanking the panel on every
				// range change makes it flicker through an empty state it is not in.
				setState((prev) => ({ status: "loading", data: prev.data }));
				fetchUsage(days, site, controller.signal).then(
					(data) => {
						if (!controller.signal.aborted) setState({ status: "ready", data });
					},
					(error) => {
						if (controller.signal.aborted) return;
						setState({ status: "error", message: error?.message ?? String(error) });
					}
				);
				return () => controller.abort();
			}, [open, days, site, nonce]);

			return state;
		}

		/**
		 * The official account balance, fetched once per opening.
		 *
		 * Separate from the usage payload because it reaches a vendor over the
		 * network: a slow or unreachable balance API must not hold up figures that
		 * are already on disk.
		 */
		function useBalance(open, account, nonce) {
			const [state, setState] = react.useState({ status: "idle" });

			react.useEffect(() => {
				if (!open) return undefined;
				const controller = new AbortController();
				setState({ status: "loading" });
				const query = account === undefined ? "" : `?account=${encodeURIComponent(account)}`;
				fetchJson(BALANCE_PATH + query, controller.signal).then(
					(data) => {
						if (!controller.signal.aborted) setState({ status: "ready", data });
					},
					() => {
						// A balance that cannot be read is not worth an error banner over
						// a panel whose real subject is token usage.
						if (!controller.signal.aborted) setState({ status: "off" });
					}
				);
				return () => controller.abort();
			}, [open, account, nonce]);

			return state;
		}
		//#endregion

		//#region view

		/**
		 * The three windows as cards, and the range control.
		 *
		 * Each card always shows its own window's total, not a slice of whatever
		 * is selected — which is the point of showing three. The selected one
		 * drives the sections below.
		 */
		function StatRow({ data, range, onRange, translate }) {
			const windows = data.windows ?? {};
			return jsx("div", {
				className: S.stats,
				children: RANGES.map((r) =>
					jsxs(
						"button",
						{
							type: "button",
							className: S.stat,
							...(r.id === range ? { "data-on": "" } : {}),
							onClick: () => onRange(r.id),
							children: [
								jsx("div", { className: S.statValue, children: fmt(windows[r.key]?.tokens) }),
								jsx("div", { className: S.statLabel, children: translate(`range.${r.id}`) })
							]
						},
						r.id
					)
				)
			});
		}

		function Section({ title, action, children }) {
			return jsxs("div", {
				className: S.section,
				children: [
					jsxs("div", {
						className: S.sectionTitle,
						children: [title, action]
					}),
					children
				]
			});
		}

		/**
		 * The one-line summary of the SELECTED window.
		 *
		 * Requests, cache hit rate and estimated cost do not each deserve a card
		 * — they are qualifiers on the token figure above, and three more boxes
		 * would push the site breakdown below the fold. Cost is an em dash when
		 * unpriced, never a zero.
		 */
		function StatCaption({ data, translate }) {
			const totals = data.totals ?? {};
			const currencies = Object.entries(data.priced?.totals ?? {});
			const parts = [
				translate("caption.requests", { n: fmt(totals.requests) }),
				translate("caption.hit", { rate: fmtHit(totals.cacheHitRate) || "—" })
			];
			if (currencies.length > 0) {
				parts.push(translate("caption.cost", { cost: currencies.map(([c, v]) => fmtMoney(v, c)).join(" + ") }));
			}
			return jsx("p", { className: S.caption, children: parts.join(" · ") });
		}

		/**
		 * The site breakdown — the reason this panel exists.
		 *
		 * Rows are never filtered by the current selection: this list is how you
		 * change that selection, so hiding the others would strand you on whatever
		 * you last clicked. Clicking the active row clears the filter.
		 */
		/**
		 * A site's colour.
		 *
		 * `direct` is deliberately outside the ramp: it is not a relay, and the
		 * distinction between "the vendor" and "someone reselling the vendor" is
		 * the section's whole subject. Relays cycle a fixed palette rather than a
		 * generated hue, so the same site keeps the same colour across reloads.
		 */
		function colorOf(site, index) {
			return site === "direct" ? "var(--tkl-direct)" : `var(--tkl-series-${index % 6})`;
		}

		/**
		 * The site breakdown — the reason this panel exists.
		 *
		 * Rows are never filtered by the current selection: this list is how you
		 * change that selection, so hiding the others would strand you on whatever
		 * you last clicked. Clicking the active row clears the filter.
		 */
		function SiteRows({ data, site, onSelect, translate }) {
			const rows = data.sites ?? [];
			if (rows.length === 0) return jsx("p", { className: S.note, children: translate("sites.none") });
			const total = rows.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
			const byId = new Map((data.directory ?? []).map((d) => [d.id, d]));
			// Relays take the ramp in the order they appear; `direct` sits outside
			// it, so it must not consume a slot and shift everyone else.
			let relay = -1;
			const coloured = rows.map((row) => {
				if (row.site !== "direct") relay += 1;
				return { ...row, color: colorOf(row.site, relay) };
			});

			return jsxs("div", {
				children: [
					// One bar, segmented — a row of separate bars each scaled to the
					// largest made two sites look comparable when one was triple the
					// other. Shares of one whole are the honest shape.
					jsx("div", {
						className: S.stack,
						...(site === undefined ? {} : { "data-dim": "" }),
						children: coloured.map((row) =>
							jsx(
								"span",
								{
									className: S.stackSeg,
									...(row.site === site ? { "data-on": "" } : {}),
									title: `${row.site} · ${fmt(row.tokens)}`,
									style: { width: `${share(row.tokens, total)}%`, background: row.color }
								},
								row.site
							)
						)
					}),
					jsx("div", {
						className: S.rows,
						children: coloured.map((row) => {
							const id = row.site;
							const known = byId.get(id);
							const label = id === "direct" ? translate("sites.direct") : id;
							const routes = known?.routes?.length ? known.routes.join(", ") : undefined;
							return jsxs(
								"button",
								{
									type: "button",
									className: S.row,
									...(id === site ? { "data-on": "" } : {}),
									title: routes === undefined ? label : `${label} · ${routes}`,
									onClick: () => onSelect(id === site ? undefined : id),
									children: [
										jsx("span", { className: S.swatch, style: { background: row.color } }),
										jsx("span", { className: S.rowName, children: label }),
										jsx("span", { className: S.rowValue, children: fmt(row.tokens) }),
										jsx("span", { className: S.rowMeta, children: `${Math.round(share(row.tokens, total))}%` })
									]
								},
								id
							);
						})
					})
				]
			});
		}

		/**
		 * A compact activity strip: weeks as columns, one 12px cell per day.
		 *
		 * A month grid was the obvious thing to copy and is the wrong shape — it
		 * answers "which days were busy" using a whole viewport, where a strip
		 * answers it in one band and shows more than a month at once.
		 *
		 * Levels are relative to the busiest day in view, so a quiet week still
		 * has contrast rather than rendering as one flat colour.
		 */
		function ActivityStrip({ data, translate }) {
			const [hover, setHover] = react.useState(null);
			const scroller = react.useRef(null);

			// Its own window, not the selected range. Tied to the range it
			// collapsed to a single cell whenever "today" was picked, leaving a
			// mostly empty seven-row grid that read as a broken chart.
			const days = data.activity ?? data.days ?? [];
			const byDay = new Map(days.map((d) => [d.day, d.tokens ?? 0]));
			const levelAt = makeLevelScale([...byDay.values()]);

			// Per-day model rows, grouped once rather than on every hover.
			const modelsByDay = react.useMemo(() => {
				const out = new Map();
				for (const row of data.activityModels ?? []) {
					if (!out.has(row.day)) out.set(row.day, []);
					out.get(row.day).push(row);
				}
				for (const rows of out.values()) rows.sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0));
				return out;
			}, [data.activityModels]);

			// Whole weeks ending today, Monday first, idle days present as level
			// zero rather than absent.
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const cells = [];
			for (let back = ACTIVITY_DAYS - 1; back >= 0; back--) {
				const date = new Date(today.getTime() - back * 86_400_000);
				const key = localDayKey(date);
				cells.push({ day: key, date, tokens: byDay.get(key) ?? 0 });
			}
			const startPad = (cells[0].date.getDay() + 6) % 7;
			for (let i = 0; i < startPad; i++) cells.unshift(null);
			const endPad = (7 - (cells.length % 7)) % 7;
			for (let i = 0; i < endPad; i++) cells.push(null);

			// A month label over the column where that month starts. Anything
			// finer collides at 12px per week.
			const weeks = cells.length / 7;
			const monthLabels = [];
			let lastMonth = -1;
			for (let w = 0; w < weeks; w++) {
				const first = cells.slice(w * 7, w * 7 + 7).find(Boolean);
				const month = first === undefined ? lastMonth : first.date.getMonth();
				monthLabels.push(month !== lastMonth && first !== undefined ? translate(`month.${month}`) : "");
				if (first !== undefined) lastMonth = month;
			}

			// Land on the newest week; the year runs off the left edge otherwise.
			react.useEffect(() => {
				const el = scroller.current;
				if (el) el.scrollLeft = el.scrollWidth;
			}, [days.length]);

			const show = (cell) => (event) => {
				const box = event.currentTarget.getBoundingClientRect();
				setHover({ cell, x: box.left + box.width / 2, y: box.top });
			};

			return jsxs("div", {
				children: [
					jsxs("div", {
						className: S.strip,
						ref: scroller,
						children: [
							jsx("div", {
								className: S.weekdays,
								// Two of seven, like GitHub: seven labels at 12px is noise.
								children: [0, 1, 2, 3, 4, 5, 6].map((d) =>
									jsx("span", { className: S.weekday, children: d === 1 || d === 4 ? translate(`weekday.${d}`) : "" }, d)
								)
							}),
							jsxs("div", {
								className: S.stripCols,
								children: [
									jsx("div", {
										className: S.months,
										style: { gridTemplateColumns: `repeat(${weeks}, 12px)` },
										children: monthLabels.map((label, i) => jsx("span", { className: S.month, children: label }, i))
									}),
									jsx("div", {
										className: S.stripGrid,
										children: cells.map((cell, i) =>
											cell === null
												? jsx("span", { className: S.cellPad }, `p${i}`)
												: jsx(
														"span",
														{
															className: S.cell,
															"data-l": String(levelAt(cell.tokens)),
															onMouseEnter: show(cell),
															onMouseLeave: () => setHover(null)
														},
														cell.day
													)
										)
									})
								]
							})
						]
					}),
					jsxs("div", {
						className: S.legend,
						children: [
							jsx("span", { children: translate("activity.less") }),
							[0, 1, 2, 3, 4].map((level) =>
								jsx("span", { className: S.legendSwatch, style: { background: `var(--tkl-level-${level})` } }, level)
							),
							jsx("span", { children: translate("activity.more") })
						]
					}),
					hover === null
						? null
						: jsx(DayTip, {
								cell: hover.cell,
								x: hover.x,
								y: hover.y,
								level: levelAt(hover.cell.tokens),
								models: modelsByDay.get(hover.cell.day) ?? [],
								translate
							})
				]
			});
		}

		/**
		 * What a day was made of.
		 *
		 * A `title` attribute answers "how much" after a second of waiting and
		 * nothing else. The per-model split is already in the payload, so showing
		 * it costs a hover handler and turns the strip from decoration into
		 * something worth pointing at.
		 */
		function DayTip({ cell, x, y, level, models, translate }) {
			const total = cell.tokens ?? 0;
			// Clamped so a cell near either edge does not push the card off-screen.
			const left = Math.min(Math.max(x - 110, 8), Math.max(8, window.innerWidth - 258));
			return jsxs("div", {
				className: S.tip,
				style: { left: `${left}px`, top: `${Math.max(8, y - 8)}px`, transform: "translateY(-100%)" },
				children: [
					jsxs("div", {
						className: S.tipHead,
						children: [
							jsx("span", { className: S.tipDate, children: cell.day }),
							jsx("span", { className: S.tipLevel, children: translate("activity.level", { level }) })
						]
					}),
					jsxs("div", {
						className: S.tipTotal,
						children: [fmt(total), jsx("span", { className: S.tipUnit, children: "tokens" })]
					}),
					models.length === 0
						? jsx("p", { className: S.tipQuiet, children: translate("activity.quiet") })
						: jsx("div", {
								className: S.tipModels,
								children: models.slice(0, 4).map((row) =>
									jsxs(
										"div",
										{
											className: S.tipRow,
											children: [
												jsxs("div", {
													className: S.tipRowHead,
													children: [
														jsx("span", { className: S.tipName, title: row.model, children: row.model }),
														jsx("span", { className: S.tipValue, children: fmt(row.tokens) }),
														jsx("span", { className: S.tipPct, children: `${Math.round(share(row.tokens, total))}%` })
													]
												}),
												jsx("div", {
													className: S.tipBar,
													children: jsx("div", {
														className: S.tipBarFill,
														style: { width: `${Math.max(2, share(row.tokens, total))}%` }
													})
												})
											]
										},
										row.model
									)
								)
							})
				]
			});
		}

		/**
		 * Five buckets by QUANTILE of the days that had any usage.
		 *
		 * Scaling to the maximum was the obvious choice and the wrong one: one
		 * outlier day flattens every other day to level 1, so a year of steady
		 * work renders as a single bright square in a pale field. Median / 75th /
		 * 90th spreads the ramp across the distribution actually present, which is
		 * what makes a heatmap readable.
		 *
		 * @param values - every day's total in the window, zeros included.
		 * @returns a function from a day's total to 0-4.
		 */
		function makeLevelScale(values) {
			const active = values.filter((v) => v > 0).sort((a, b) => a - b);
			if (active.length === 0) return () => 0;

			// Quantiles need a distribution to describe. With only a handful of
			// distinct totals they all collapse onto the same threshold and every
			// active day comes out level 1 — a single busy day rendering as the
			// palest possible green, which reads as "nothing happened". Below four
			// distinct values, rank them instead.
			const distinct = [...new Set(active)];
			if (distinct.length < 4) {
				const rank = new Map(distinct.map((v, i) => [v, distinct.length === 1 ? 4 : 1 + Math.round((i * 3) / (distinct.length - 1))]));
				return (value) => (value > 0 ? (rank.get(value) ?? 4) : 0);
			}

			const at = (q) => {
				const pos = (active.length - 1) * q;
				const base = Math.floor(pos);
				const rest = pos - base;
				const left = active[base];
				const right = active[Math.min(active.length - 1, base + 1)];
				return left + (right - left) * rest;
			};
			const t1 = at(0.5);
			const t2 = at(0.75);
			const t3 = at(0.9);
			return (value) => {
				if (!(value > 0)) return 0;
				if (value <= t1) return 1;
				if (value <= t2) return 2;
				if (value <= t3) return 3;
				return 4;
			};
		}

		/**
		 * `YYYY-MM-DD` from a date's LOCAL components.
		 *
		 * `toISOString()` is the obvious call and the wrong one: it formats in UTC,
		 * while the store keys its days in local time. Mixing the two shifts every
		 * cell by a day for anyone not on UTC — the strip renders one leading blank
		 * and attributes each day's usage to the one before it. Caught by a test
		 * only because this machine happens to sit at UTC+9.
		 */
		function localDayKey(date) {
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			return `${date.getFullYear()}-${month}-${day}`;
		}

		const MODEL_COLUMNS = [
			{ id: "model", label: "table.model", get: (m) => m.model, numeric: false },
			{ id: "requests", label: "table.requests", get: (m) => m.requests ?? 0 },
			{ id: "inputTokens", label: "table.input", get: (m) => m.inputTokens ?? 0 },
			{ id: "cacheReadTokens", label: "table.cache", get: (m) => m.cacheReadTokens ?? 0 },
			{ id: "outputTokens", label: "table.output", get: (m) => m.outputTokens ?? 0 },
			{ id: "cost", label: "table.cost", get: (m) => m.cost ?? -1 }
		];

		/** Same columns as the text report, so the two cannot disagree. */
		function ModelTable({ data, translate }) {
			const [sort, setSort] = react.useState({ by: "inputTokens", desc: true });
			const priced = new Map((data.priced?.rows ?? []).map((r) => [r.model, r]));
			const rows = (data.models ?? []).map((m) => ({ ...m, ...priced.get(m.model) }));
			if (rows.length === 0) return jsx("p", { className: S.note, children: translate("table.none") });

			const column = MODEL_COLUMNS.find((c) => c.id === sort.by) ?? MODEL_COLUMNS[2];
			const sorted = rows.slice().sort((a, b) => {
				const x = column.get(a);
				const y = column.get(b);
				const order = column.numeric === false ? String(x).localeCompare(String(y)) : x - y;
				return sort.desc ? -order : order;
			});

			const toggle = (id) =>
				setSort((prev) => (prev.by === id ? { by: id, desc: !prev.desc } : { by: id, desc: true }));

			return jsxs("table", {
				className: S.table,
				children: [
					jsx("thead", {
						children: jsx("tr", {
							children: MODEL_COLUMNS.map((c) =>
								jsxs(
									"th",
									{
										onClick: () => toggle(c.id),
										children: [
											translate(c.label),
											sort.by === c.id ? jsx("span", { className: S.sortMark, children: sort.desc ? "↓" : "↑" }) : null
										]
									},
									c.id
								)
							)
						})
					}),
					jsx("tbody", {
						children: sorted.map((m) =>
							jsxs(
								"tr",
								{
									children: [
										jsx("td", { title: m.model, children: m.model }),
										jsx("td", { children: fmt(m.requests) }),
										jsx("td", { children: fmt(m.inputTokens) }),
										jsxs("td", {
											children: [
												fmt(m.cacheReadTokens),
												jsx("span", { className: S.hit, children: fmtHit(m.cacheHitRate) }),
												// Cache WRITES count toward the total but had no column, so
												// the row did not add up to it — 520 tokens invisible on a
												// real install. The relay's own log marks them the same way.
												(m.cacheWriteTokens ?? 0) > 0
													? jsx("span", { className: S.hit, children: ` ↑${fmt(m.cacheWriteTokens)}` })
													: null
											]
										}),
										jsx("td", { children: fmt(m.outputTokens) }),
										jsx("td", { children: m.cost === null || m.cost === undefined ? "—" : fmtMoney(m.cost, m.currency) })
									]
								},
								m.model
							)
						)
					})
				]
			});
		}

		/**
		 * DeepSeek official balance.
		 *
		 * A deployment with only relays renders one honest line rather than an
		 * empty card: a relay has no balance endpoint of this shape, and nothing
		 * is wrong when it says so.
		 */
		/**
		 * Which account the balance card is showing.
		 *
		 * A picker rather than one card per account: a user with several relays
		 * would otherwise get a stack of cards pushing the usage below the fold,
		 * and only one of them is being looked at.
		 */
		function AccountPicker({ accounts, value, onChange, translate }) {
			if (accounts.length <= 1) return null;
			return jsxs("label", {
				className: S.picker,
				children: [
					jsx("span", { className: S.pickerLabel, children: translate("balance.account") }),
					jsx("select", {
						className: S.select,
						value: value ?? accounts[0].id,
						onChange: (event) => onChange(event.target.value),
						children: accounts.map((a) =>
							jsx("option", { value: a.id, children: a.displayName }, a.id)
						)
					})
				]
			});
		}

		/**
		 * What to call one window.
		 *
		 * `minutes` is consulted only for `session`, because it is the only kind
		 * whose own name says nothing about how long it is — one plan's rolling
		 * window is five hours, another's is three, and a `session` row labelled
		 * "5 hours" on both would be a number the panel made up. `weekly` and
		 * `monthly` already state their period, so a length would only repeat it.
		 */
		function windowLabel(window, translate) {
			if (window.kind === "session" && typeof window.minutes === "number") {
				const minutes = window.minutes;
				if (minutes % 1440 === 0) return translate("balance.window.days", { n: minutes / 1440 });
				if (minutes % 60 === 0) return translate("balance.window.hours", { n: minutes / 60 });
				return translate("balance.window.minutes", { n: minutes });
			}
			return translate(`balance.window.${window.kind}`);
		}

		/**
		 * A subscription's rolling allowances.
		 *
		 * These accounts hold no money — several independent windows fill up and
		 * empty on their own clocks, and "how much of the current one is left" is
		 * the question the panel exists to answer. Rendered under the amount
		 * rather than instead of it: a plan with a wallet behind it has both.
		 */
		function QuotaWindows({ windows, translate }) {
			if (!Array.isArray(windows) || windows.length === 0) return null;
			return jsx("div", {
				className: S.wins,
				children: windows.map((window) => {
					const used = window.usedPercent;
					const known = typeof used === "number";
					// Three bands, and the number is always spelled out beside the
					// bar — the colour repeats the state, it does not carry it.
					const tone = !known || used < 75 ? "" : used >= 100 ? ` ${S.winFull}` : ` ${S.winWarn}`;
					return jsxs("div", {
						className: S.win,
						children: [
							jsxs("div", {
								className: S.winHead,
								children: [
									jsx("span", { className: S.winName, children: windowLabel(window, translate) }),
									window.resetsAt === undefined
										? null
										: jsx("span", {
												className: S.winReset,
												children: translate("balance.window.reset", { at: fmtReset(window.resetsAt) })
											}),
									jsx("span", {
										className: S.winPct,
										children: window.unlimited === true
											? translate("balance.window.unlimited")
											: known
												? translate("balance.window.used", { pct: String(used) })
												: "—"
									})
								]
							}),
							// An unlimited window has no fraction to draw, and a bar
							// stuck at zero would read as "none used of a finite
							// allowance" — the opposite of what it means.
							window.unlimited === true || !known
								? null
								: jsx("div", {
										className: S.winBar,
										role: "progressbar",
										"aria-valuenow": used,
										"aria-valuemin": 0,
										"aria-valuemax": 100,
										"aria-label": windowLabel(window, translate),
										children: jsx("div", { className: `${S.winFill}${tone}`, style: { width: `${used}%` } })
									})
						]
					});
				})
			});
		}

		/**
		 * A reset instant, to the minute.
		 *
		 * Rendered in the viewer's own locale and zone rather than the vendor's:
		 * the question is "when does this free up for me", and an instant printed
		 * in someone else's timezone answers a different one.
		 */
		function fmtReset(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return iso;
			return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
		}

		/**
		 * One account's balance, whatever software serves it.
		 *
		 * Every scheme returns the same shape, so this renders DeepSeek, New API
		 * and Sub2API without branching on the vendor — the differences that do
		 * matter (an unlimited key, a plan name, a raw quota where the site
		 * publishes no unit price) are extra lines, not different cards.
		 */
		function BalanceCard({ state, translate }) {
			if (state.status === "loading") return jsx("div", { className: `${S.skel} ${S.skelStat}` });
			if (state.status !== "ready") return null;
			const balance = state.data;

			if (balance.supported === false) {
				const key =
					balance.reason === "unknown-software"
						? "balance.unknownSoftware"
						: balance.reason === "unknown-account"
							? "balance.unknownAccount"
							: "balance.unavailable";
				return jsx("p", { className: S.note, children: translate(key) });
			}
			if (balance.fetched !== true) {
				// A hint outranks the raw reason: some endpoints want a different
				// credential from the one the route carries, and "401" alone sends
				// people to check a key that is perfectly fine.
				const key =
					balance.hint !== undefined
						? `balance.hint.${balance.hint}`
						: balance.reason === "no-credential"
							? "balance.noKey"
							: "balance.failed";
				return jsx("p", { className: S.note, children: translate(key, { reason: balance.reason ?? "" }) });
			}

			// A remaining balance when there is one; otherwise what this key has
			// SPENT, labelled as such. An unlimited key has no remaining quota,
			// and the number New API returns for it is the negated usage — shown
			// as a balance it was a negative figure meaning nothing.
			const spent = typeof balance.used === "number";
			const amount =
				typeof balance.total === "number"
					? fmtMoney(balance.total, balance.currency)
					: spent
						? fmtMoney(balance.used, balance.currency)
						: balance.quota?.available !== undefined
							? translate("balance.quota", { n: fmt(balance.quota.available) })
							: "—";
			const amountLabel = typeof balance.total === "number" ? undefined : spent ? translate("balance.spent") : undefined;

			const notes = [];
			// Say it first. These numbers came out of paths the user wrote, so a
			// wrong one is a configuration mistake — and that has to be
			// distinguishable from the plugin misreading a vendor it claims to
			// support, or the first bug report will be filed against us.
			if (balance.declared === true) notes.push(translate("balance.declared"));
			if (balance.unlimited === true) notes.push(translate("balance.unlimited"));
			if (typeof balance.expiresAt === "number") {
				notes.push(translate("balance.expires", { at: new Date(balance.expiresAt * 1000).toLocaleDateString() }));
			}
			if (typeof balance.granted === "number" && balance.granted > 0) {
				notes.push(translate("balance.granted", { amount: fmtMoney(balance.granted, balance.currency) }));
			}
			if (typeof balance.plan === "string" && balance.plan !== "") {
				notes.push(translate("balance.plan", { plan: balance.plan }));
			}

			// A request that succeeded and produced nothing readable is the one
			// failure a blank card cannot express. These payloads have no
			// published schema, so the reader says which field it went looking
			// for and the user has something to forward instead of "it's empty".
			const unparsed =
				balance.windows === undefined && balance.total === undefined && typeof balance.reason === "string"
					? translate("balance.unparsed", { reason: balance.reason })
					: undefined;

			return jsxs("div", {
				className: S.balance,
				children: [
					jsxs("div", {
						className: S.balanceTop,
						children: [
					jsxs("div", {
						className: S.balanceMain,
						children: [
							// Name the vendor AND the software. "Official balance"
							// answers nothing on a panel that also reports relays.
							jsx("div", {
								className: S.balanceWho,
								children: [balance.displayName, SCHEME_LABELS[balance.scheme], balance.keyName]
									.filter(Boolean)
									.join(" · ")
							}),
							jsxs("div", {
								className: S.balanceAmount,
								children: [
									amount,
									amountLabel === undefined
										? null
										: jsx("span", { className: S.tipUnit, children: amountLabel })
								]
							})
						]
					}),
					jsxs("div", {
						className: S.balanceMeta,
						children: [
							jsx("div", {
								className: balance.isAvailable === true ? S.balanceOk : S.balanceBad,
								children: balance.isAvailable === true ? translate("balance.active") : translate("balance.inactive")
							}),
							notes.length === 0 ? null : jsx("div", { children: notes.join(" · " ) })
						]
					})
						]
					}),
					// Under the amount, not instead of it. An account can hold both
					// a wallet and a plan, and the card has to be able to say so.
					jsx(QuotaWindows, { windows: balance.windows, translate }),
					unparsed === undefined ? null : jsx("p", { className: S.note, children: unparsed })
				]
			});
		}

		/**
		 * How each relay program is named on the card.
		 *
		 * Only where the name adds something the host does not already say. A
		 * vendor whose display name is already "OpenCode Go" gains nothing from a
		 * second "OpenCode Go" beside it.
		 */
		const SCHEME_LABELS = { deepseek: "API 余额", newapi: "New API", sub2api: "Sub2API" };

		/** Index health. A stale or lossy index must say so on the page. */
		/**
		 * How long ago, in the words the question is actually asked in.
		 *
		 * The sweep runs every minute, so an absolute timestamp is always "about a
		 * minute ago" written as a clock time the reader has to subtract from. It
		 * also read as jargon — the line said "index updated", which is this
		 * package's internal word for its rollup table, and a user reasonably
		 * asked what an index was.
		 */
		function agoLabel(at, translate, now = Date.now()) {
			if (typeof at !== "number") return translate("footer.never");
			const seconds = Math.max(0, Math.round((now - at) / 1000));
			if (seconds < 90) return translate("footer.justNow");
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return translate("footer.minutes", { n: minutes });
			const hours = Math.round(minutes / 60);
			if (hours < 24) return translate("footer.hours", { n: hours });
			return translate("footer.days", { n: Math.round(hours / 24) });
		}

		function Footer({ data, translate }) {
			const d = data.diagnostics ?? {};
			// When the logs were LOOKED AT, not when they last changed. Those are
			// different facts, and reporting the second as freshness made a quiet
			// hour look like a stuck panel — the figures were current the whole
			// time, and the line said they were an hour old.
			const checked = data.lastSweepAt;
			return jsxs("div", {
				className: S.footer,
				children: [
					jsx("span", {
						// The exact moment is still one hover away, for anyone who
						// wants to know rather than to judge freshness.
						title: typeof checked === "number" ? new Date(checked).toLocaleString() : "",
						children: translate("footer.updated", { ago: agoLabel(checked, translate) })
					}),
					typeof d.lastUpdatedAt === "number"
						? jsx("span", {
								title: new Date(d.lastUpdatedAt).toLocaleString(),
								children: ` · ${translate("footer.lastActivity", { ago: agoLabel(d.lastUpdatedAt, translate) })}`
							})
						: null,
					d.unattributedRows > 0
						? jsx("span", {
								className: S.warn,
								children: ` · ${translate("footer.unattributed", { n: fmt(d.unattributedRows) })}`
							})
						: null
				]
			});
		}

		function Skeleton() {
			return jsxs("div", {
				children: [
					jsx("div", {
						className: S.stats,
						children: [0, 1, 2].map((i) => jsx("div", { className: `${S.skel} ${S.skelStat}` }, i))
					}),
					jsx("div", { className: S.section, children: jsx("div", { className: S.skel, style: { height: "76px" } }) })
				]
			});
		}

		/** The panel body: every section, each complete. */
		function Body({ state, balance, site, onSelect, range, onRange, account, onAccount, translate, onRetry }) {
			if (state.status === "error") {
				return jsxs("div", {
					children: [
						jsx("p", { className: S.error, children: translate("error.load") }),
						jsx("p", { className: S.note, children: state.message }),
						jsx("button", { type: "button", className: S.retry, onClick: onRetry, children: translate("action.retry") })
					]
				});
			}
			if (state.data === undefined) return jsx(Skeleton, {});

			const data = state.data;
			const empty = (data.totals?.requests ?? 0) === 0;

			return jsxs("div", {
				children: [
					jsx(Section, {
						title: translate("section.balance"),
						action: jsx(AccountPicker, {
							accounts: data.accounts ?? [],
							value: account,
							onChange: onAccount,
							translate
						}),
						children: jsx(BalanceCard, { state: balance, translate })
					}),
					jsx(Section, {
						title: translate("section.usage"),
						action: site === undefined
							? null
							: jsx("button", {
									type: "button",
									className: S.filter,
									onClick: () => onSelect(undefined),
									children: translate("filter.clear", { site })
								}),
						children: jsxs("div", {
							children: [
								jsx(StatRow, { data, range, onRange, translate }),
								empty
									? jsx("p", { className: S.note, children: translate("state.empty") })
									: jsx(StatCaption, { data, translate })
							]
						})
					}),
					jsx(Section, {
						title: translate("section.sites"),
						children: jsx(SiteRows, { data, site, onSelect, translate })
					}),
					empty
						? null
						: jsx(Section, {
								title: translate("section.activity"),
								// Days are cut by the HOST's clock, so the panel says whose.
								action:
									data.timeZone === undefined
										? null
										: jsx("span", {
												className: S.zone,
												title: data.timeZone.name ?? "",
												children: data.timeZone.offset
											}),
								children: jsx(ActivityStrip, { data, translate })
							}),
					empty ? null : jsx(Section, { title: translate("section.models"), children: jsx(ModelTable, { data, translate }) }),
					jsx(Footer, { data, translate })
				]
			});
		}

		/**
		 * The footer seat and its panel.
		 *
		 * The slot hands over only `wide` — whether the sidebar is expanded or
		 * collapsed to its rail — so everything else, including the panel's own
		 * open state and chrome, belongs to this component.
		 */
		function TokenLedgerPanel({ wide, t }) {
			const [open, setOpen] = react.useState(false);
			const [range, setRange] = react.useState("all");
			const [site, setSite] = react.useState(undefined);
			const [account, setAccount] = react.useState(undefined);
			const [nonce, setNonce] = react.useState(0);
			const days = (RANGES.find((r) => r.id === range) ?? RANGES[2]).days();
			const state = useUsage(open, days, site, nonce);
			const balance = useBalance(open, account, nonce);
			const reload = () => setNonce((n) => n + 1);
			const translate = translateWith(t);

			// Escape and a click anywhere else both close, and both listeners exist
			// only while open: a global handler that outlives the panel would
			// swallow the key, or the click, from whatever owns it next.
			//
			// The badge lives inside `root` too, so its own toggle handles it and
			// this does not fire — otherwise clicking the badge to close would
			// close and immediately reopen.
			//
			// `pointerdown` rather than `click`: a press that starts inside the
			// panel and drifts out (selecting a figure to copy, dragging the
			// activity strip) must not be read as a dismissal.
			const root = react.useRef(null);
			react.useEffect(() => {
				if (!open) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				const onDown = (event) => {
					if (root.current !== null && !root.current.contains(event.target)) setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				document.addEventListener("pointerdown", onDown, true);
				return () => {
					window.removeEventListener("keydown", onKey);
					document.removeEventListener("pointerdown", onDown, true);
				};
			}, [open]);

			const busy = state.status === "loading";
			const totalLabel = state.data === undefined ? "" : fmt(state.data.totals?.tokens);

			return jsxs("div", {
				ref: root,
				className: wide === false ? `${S.layer} ${S.rail}` : S.layer,
				children: [
					jsxs("button", {
						type: "button",
						className: S.badge,
						...(open ? { "data-active": "" } : {}),
						title: translate("panel.title"),
						"aria-label": translate("panel.title"),
						onClick: () => setOpen((value) => !value),
						children: [
							jsx("span", { className: S.badgeIcon, children: jsx(primitives.IconDataOutline16, { size: 16 }) }),
							jsx("span", { className: S.badgeLabel, children: translate("panel.title") }),
							jsx("span", { className: S.badgeValue, children: totalLabel })
						]
					}),
					open &&
						jsxs("div", {
							className: S.panel,
							role: "dialog",
							"aria-label": translate("panel.title"),
							children: [
								jsxs("div", {
									className: S.header,
									children: [
										jsx("div", {
											className: S.headerLeft,
											children: jsx("span", { className: S.title, children: translate("panel.title") })
										}),
										jsxs("div", {
											className: S.headerActions,
											children: [
													jsx("button", {
													type: "button",
													className: S.iconButton,
													...(busy ? { "data-busy": "" } : {}),
													"aria-label": translate("action.refresh"),
													onClick: () => {
														if (!busy) reload();
													},
													children: jsx(primitives.IconRefreshOutline14, { size: 14 })
												}),
												jsx("button", {
													type: "button",
													className: S.iconButton,
													"aria-label": translate("action.close"),
													onClick: () => setOpen(false),
													children: jsx(primitives.IconCloseOutline16, { size: 16 })
												})
											]
										})
									]
								}),
								jsx("div", {
									className: S.body,
									children: jsx(Body, { state, balance, site, onSelect: setSite, range, onRange: setRange, account, onAccount: setAccount, translate, onRetry: reload })
								})
							]
						})
				]
			});
		}
		//#endregion

		//#region locales
		const zh = {
			"panel.title": "用量账本",
			"range.today": "今日",
			"range.month": "本月",
			"range.all": "累计",
			"action.refresh": "刷新",
			"action.close": "关闭",
			"action.retry": "重试",
			"state.loading": "读取中…",
			"state.empty": "这个区间内没有记录到任何用量。",
			"error.load": "读不到用量数据。",
			"section.balance": "余额",
			"section.usage": "Token 用量",
			"section.sites": "中转站分布",
			"section.activity": "活跃度",
			"section.models": "模型",
			"filter.clear": "只看 {site} ×",
			"caption.requests": "{n} 请求",
			"caption.hit": "缓存命中 {rate}",
			"caption.cost": "估算 {cost}",
			"sites.direct": "直连/官方",
			"sites.none": "没有发现中转站——直连的话这就是全部。",
			"activity.none": "这个区间内没有活跃记录。",
			"activity.level": "等级 {level}",
			"activity.quiet": "这天没有跑过请求。",
			"month.0": "1月",
			"month.1": "2月",
			"month.2": "3月",
			"month.3": "4月",
			"month.4": "5月",
			"month.5": "6月",
			"month.6": "7月",
			"month.7": "8月",
			"month.8": "9月",
			"month.9": "10月",
			"month.10": "11月",
			"month.11": "12月",
			"weekday.0": "一",
			"weekday.1": "二",
			"weekday.2": "三",
			"weekday.3": "四",
			"weekday.4": "五",
			"weekday.5": "六",
			"weekday.6": "日",
			"activity.less": "少",
			"activity.more": "多",
			"table.model": "模型",
			"table.requests": "请求",
			"table.input": "输入",
			"table.cache": "缓存",
			"table.output": "输出",
			"table.cost": "估算",
			"table.none": "没有模型记录。",
			"balance.account": "账户",
			"balance.plan": "套餐 {plan}",
			"balance.declared": "自定义端点",
			"balance.unlimited": "不限额度",
			"balance.quota": "{n} 额度",
			"balance.spent": "已用",
			"balance.expires": "{at} 到期",
			"balance.unknownSoftware": "认不出这个中转站跑的是什么程序，读不了余额。",
			"balance.unknownAccount": "找不到这个账户。",
			"balance.failed": "余额读取失败（{reason}）。",
			"balance.hint.openrouter-management-key": "OpenRouter 的额度接口要的是 Management Key，不是这条路由用的推理 key。",
			"balance.noKey": "这条路由没有配置密钥，查不了余额。",
			"balance.active": "账户可用",
			"balance.inactive": "账户不可用",
			"balance.granted": "其中赠送 {amount}",
			"balance.unparsed": "接口答了，但认不出配额字段（{reason}）。可以把这句话反馈给我们。",
			"balance.window.session": "当前窗口",
			"balance.window.daily": "每日窗口",
			"balance.window.weekly": "每周窗口",
			"balance.window.monthly": "每月窗口",
			"balance.window.billing": "计费周期",
			"balance.window.hours": "{n} 小时窗口",
			"balance.window.days": "{n} 天窗口",
			"balance.window.minutes": "{n} 分钟窗口",
			"balance.window.reset": "{at} 重置",
			"balance.window.used": "已用 {pct}%",
			"balance.window.unlimited": "不限量",
			"balance.noRoute": "没有直连 DeepSeek 官方的路由——中转站没有余额接口。",
			"balance.unavailable": "这个部署问不到 provider 配置。",
			"footer.updated": "{ago}从会话日志读取",
			"footer.justNow": "刚刚",
			"footer.minutes": "{n} 分钟前",
			"footer.hours": "{n} 小时前",
			"footer.days": "{n} 天前",
			"footer.never": "尚未",
			"footer.lastActivity": "最近一次用量{ago}",
			"footer.unattributed": "{n} 行认不出是哪个站"
		};
		const en = {
			"panel.title": "Token Ledger",
			"range.today": "Today",
			"range.month": "This month",
			"range.all": "All time",
			"action.refresh": "Refresh",
			"action.close": "Close",
			"action.retry": "Retry",
			"state.loading": "Loading…",
			"state.empty": "No usage recorded in this range.",
			"error.load": "Could not read usage data.",
			"section.balance": "Balance",
			"section.usage": "Token usage",
			"section.sites": "By relay site",
			"section.activity": "Activity",
			"section.models": "Models",
			"filter.clear": "{site} only ×",
			"caption.requests": "{n} requests",
			"caption.hit": "{rate} cached",
			"caption.cost": "est. {cost}",
			"sites.direct": "Direct",
			"sites.none": "No relay sites found — if you go direct, this is all of it.",
			"activity.none": "No activity in this range.",
			"activity.level": "Level {level}",
			"activity.quiet": "Nothing ran this day.",
			"month.0": "Jan",
			"month.1": "Feb",
			"month.2": "Mar",
			"month.3": "Apr",
			"month.4": "May",
			"month.5": "Jun",
			"month.6": "Jul",
			"month.7": "Aug",
			"month.8": "Sep",
			"month.9": "Oct",
			"month.10": "Nov",
			"month.11": "Dec",
			"weekday.0": "Mon",
			"weekday.1": "Tue",
			"weekday.2": "Wed",
			"weekday.3": "Thu",
			"weekday.4": "Fri",
			"weekday.5": "Sat",
			"weekday.6": "Sun",
			"activity.less": "Less",
			"activity.more": "More",
			"table.model": "Model",
			"table.requests": "Req",
			"table.input": "Input",
			"table.cache": "Cache",
			"table.output": "Output",
			"table.cost": "Est.",
			"table.none": "No model records.",
			"balance.account": "Account",
			"balance.plan": "{plan} plan",
			"balance.declared": "declared endpoint",
			"balance.unlimited": "Unlimited",
			"balance.quota": "{n} quota",
			"balance.spent": "spent",
			"balance.expires": "expires {at}",
			"balance.unknownSoftware": "This relay runs software we do not recognise, so its balance cannot be read.",
			"balance.unknownAccount": "No such account.",
			"balance.failed": "Could not read the balance ({reason}).",
			"balance.hint.openrouter-management-key": "OpenRouter's credits endpoint wants a Management Key, not the inference key this route uses.",
			"balance.noKey": "That route has no key configured.",
			"balance.active": "Account active",
			"balance.inactive": "Account inactive",
			"balance.granted": "{amount} granted",
			"balance.unparsed": "The endpoint answered, but none of the quota fields were where they were expected ({reason}). Worth reporting.",
			"balance.window.session": "Current window",
			"balance.window.daily": "Daily",
			"balance.window.weekly": "Weekly",
			"balance.window.monthly": "Monthly",
			"balance.window.billing": "Billing period",
			"balance.window.hours": "{n}-hour window",
			"balance.window.days": "{n}-day window",
			"balance.window.minutes": "{n}-minute window",
			"balance.window.reset": "resets {at}",
			"balance.window.used": "{pct}% used",
			"balance.window.unlimited": "Unlimited",
			"balance.noRoute": "No direct DeepSeek route — relays have no balance API.",
			"balance.unavailable": "This deployment exposes no provider directory.",
			"footer.updated": "Read from your session logs {ago}",
			"footer.justNow": "just now",
			"footer.minutes": "{n} min ago",
			"footer.hours": "{n} h ago",
			"footer.days": "{n} d ago",
			"footer.never": "never",
			"footer.lastActivity": "last usage {ago}",
			"footer.unattributed": "{n} rows could not be attributed"
		};

		/**
		 * Resolve a key through the host's locale service, then interpolate.
		 *
		 * `t` arrives as a prop because the registration names a `locale`
		 * namespace. It is still guarded: a composition without the service hands
		 * over nothing, and falling back to the zh dictionary renders words rather
		 * than raw keys.
		 */
		function translateWith(t) {
			return (key, params) => {
				const resolved = t === undefined ? undefined : t(key);
				const template = resolved === undefined || resolved === key ? (zh[key] ?? key) : resolved;
				if (params === undefined) return template;
				return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
			};
		}
		//#endregion

		/** Client-half services this bundle needs before it can register. */
		const inject = ["slots", "locale"];

		/**
		 * Register the seat.
		 *
		 * `slots.inject` rather than a bare `register`, so a late-declared or
		 * re-declared slot is followed instead of missed — the sidebar declares
		 * this hole, and this bundle must not assume it is already there.
		 */
		function apply(ctx) {
			console.info("[tokenledger] apply() called; registering the footer seat");
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "tokenledger: dictionaries");
			} catch (error) {
				// Dictionaries are a nicety; the seat is the point. Losing one must
				// not cost the other.
				console.warn("[tokenledger] locale.register failed; falling back to built-in strings:", error);
			}
			try {
				ctx.slots.inject("sidebar.footer.action", () => {
					console.info("[tokenledger] sidebar.footer.action is available; registering");
					return ctx.slots.register(
						{ name: "sidebar.footer.action", id: "tokenledger", locale: NS, order: 20 },
						TokenLedgerPanel
					);
				});
			} catch (error) {
				console.error("[tokenledger] could not take the footer seat:", error);
				throw error;
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TokenLedgerPanel = TokenLedgerPanel;
		exports.StatCaption = StatCaption;
		exports.ACTIVITY_DAYS = ACTIVITY_DAYS;
		exports.Body = Body;
		exports.StatRow = StatRow;
		exports.SiteRows = SiteRows;
		exports.colorOf = colorOf;
		exports.ActivityStrip = ActivityStrip;
		exports.ModelTable = ModelTable;
		exports.BalanceCard = BalanceCard;
		exports.QuotaWindows = QuotaWindows;
		exports.AccountPicker = AccountPicker;
		exports.Footer = Footer;
		exports.agoLabel = agoLabel;
		exports.translateWith = translateWith;
		exports.buildQuery = buildQuery;
		exports.makeLevelScale = makeLevelScale;
		exports.DayTip = DayTip;
		exports.localDayKey = localDayKey;
		exports.fmtMoney = fmtMoney;
		exports.fmtHit = fmtHit;
		exports.share = share;
		exports.fmt = fmt;
		exports.RANGES = RANGES;
		exports.USAGE_PATH = USAGE_PATH;
		exports.zh = zh;
		exports.en = en;
		console.info("[tokenledger] factory ready; exports:", Object.keys(module.exports).join(", "));
		return module.exports;
	}
});
