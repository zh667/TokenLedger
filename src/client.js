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

window.__ModuleLoader__.load({
	id: "dsh-tokenledger",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const NS = "tokenLedger";
		const USAGE_PATH = "/api/tokenledger/usage";

		//#region style
		//
		// Injected once as a single tag. Every colour is a DSH token so the panel
		// follows whatever theme the user runs; the handful of `--tkl-*` values
		// are for what DSH has no token for, and are defined on the panel itself
		// so they cannot leak into the host.
		const css = [
			// -- the seat, beside the settings gear -------------------------------
			".tkl_layer{flex:none;align-items:center;width:100%;height:49px;margin:8px 0 0;display:flex;position:relative}",
			".tkl_badge{width:100%;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden}",
			".tkl_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".tkl_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}",
			".tkl_badgeIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px}",
			".tkl_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}",
			".tkl_badgeValue{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px}",
			// Collapsed sidebar: the shell narrows to a 56px rail and every control
			// becomes a 36px circle. Without this the badge keeps its full width and
			// spills out of the rail.
			".tkl_layer.tkl_rail{width:36px;height:36px;margin:0}",
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
			".tkl_range[data-on]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}"
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
			range: "tkl_range"
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

		async function fetchUsage(days, signal) {
			const query = days === undefined ? "" : `?days=${days}`;
			const response = await fetch(USAGE_PATH + query, {
				headers: { accept: "application/json" },
				signal
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				throw new Error("unexpected response");
			}
			return payload;
		}

		/**
		 * Load the payload for a range, cancelling whatever is in flight.
		 *
		 * A stale response must never paint over a newer one: switching ranges
		 * quickly is the normal way to use this panel, and without the abort the
		 * slower of two requests wins whenever it happens to land last.
		 */
		function useUsage(open, days) {
			const [state, setState] = react.useState({ status: "idle" });
			const [nonce, setNonce] = react.useState(0);

			react.useEffect(() => {
				if (!open) return undefined;
				const controller = new AbortController();
				setState((prev) => ({ status: "loading", data: prev.data }));
				fetchUsage(days, controller.signal).then(
					(data) => {
						if (!controller.signal.aborted) setState({ status: "ready", data });
					},
					(error) => {
						if (controller.signal.aborted) return;
						setState({ status: "error", message: error?.message ?? String(error) });
					}
				);
				return () => controller.abort();
			}, [open, days, nonce]);

			return [state, () => setNonce((n) => n + 1)];
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

		/**
		 * The panel body.
		 *
		 * Batch A ships the shell: loading, error, and a placeholder. The sections
		 * that read the payload land in Batch B, each one independent of the
		 * others, which is why they are not stubbed here.
		 */
		function Body({ state, translate, onRetry }) {
			if (state.status === "error") {
				return jsxs("div", {
					children: [
						jsx("p", { className: S.error, children: translate("error.load") }),
						jsx("p", { className: S.note, children: state.message }),
						jsx("button", { type: "button", className: S.retry, onClick: onRetry, children: translate("action.retry") })
					]
				});
			}
			if (state.data === undefined) {
				return jsx("p", { className: S.note, children: translate("state.loading") });
			}
			const total = state.data.totals?.tokens;
			return jsx("p", {
				className: S.note,
				children: translate("state.placeholder", { tokens: fmt(total) })
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
			const days = RANGES.find((r) => r.id === range)?.days;
			const [state, reload] = useUsage(open, days);
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
									children: jsx(Body, { state, translate, onRetry: reload })
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
			"state.placeholder": "共 {tokens} tokens。",
			"error.load": "读不到用量数据。"
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
			"state.placeholder": "{tokens} tokens in total.",
			"error.load": "Could not read usage data."
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
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "tokenledger: dictionaries");
			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "tokenledger", locale: NS, order: 20 },
					TokenLedgerPanel
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TokenLedgerPanel = TokenLedgerPanel;
		exports.RangeTabs = RangeTabs;
		exports.Body = Body;
		exports.translateWith = translateWith;
		exports.fmt = fmt;
		exports.RANGES = RANGES;
		exports.USAGE_PATH = USAGE_PATH;
		exports.zh = zh;
		exports.en = en;
		return module.exports;
	}
});
