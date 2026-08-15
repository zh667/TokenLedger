# Web UI plan

Rewritten 2026-08-15 after the repository owner's four decisions. Research is
complete — nothing here is blocked on an unknown. Implementation is starting.

## Decisions

1. **Style follows DSH itself**, not New API. A plugin that looks like a
   different product inside the harness reads as foreign.
2. **Balance: DeepSeek official only** for now.
3. **No month calendar heatmap.** A compact GitHub-style strip instead, the
   shape UsagePlane uses.
4. Layout still referenced from `dsh-usage-stats`; the feature comparison lives
   in [`COMPARISON.md`](COMPARISON.md).

## What DSH actually looks like

Read from `@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css` and
the shipped `ui-*` bundles, not from screenshots:

- **Achromatic.** `--dsw-alias-brand-primary` resolves to
  `--dsw-static-neutral-bluish-1000` in light and `-50` in dark. There is no
  chromatic brand colour. Colour is reserved for state: `state-success-primary`,
  `state-error-primary`, `state-warn-primary`.
- **Depth comes from borders, not fills.** In light mode `bg-layer-1` and
  `bg-layer-2` are both neutral-00 — the same white. Borders are alpha overlays
  (`rgba(0,0,0,0.04)` / `0.1`), so they compose over any surface. Dark lifts
  slightly: 875 → 850.
- **Radii** in the shipped bundles: 12px (panels, cards), 8px (buttons, cells),
  6px (small controls), 999px (pills).
- **Type scale** is tight: 12px and 13px carry almost everything, 14px for
  emphasis, 11px for captions, 16–18px for headings. System font stack with
  PingFang SC.
- **No gradients anywhere.**

This is the opposite of New API's look — toned gradient stat cards, an OKLCH
accent palette, `--radius: 0.5rem`. Following it would have produced exactly the
foreign-looking panel decision 1 rules out. New API is no longer a reference for
this work; that also removes the AGPL-vs-MIT hazard of borrowing from it.

The one deliberate exception to achromatic: the activity strip stays green.
Green-for-activity is a read-at-a-glance convention, and it is data rather than
chrome.

## The heatmap, and a licensing note

UsagePlane's is GitHub-style: 12px cells, 3px gaps, weeks as columns, month and
weekday labels, a five-step legend, scrolled to the newest date. Compact because
it is a strip, not a month grid — one row of weeks instead of a whole viewport.

**UsagePlane is AGPL-3.0; this repository is MIT.** Its source is not copied.
The layout is ~50 lines of grid arithmetic and is reimplemented here. The
five-step green scale is Tailwind's emerald ramp (MIT) over GitHub's neutral
level-0, which is where UsagePlane took it from as well.

## The host route — resolved

This was the plan's only unknown. `dsh-usage-stats` answers it:

```js
ctx.effect(() => ctx.webServer.register({
  kind: "exact",
  path: "/api/usage-stats/usage",
  handler: (req, res) => ...          // plain Node http req/res
}), "label")
```

`webServer` is an injectable service. Exact routes win over the RPC prefix,
which means they **bypass the RPC trust boundary**, so the handler owns its own
fence. The pattern to copy, and the reasoning behind it:

- refuse anything that is not `GET`;
- check the **peer socket address** (`req.socket.remoteAddress`) for loopback —
  primary, because it is not client-controllable;
- check the `Host` header for loopback as well, as a second condition, never as
  the only one.

We reach it through `ctx.get("webServer")` rather than `inject`, keeping the
collector alive on a composition with no web server — the same optional-service
idiom already used for `commands`, `settings` and `llm`.

## Layout

Seat: `sidebar.footer.action` badge → `shell.overlay` panel. Panel, top to
bottom:

1. **Header** — title, range selector (今日 / 7 天 / 30 天 / 全部), refresh, close.
   The range drives everything below.
2. **Balance** — DeepSeek official only: `GET {baseURL}/user/balance`, the CNY
   entry of `balance_infos`. A provider with no balance API says so plainly
   rather than rendering an empty card.
3. **Stat row** — total tokens, requests, estimated cost. Flat cards, border-
   defined, no gradient. Unpriced shows an em dash, never zero.
4. **Site breakdown** — the differentiator, above the fold. One row per relay:
   domain, tokens, share bar, requests. Selecting one filters the panel.
   `direct` is a row like any other.
5. **Activity strip** — the compact heatmap, one cell per day.
6. **Model table** — model, requests, input, cache + hit rate, output, cost.
   Same columns as the text report, so the two cannot disagree.
7. **Footer** — index freshness and unattributed-row count, from `diagnostics`.

Every figure comes from the existing `ctx.tokenLedger` queries. No new
aggregation, so the page and `/tokenledger` cannot drift.

## Batches

Ordered by dependency; everything inside a batch is independent and can be
written in parallel.

**Batch A — foundation.** Two halves that only meet at the end:

- **A1 (Node)** — `webServer` route serving the existing queries as JSON, with
  the loopback fence. Testable with `curl`, needs no browser.
- **A2 (browser)** — `tsdown` build, `dsh.client` manifest, footer badge, empty
  panel with header and close, the CSS base and token layer. Needs no data.

Done when the badge opens a correctly themed empty panel and `curl` returns real
rollups.

**Batch B — the panel content.** Six independent components over one payload:

- B1 range selector + stat row
- B2 site breakdown
- B3 model table
- B4 activity strip
- B5 footer diagnostics
- B6 DeepSeek balance card

Acceptance for the whole batch: **every figure matches `/tokenledger` for the
same range.** That equality is the only cheap guard a browser half gets, checked
against the real install that has both a direct provider and a relay.

**Batch C — interaction.** Site-row selection filtering the panel; sortable
model table. Needs B2 and B3. This is what justifies a UI over a command.

**Batch D — polish.** Skeletons, empty and error states, i18n (zh source + en),
and an unreachable host half degrading to a message rather than a blank panel.

## Not planned

Subscription quota windows, and balance for vendors other than DeepSeek.
`dsh-usage-stats` covers both; a worse copy of something already installed is
not worth the code.

## Cost, restated

~6 `@deepseek-ai/dsh-client-*` peers plus React 18, a bundling step where today
there is none, and a surface that starts with zero test coverage against 184 on
the Node side. Batch B's equality check is the mitigation.
