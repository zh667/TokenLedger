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
			".tkl_badgeIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px}",
			".tkl_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
			".tkl_badgeValue{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}",
			// Collapsed sidebar: the shell narrows to a 56px rail and every control
			// becomes a 36px circle. Without this the badge keeps its full width and
			// spills out of the rail.
			".tkl_layer.tkl_rail{flex:none;width:36px;height:36px;margin:0}",
			".tkl_layer.tkl_rail .tkl_badge{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}",
			".tkl_layer.tkl_rail .tkl_badgeLabel,.tkl_layer.tkl_rail .tkl_badgeValue{display:none}",

			// -- the panel ---------------------------------------------------------
			".tkl_panel{z-index:30;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);width:460px;max-width:calc(100vw - 24px);max-height:76vh;box-shadow:var(--dsw-shadow-lv2);border-radius:12px;flex-direction:column;display:flex;position:fixed;bottom:128px;left:12px;overflow:hidden;" +
				// Scoped here rather than on :root so nothing escapes into the host.
				"--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);" +
				"--tkl-radius:12px;--tkl-radius-sm:8px;--tkl-radius-xs:6px;" +
				// The activity ramp: Tailwind's emerald over GitHub's neutral zero.
				// Level 0 is an alpha grey so it reads on both themes without a swap.
				"--tkl-level-0:rgba(128,128,128,0.16);--tkl-level-1:#a7f3d0;--tkl-level-2:#6ee7b7;--tkl-level-3:#34d399;--tkl-level-4:#10b981}",
			"@media (prefers-color-scheme:dark){.tkl_panel{--tkl-level-1:#065f46;--tkl-level-2:#059669;--tkl-level-3:#10b981;--tkl-level-4:#34d399}}",
			// An explicit theme choice must win over the media query in BOTH
			// directions, so each is stated rather than inherited.
			"[data-theme='dark'] .tkl_panel{--tkl-level-1:#065f46;--tkl-level-2:#059669;--tkl-level-3:#10b981;--tkl-level-4:#34d399}",
			"[data-theme='light'] .tkl_panel{--tkl-level-1:#a7f3d0;--tkl-level-2:#6ee7b7;--tkl-level-3:#34d399;--tkl-level-4:#10b981}",

			".tkl_header{box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);flex:none;justify-content:space-between;align-items:center;min-height:44px;padding:10px 12px;display:flex;gap:8px}",
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
			".tkl_ranges{display:flex;gap:2px;align-items:center}",
			".tkl_range{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:var(--tkl-radius-xs);padding:3px 8px;font:inherit;font-size:12px;line-height:18px}",
			".tkl_range:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".tkl_range[data-on]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}",

			// -- sections ----------------------------------------------------------
			".tkl_section{margin-top:14px}",
			".tkl_section:first-child{margin-top:0}",
			".tkl_sectionTitle{color:var(--dsw-alias-label-tertiary);margin:0 0 6px;font-size:11px;line-height:16px;font-weight:500}",
			".tkl_filter{color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-interactive-bg-active);border:none;border-radius:999px;margin-left:6px;padding:1px 8px;font:inherit;font-size:11px;line-height:16px}",
			".tkl_filter:hover{color:var(--dsw-alias-label-primary)}",

			// -- stat row ----------------------------------------------------------
			".tkl_stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}",
			".tkl_stat{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);padding:8px 10px;min-width:0}",
			".tkl_statValue{color:var(--dsw-alias-label-primary);font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".tkl_statLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:2px}",

			// -- generic rows (sites) ----------------------------------------------
			".tkl_rows{flex-direction:column;display:flex}",
			".tkl_row{width:100%;align-items:center;gap:8px;border:0;background:0 0;border-bottom:1px solid var(--dsw-alias-border-l1);padding:6px 4px;font:inherit;text-align:left;cursor:pointer;display:flex;border-radius:var(--tkl-radius-xs)}",
			".tkl_row:last-child{border-bottom:0}",
			".tkl_row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_row[data-on]{background:var(--dsw-alias-interactive-bg-active)}",
			".tkl_rowName{color:var(--dsw-alias-label-primary);flex:none;width:150px;min-width:0;font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".tkl_rowBarTrack{background:var(--dsw-alias-fill-l2);border-radius:2px;height:6px;flex:1;min-width:16px;overflow:hidden}",
			".tkl_rowBar{background:var(--dsw-alias-label-tertiary);border-radius:2px;height:6px}",
			".tkl_rowValue{color:var(--dsw-alias-label-primary);flex:none;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right;min-width:64px}",
			".tkl_rowMeta{color:var(--dsw-alias-label-tertiary);flex:none;width:44px;font-size:11px;line-height:18px;font-variant-numeric:tabular-nums;text-align:right}",

			// -- activity strip ----------------------------------------------------
			// A strip, not a month grid: one row of weeks reads at a glance and
			// costs 90px instead of a viewport.
			".tkl_strip{overflow-x:auto;padding-bottom:2px}",
			".tkl_stripGrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,12px);gap:3px}",
			".tkl_cell{width:12px;height:12px;border-radius:2px;background:var(--tkl-level-0);border:0;padding:0;cursor:default}",
			".tkl_cell[data-l='1']{background:var(--tkl-level-1)}",
			".tkl_cell[data-l='2']{background:var(--tkl-level-2)}",
			".tkl_cell[data-l='3']{background:var(--tkl-level-3)}",
			".tkl_cell[data-l='4']{background:var(--tkl-level-4)}",
			".tkl_cellPad{width:12px;height:12px}",
			".tkl_legend{align-items:center;gap:3px;margin-top:5px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption);display:flex}",
			".tkl_legendSwatch{width:10px;height:10px;border-radius:2px}",

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
			".tkl_balance{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--tkl-radius-sm);padding:9px 11px;display:flex;align-items:baseline;gap:8px}",
			".tkl_balanceAmount{color:var(--dsw-alias-label-primary);font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}",
			".tkl_balanceMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-left:auto;text-align:right}",

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
			ranges: "tkl_ranges",
			range: "tkl_range",
			section: "tkl_section",
			sectionTitle: "tkl_sectionTitle",
			filter: "tkl_filter",
			stats: "tkl_stats",
			stat: "tkl_stat",
			statValue: "tkl_statValue",
			statLabel: "tkl_statLabel",
			rows: "tkl_rows",
			row: "tkl_row",
			rowName: "tkl_rowName",
			rowBarTrack: "tkl_rowBarTrack",
			rowBar: "tkl_rowBar",
			rowValue: "tkl_rowValue",
			rowMeta: "tkl_rowMeta",
			strip: "tkl_strip",
			stripGrid: "tkl_stripGrid",
			cell: "tkl_cell",
			cellPad: "tkl_cellPad",
			legend: "tkl_legend",
			legendSwatch: "tkl_legendSwatch",
			table: "tkl_table",
			hit: "tkl_hit",
			sortMark: "tkl_sortMark",
			balance: "tkl_balance",
			balanceAmount: "tkl_balanceAmount",
			balanceMeta: "tkl_balanceMeta",
			footer: "tkl_footer",
			warn: "tkl_warn",
			skel: "tkl_skel",
			skelStat: "tkl_skelStat"
		};
		//#endregion

		//#region data

		/** The ranges the header offers, mirroring the command's day argument. */
		const RANGES = [
			{ id: "1", days: 1 },
			{ id: "7", days: 7 },
			{ id: "30", days: 30 },
			{ id: "all", days: undefined }
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
		function useBalance(open, nonce) {
			const [state, setState] = react.useState({ status: "idle" });

			react.useEffect(() => {
				if (!open) return undefined;
				const controller = new AbortController();
				setState({ status: "loading" });
				fetchJson(BALANCE_PATH, controller.signal).then(
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
			}, [open, nonce]);

			return state;
		}
		//#endregion

		//#region view

		function RangeTabs({ value, onChange, translate }) {
			return jsx("div", {
				className: S.ranges,
				children: RANGES.map((range) =>
					jsx(
						"button",
						{
							type: "button",
							className: S.range,
							...(range.id === value ? { "data-on": "" } : {}),
							onClick: () => onChange(range.id),
							children: translate(`range.${range.id}`)
						},
						range.id
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

		/** Three flat cards. Cost is an em dash when unpriced — never a zero. */
		function StatRow({ data, translate }) {
			const totals = data.totals ?? {};
			const currencies = Object.entries(data.priced?.totals ?? {});
			const cost = currencies.length === 0 ? "—" : currencies.map(([c, v]) => fmtMoney(v, c)).join(" + ");
			const cards = [
				{ value: fmt(totals.tokens), label: translate("stat.tokens") },
				{ value: fmt(totals.requests), label: translate("stat.requests") },
				{ value: cost, label: translate("stat.cost") }
			];
			return jsx("div", {
				className: S.stats,
				children: cards.map((card, i) =>
					jsxs(
						"div",
						{
							className: S.stat,
							children: [
								jsx("div", { className: S.statValue, children: card.value }),
								jsx("div", { className: S.statLabel, children: card.label })
							]
						},
						i
					)
				)
			});
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
			const max = Math.max(...rows.map((r) => r.tokens ?? 0), 1);
			const byId = new Map((data.directory ?? []).map((d) => [d.id, d]));

			return jsx("div", {
				className: S.rows,
				children: rows.map((row) => {
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
								jsx("span", { className: S.rowName, children: label }),
								jsx("span", {
									className: S.rowBarTrack,
									children: jsx("span", {
										className: S.rowBar,
										style: { width: `${Math.max(2, share(row.tokens, max))}%` }
									})
								}),
								jsx("span", { className: S.rowValue, children: fmt(row.tokens) })
							]
						},
						id
					);
				})
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
			const days = data.days ?? [];
			if (days.length === 0) return jsx("p", { className: S.note, children: translate("activity.none") });

			const byDay = new Map(days.map((d) => [d.day, d.tokens ?? 0]));
			const max = Math.max(...byDay.values(), 1);
			const last = new Date(`${days[days.length - 1].day}T00:00:00`);
			const first = new Date(`${days[0].day}T00:00:00`);

			// Pad to whole weeks so columns line up on a weekday, Monday first.
			const cells = [];
			const startPad = (first.getDay() + 6) % 7;
			for (let i = 0; i < startPad; i++) cells.push(null);
			for (let t = first.getTime(); t <= last.getTime(); t += 86_400_000) {
				const key = localDayKey(new Date(t));
				cells.push({ day: key, tokens: byDay.get(key) ?? 0 });
			}

			return jsxs("div", {
				children: [
					jsx("div", {
						className: S.strip,
						children: jsx("div", {
							className: S.stripGrid,
							children: cells.map((cell, i) =>
								cell === null
									? jsx("span", { className: S.cellPad }, `p${i}`)
									: jsx(
											"span",
											{
												className: S.cell,
												"data-l": String(levelOf(cell.tokens, max)),
												title: `${cell.day} · ${fmt(cell.tokens)}`
											},
											cell.day
										)
							)
						})
					}),
					jsxs("div", {
						className: S.legend,
						children: [
							jsx("span", { children: translate("activity.less") }),
							[0, 1, 2, 3, 4].map((level) =>
								jsx(
									"span",
									{
										className: S.legendSwatch,
										style: { background: `var(--tkl-level-${level})` }
									},
									level
								)
							),
							jsx("span", { children: translate("activity.more") })
						]
					})
				]
			});
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

		/** Five steps, and only a genuinely idle day is level zero. */
		function levelOf(tokens, max) {
			if (!(tokens > 0)) return 0;
			const ratio = tokens / max;
			if (ratio > 0.75) return 4;
			if (ratio > 0.5) return 3;
			if (ratio > 0.25) return 2;
			return 1;
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
											children: [fmt(m.cacheReadTokens), jsx("span", { className: S.hit, children: fmtHit(m.cacheHitRate) })]
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
		function BalanceCard({ state, translate }) {
			if (state.status === "loading") return jsx("div", { className: `${S.skel} ${S.skelStat}` });
			if (state.status !== "ready") return null;
			const balance = state.data;
			if (balance.supported === false) {
				return jsx("p", { className: S.note, children: translate(`balance.${balance.reason === "no-official-route" ? "noRoute" : "unavailable"}`) });
			}
			if (balance.fetched !== true) {
				return jsx("p", {
					className: S.note,
					children: translate(balance.reason === "no-credential" ? "balance.noKey" : "balance.failed")
				});
			}
			const amount = Number.parseFloat(balance.total);
			return jsxs("div", {
				className: S.balance,
				children: [
					jsx("span", {
						className: S.balanceAmount,
						children: Number.isFinite(amount) ? fmtMoney(amount, balance.currency) : "—"
					}),
					jsx("span", {
						className: S.balanceMeta,
						children: balance.isAvailable === true ? translate("balance.active") : translate("balance.inactive")
					})
				]
			});
		}

		/** Index health. A stale or lossy index must say so on the page. */
		function Footer({ data, translate }) {
			const d = data.diagnostics ?? {};
			const updated = typeof d.lastUpdatedAt === "number" ? new Date(d.lastUpdatedAt).toLocaleString() : "—";
			return jsxs("div", {
				className: S.footer,
				children: [
					translate("footer.updated", { at: updated }),
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
		function Body({ state, balance, site, onSelect, translate, onRetry }) {
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
					jsx(Section, { title: translate("section.balance"), children: jsx(BalanceCard, { state: balance, translate }) }),
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
						children: empty
							? jsx("p", { className: S.note, children: translate("state.empty") })
							: jsx(StatRow, { data, translate })
					}),
					jsx(Section, {
						title: translate("section.sites"),
						children: jsx(SiteRows, { data, site, onSelect, translate })
					}),
					empty ? null : jsx(Section, { title: translate("section.activity"), children: jsx(ActivityStrip, { data, translate }) }),
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
			const [range, setRange] = react.useState("30");
			const [site, setSite] = react.useState(undefined);
			const [nonce, setNonce] = react.useState(0);
			const days = RANGES.find((r) => r.id === range)?.days;
			const state = useUsage(open, days, site, nonce);
			const balance = useBalance(open, nonce);
			const reload = () => setNonce((n) => n + 1);
			const translate = translateWith(t);

			// Escape closes, and only while open: a global listener that outlives
			// the panel would swallow the key from whatever owns it next.
			react.useEffect(() => {
				if (!open) return undefined;
				const onKey = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open]);

			const busy = state.status === "loading";
			const totalLabel = state.data === undefined ? "" : fmt(state.data.totals?.tokens);

			return jsxs("div", {
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
												jsx(RangeTabs, { value: range, onChange: setRange, translate }),
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
									children: jsx(Body, { state, balance, site, onSelect: setSite, translate, onRetry: reload })
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
			"range.1": "今日",
			"range.7": "7 天",
			"range.30": "30 天",
			"range.all": "全部",
			"action.refresh": "刷新",
			"action.close": "关闭",
			"action.retry": "重试",
			"state.loading": "读取中…",
			"state.empty": "这个区间内没有记录到任何用量。",
			"error.load": "读不到用量数据。",
			"section.balance": "官方余额",
			"section.usage": "用量",
			"section.sites": "中转站分布",
			"section.activity": "活跃度",
			"section.models": "模型",
			"filter.clear": "只看 {site} ×",
			"stat.tokens": "tokens",
			"stat.requests": "请求",
			"stat.cost": "估算费用",
			"sites.direct": "直连/官方",
			"sites.none": "没有发现中转站——直连的话这就是全部。",
			"activity.none": "这个区间内没有活跃记录。",
			"activity.less": "少",
			"activity.more": "多",
			"table.model": "模型",
			"table.requests": "请求",
			"table.input": "输入",
			"table.cache": "缓存",
			"table.output": "输出",
			"table.cost": "估算",
			"table.none": "没有模型记录。",
			"balance.active": "账户可用",
			"balance.inactive": "账户不可用",
			"balance.noKey": "这条官方路由没有配置密钥，查不了余额。",
			"balance.noRoute": "没有直连官方的路由——中转站没有余额接口。",
			"balance.failed": "余额读取失败。",
			"balance.unavailable": "这个部署问不到 provider 配置。",
			"footer.updated": "索引更新于 {at}",
			"footer.unattributed": "{n} 行归因不上"
		};
		const en = {
			"panel.title": "Token Ledger",
			"range.1": "Today",
			"range.7": "7d",
			"range.30": "30d",
			"range.all": "All",
			"action.refresh": "Refresh",
			"action.close": "Close",
			"action.retry": "Retry",
			"state.loading": "Loading…",
			"state.empty": "No usage recorded in this range.",
			"error.load": "Could not read usage data.",
			"section.balance": "Official balance",
			"section.usage": "Usage",
			"section.sites": "By relay site",
			"section.activity": "Activity",
			"section.models": "Models",
			"filter.clear": "{site} only ×",
			"stat.tokens": "tokens",
			"stat.requests": "requests",
			"stat.cost": "est. cost",
			"sites.direct": "Direct",
			"sites.none": "No relay sites found — if you go direct, this is all of it.",
			"activity.none": "No activity in this range.",
			"activity.less": "Less",
			"activity.more": "More",
			"table.model": "Model",
			"table.requests": "Req",
			"table.input": "Input",
			"table.cache": "Cache",
			"table.output": "Output",
			"table.cost": "Est.",
			"table.none": "No model records.",
			"balance.active": "Account active",
			"balance.inactive": "Account inactive",
			"balance.noKey": "That official route has no key configured.",
			"balance.noRoute": "No direct official route — relays have no balance API.",
			"balance.failed": "Could not read the balance.",
			"balance.unavailable": "This deployment exposes no provider directory.",
			"footer.updated": "Index updated {at}",
			"footer.unattributed": "{n} rows unattributed"
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
		exports.RangeTabs = RangeTabs;
		exports.Body = Body;
		exports.StatRow = StatRow;
		exports.SiteRows = SiteRows;
		exports.ActivityStrip = ActivityStrip;
		exports.ModelTable = ModelTable;
		exports.BalanceCard = BalanceCard;
		exports.Footer = Footer;
		exports.translateWith = translateWith;
		exports.buildQuery = buildQuery;
		exports.levelOf = levelOf;
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
