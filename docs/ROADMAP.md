# TokenLedger Roadmap

Updated: 2026-08-14

## Product definition

> **TokenLedger measures DeepSeek Harness token usage with relay-site
> attribution, and reconciles it against New API and Sub2API billing data.**

Usage accounting is the base; reconciliation is the product. Neither half works
alone — a relay adapter with nothing to compare against reports the site's own
numbers back to you, and a usage dashboard without site attribution can never
answer "was I charged correctly".

## Why this and not something else

Surveyed 2026-08-14 across the `dsh-plugin` GitHub topic (1335 repositories,
845 sampled) and `AdamPlatin123/awesome-dsh-plugins` (288 indexed).

The DSH ecosystem is roughly 48 hours old — DSH itself went public
2026-08-13 11:56 UTC. Almost everything built so far is what one person can
ship in a day: skins (43), live token HUDs and balance readouts (59), desktop
shells (59), prompt/skill packs (109). Counting repositories on day two
measures speed, not settlement.

What matters is which gaps DeepSeek will close themselves:

| Gap | DSH native | Verdict |
|---|---|---|
| Declarative hooks | none | DeepSeek will ship it — CC has it |
| Checkpoints / rewind | none | DeepSeek will ship it — CC has it |
| ACP (editor-driven agent) | none | DeepSeek will ship it |
| Git worktree isolation | none | DeepSeek will ship it |
| OTel / observability | none | Real gap, thin demand, all community repos ≤2★ |
| **Relay-site billing reconciliation** | none | **DeepSeek will never ship it** |

The last row is the only structurally durable one. Reconciliation exists to
audit third-party resellers of DeepSeek API access — checking whether a relay
overcharged you. That is against the vendor's own commercial interest, and it
would require DeepSeek to implement adapters for competing gateways. Zero of
845 repositories do it, and that is not a timing accident: it is the position
nobody upstream is willing to occupy.

## Scope

### In scope

- Per-day, per-`(site, provider, model)` token accounting from DSH session logs.
- Read-only New API and Sub2API billing adapters.
- Side-by-side comparison with an explicit reconciliation evidence level.
- Cost estimation kept separate from site-reported charges.
- A DSH plugin surfacing all of it in the Web UI.

### Out of scope

- Another live token HUD, TPS meter, or context-occupancy widget. Solved 30×.
- Skins, pets, sidebars, desktop shells.
- Re-implementing what `@deepseek-ai/dsh-token-meter` already computes.
- Writing to relay sites. Every adapter is read-only.
- Claiming `request`-level reconciliation when only aggregates exist.
- Cross-device or cross-agent aggregation — that is UsagePlane's scope.
  TokenLedger stays single-machine and DSH-side, and its `relay-billing`
  adapters are written so UsagePlane can consume them rather than fork them.

## DSH event contract

Verified against the published type declarations of `@deepseek-ai/dsh-llm`,
`dsh-session`, `dsh-session-persistence`, and `dsh-token-meter` at
`dsh@0.1.0-rc.6`.

```ts
SessionEvent = { type, seq, time, data }        // seq monotonic, time epoch ms

'assistant/message': { turn, step, message: AssistantMessage, usage?: TokenUsage }
'assistant/chunk':   { turn, step, chunk: StreamChunk }
StreamChunk usage variant: { type: 'usage', usage: TokenUsage }

AssistantMessage.source: ModelMessageSource extends AssistantProvenance
AssistantProvenance = { provider: string, model: string, replayState?: unknown }

TokenUsage = { inputTokens, outputTokens,
               cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }
```

Load-bearing consequences, all covered by `test/usage.test.js`:

- **Both sources must be read.** A request that reported usage and then failed
  produces a usage chunk and no `assistant/message`. It was billed.
- **Same `(turn, step)` replaces, never sums** — and the replacement must be
  unwound from the exact day and route the earlier sample was attributed to.
- **`assistant/message` carries its own route; a usage chunk carries none.**
  Orphan chunks fall back to the newest `request/header`
  (`data.header.config`), whose `reason` may be `'initial' | 'resume' |
  'change'` — a `'resume'` restates the route, it is not a model switch.
- **Buckets are disjoint.** `inputTokens` already excludes cache reads/writes.
  `reasoningTokens` is inside `outputTokens`; display it, never add it.
- **Idempotency key is `sessionId + seq`.**
- **Read seam** is `sessionPersistence.readFrom(id, fromSeq)`, documented
  upstream as "intended for checkpoint consumers"; discover changed logs via
  `listSnapshots()` opaque revisions.

