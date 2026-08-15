# Web UI plan

Written 2026-08-15. Style reference: New API (`QuantumNous/new-api`). Layout
reference: `Ychris12138/dsh-usage-stats`. Not started — this is for review.

## The licensing constraint, first

**New API is AGPL-3.0. TokenLedger is MIT.** Copying its CSS, components, or
token files into this repository would relicense this repository, and is not
an option.

What is being taken is the *visual language* — a neutral palette, an 8px radius,
card composition, tabular numerals, the stat-card anatomy — reproduced by hand.
Its stack cannot be used anyway (see below), so there is nothing to copy even if
licensing allowed it. No file from that repository will be vendored, and the
clone stays outside this tree.

## What can actually be built

A DSH client plugin is **not** a normal React app. Verified against
`@deepseek-ai/dsh-client-modules` and a working example:

- the browser half is one bundle registered through
  `window.__ModuleLoader__.load({id, factory})`, materialized lazily;
- React 18 arrives as a peer, from the host;
- there is no Tailwind, no build-time CSS pipeline, no router. `dsh-usage-stats`
  injects a single `<style data-plugin-css>` tag with hand-written, prefixed
  rules, and that is the idiom.

So new-api's shadcn/Tailwind v4/TanStack Router/VChart stack is a *reference
photograph*, not a dependency list. Everything is hand-written CSS against
DSH's own tokens.

## Design tokens

Inherit from DSH so the panel matches whatever theme the user runs:
`--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-caption`,
`--dsw-alias-border-l1` / `-l2`, `--dsw-alias-fill-l2`,
`--dsw-alias-interactive-bg-hover`.

Define our own only for what DSH has no token for, all prefixed `--tkl-`:

| Token | Role | Note |
|---|---|---|
| `--tkl-radius` | `8px` | New API's `--radius: 0.5rem` |
| `--tkl-accent` | site/series primary | must pass contrast in both themes |
| `--tkl-series-1..5` | categorical series | one per relay site |
| `--tkl-grid` | chart gridlines | derived from `border-l2` |

Every number renders with `font-variant-numeric: tabular-nums`. Non-negotiable:
columns of figures that shift width while updating are unreadable, and it is the
one typographic detail `dsh-usage-stats` got right that most plugins miss.

Both themes are defined explicitly. The panel must never inherit a transparent
background and borrow the host's.

## Layout

Seat: `sidebar.footer.action` (badge, beside the settings gear) opening a
`shell.overlay` panel. Same seats `dsh-usage-stats` uses; verified as the only
ones open to third parties, since the settings plugin-card slot is gated behind
a seven-name allowlist in `dsh-host-apiproxy`.

Panel top to bottom:

1. **Header** — title, range selector (今日 / 7 天 / 30 天 / 全部), refresh, close.
   The range drives everything below; `dsh-usage-stats` fixes three cards to
   today/month/total instead, which is why a per-site monthly figure cannot be
   read off it.
2. **Stat row** — three cards: total tokens, requests, estimated cost. New API's
   stat-card anatomy: label, large value, one line of detail, a sparkline. Cost
   shows an em dash when unpriced, never zero.
3. **Site breakdown** — *the differentiator, and therefore above the fold.* One
   row per relay site: domain, tokens, share bar, request count. Selecting a row
   filters the whole panel. `direct` is a row like any other.
4. **Trend** — stacked bars per day, one series per site, so a relay appearing
   or disappearing is visible rather than averaged away.
5. **Model table** — model, requests, input, cache (with hit rate), output,
   estimated cost. Sortable. Same columns as the text report, so the two never
   disagree.
6. **Footer** — index freshness and unattributed-row count, both already in
   `diagnostics`. A stale or lossy index must say so on the page, not only in a
   command.

Deliberately not copied from the reference layout: a month calendar heatmap.
It answers "which days were busy", which the trend already shows, and it costs
a whole viewport.

## Data path

The panel needs the host's rollups, and a third-party plugin registering its own
RPC is **the one unverified step in this plan**. `dsh-usage-stats` serves
`/api/usage-stats/usage` from its host half and fetches it same-origin from the
browser half; that is an existence proof the route exists, and the mechanism it
uses must be read before any UI work starts.

No new aggregation. Every figure comes from `ctx.tokenLedger`'s existing
queries — `totals`, `byDay`, `byModel`, `bySite`, `sites`, `diagnostics` — so
the page and `/tokenledger` cannot drift.

## Plan

**Phase 0 — the unknown, before anything else.** Read how `dsh-usage-stats`
registers its host endpoint; register one read-only JSON route returning the
same shapes the command already renders. Done when `curl` against a running DSH
returns real rollups. If this cannot be made to work, the rest does not start.

**Phase 1 — the seat.** A footer badge that opens an empty panel with header and
close, correct in both themes. Ships the bundling step this package does not yet
have (`tsdown`, matching upstream's client packages) and the `dsh.client` entry
in `package.json`. Done when it opens, closes, survives a reload, and adds
nothing to a host that mounts no UI.

**Phase 2 — read-only panel.** Stat row, site breakdown, model table, footer
diagnostics. No interactivity beyond the range selector. Done when every figure
matches `/tokenledger` for the same range — that equality is the acceptance
test, checked against the real install that has both a direct provider and a
relay.

**Phase 3 — interaction.** Site row selection filtering the panel, sortable
model table, the trend chart. This is the part that justifies a UI at all:
filtering by clicking instead of typing arguments.

**Phase 4 — polish.** Loading skeletons, empty and error states, i18n (zh + en,
zh as source), and a real check that an unreachable host half degrades to a
message rather than a blank panel.

Not planned: balance queries and subscription windows. `dsh-usage-stats` covers
both, they need per-vendor credentials, and duplicating them would be building a
worse copy of something already installed.

## Cost

The honest price of this page:

- ~6 `@deepseek-ai/dsh-client-*` peer dependencies plus React 18;
- a bundling step, where today there is none and `npm test` is the whole build;
- a surface with no test coverage — the Node half has 177 tests and the browser
  half will start at zero. Phase 2's "matches the command" check is the only
  cheap guard available, which is why it is the acceptance criterion.

Against that: `/tokenledger` already answers every question the page will. What
the page adds is clicking instead of typing, and a shape a screenshot can carry.