Upstream is a developer preview (`dsh` `0.1.0-rc.6`, subpackages `0.0.1-rc.1`).
Every shape assumption lives in the fold module with fixture tests, so a
breaking change fails in one place.

## Storage

The DSH session log is the authoritative append-only fact. TokenLedger does not
copy it. Two layers only:

| Layer | Role |
|---|---|
| DSH session logs | Authoritative, owned by DSH |
| `(sessionId → consumedSeq)` checkpoints + SQLite rollups | Disposable, rebuildable |

A full rebuild is `readFrom(id, 0)` over every session and must be a tested,
user-triggerable operation. Checkpoints advance only after the rollup write
commits. Index failures never block a DSH turn, startup, or shutdown.
Diagnostics expose counts, lag, and failures — never prompts, tool arguments,
API keys, or response content.

## Phase 0 — usage core ✅

- [x] Dual-source usage fold with `(turn, step)` replacement.
- [x] Route attribution: `message.source` primary, `request/header` fallback,
      explicit `unknown`.
- [x] Relay-site dimension resolved at fold time, history never rewritten.
- [x] Disjoint billed totals; reasoning tracked but excluded.
- [x] Incremental fold with `consumedSeq` checkpoints across slice boundaries.
- [x] Site registry with origin normalization and credential fingerprints.
- [x] Range / by-model / by-site queries.
- [x] 16 tests, no runtime dependencies.

## Phase 1 — persistence and cost (`v0.1`)

- [ ] SQLite rollup schema keyed by `(day, site, provider, model)`.
- [ ] Checkpoint store and tested full-rebuild path.
- [ ] Session discovery via `listSnapshots()` revisions; incremental
      `readFrom(id, consumedSeq + 1)`.
- [ ] Official DeepSeek pricing table with peak/off-peak periods and an
      explicit rate-effective date.
- [ ] Per-site pricing overrides, since relays set their own rates.
- [ ] Estimated cost stored beside the tokens that produced it, never
      recomputed retroactively at a changed rate.
- [ ] CSV/JSON export.

Acceptance: a synthetic session that switches models mid-run, has one
failed-but-billed request, and is interrupted and resumed produces totals
matching a hand-computed expectation — before and after a full reindex.

## Phase 2 — relay billing adapters (`v0.2`)

Written as a standalone module with no DSH dependency, so UsagePlane and other
agents can consume it.

- [ ] New API PAT mode: authenticated self-log/stat APIs for time, model,
      prompt/completion tokens, and quota.
- [ ] New API API-key summary mode: `GET /api/usage/token` for granted, used,
      and remaining quota. Summary-only.
- [ ] Sub2API API-key mode: `GET /v1/usage` for key-scoped totals, model
      statistics, actual cost, subscription counters, or wallet balance.
- [ ] Recorded fixtures so the adapters are testable without a live account.
- [ ] Credentials in an OS-protected or existing DSH credential store. Never in
      a URL, SQLite row, log line, or diagnostic report — no
      `/api/log/token?key=...`.
- [ ] Reconciliation engine emitting `request | aggregate | summary`.
- [ ] Keep estimated cost, reported cost, quota, wallet balance, and currency
      as five separate facts; never silently add or convert.

Acceptance: two sites serving the same model each produce that site's DSH
totals beside the site's own reported figures, with an honestly labelled
evidence level and a stated difference.

## Phase 3 — DSH plugin surface (`v0.3`)

- [ ] Cordis plugin registering the collector on the session event seam.
- [ ] Web UI page: model-first usage, relay-site filter, date ranges.
- [ ] Separate site-centric reconciliation page: exact domain, site type, data
      freshness, balance, reported cost, local estimate, difference, level.
- [ ] Reindex, integrity, lag, and missing-usage diagnostics.
- [ ] Publish to npm under the `dsh-plugin` topic.

## Phase 4 — beyond DSH (`v0.4`, conditional)

Reconciliation has nothing to do with which agent spent the tokens — it depends
only on where the tokens were bought. Only pursue this once Phases 1–3 are
solid.

- [ ] Extract the relay adapters as their own published package.
- [ ] Pluggable usage sources so Claude Code, Codex, or OpenCode logs can feed
      the same reconciliation engine.

## Immediate implementation order

1. SQLite rollup schema and the checkpoint store.
2. Session discovery + incremental read against a real `$DSH_HOME`.
3. Full-rebuild test: fold twice, assert identical totals.
4. Pricing table and cost estimation.
5. New API PAT adapter against recorded fixtures.
6. Sub2API `/v1/usage` adapter against recorded fixtures.
7. Reconciliation engine and its evidence levels.
8. Only then the plugin wrapper and UI.
