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

## Execution plan: three independent tracks

The remaining work is not a chain. Sequencing it as one would idle two thirds
of it behind the slowest link, so it runs as three tracks that share nothing
but the bucket shape already fixed in Phase 0.

```text
Track A — persistence          Track B — pricing           Track C — adapters
 SQLite rollups                 rate table                  normalized billing fact
 checkpoints                    peak/off-peak windows       New API (key + PAT)
 session discovery              cost estimation             Sub2API
 full rebuild                   per-site overrides          fixtures
 diagnostics
        │                              │                            │
        └──────────────┬───────────────┴────────────────┬───────────┘
                       ▼                                ▼
              Track D — reconciliation           Track E — plugin + UI
               evidence levels                    dsh.bundle manifest
               difference reporting               usage page
               (needs B's cost + C's shape)       reconciliation page
                                                  (needs A)
```

Why they are genuinely independent:

- **B needs nothing.** Cost is a pure function of the buckets Phase 0 already
  produces. No I/O, no DSH, no database. Testable the moment it is written.
- **C needs nothing.** Each adapter is an HTTP client returning a normalized
  billing fact. It talks to a relay, never to DSH or to the store.
- **A needs a DSH install to exercise end to end, but not to build.** The
  schema, checkpoint logic, and rebuild path are testable against synthetic
  event logs.
- **D can start as soon as C's output *shape* is agreed**, which is a
  five-minute decision, not a dependency on finished adapters. The DSH side it
  compares against — `bySite()` — already exists.
- **E is the only true tail.** It needs A working to have anything to show.

Consequence for ordering: A, B, and C run together. D follows the shape
agreement, not the adapters. E is last, and is also the listing gate below.

## Ecosystem listing gate

**Do not submit to the curated indexes until Track E ships a real plugin.**
Verified 2026-08-14 against each index's contributing rules.

| Index | ★ | Mechanism | Requirement |
|---|---|---|---|
| `AdamPlatin123/awesome-dsh-plugins` | 623 | **Automatic** — scans the `dsh-plugin` topic | None. The topic is already set; pickup is free. |
| `awesome-dsh-plugin/awesome-dsh-plugin` | 483 | Pull request | `package.json` must declare a **`dsh.bundle`** manifest (`dsh.client` alone is rejected) **and** a `cordis.patch.yml` must exist. "Placeholder, name-squat, or README-only repos don't qualify." Actively maintained; inactive entries are pruned. |
| `0xsline/awesome-deepseek-harness` | 289 | Pull request | A real ecosystem repository, no dead links or placeholders. One factual line, no marketing. |
| `bruc3van/awesome-dsh-plugin` | 54 | Pull request | Explains what the plugin solves and for whom. |

Submission mechanics for the PR-based ones: fork, add one line under the
matching category to **both** the English and Chinese README, open a PR titled
`docs: add zh667/TokenLedger`. The line:

```markdown
- [zh667/TokenLedger](https://github.com/zh667/TokenLedger) - DSH token usage accounting reconciled against New API and Sub2API relay-site billing.
```

Timing: these indexes review by hand. As of 2026-08-14 they carry 22 and 17
open issues respectively — still tractable. The ecosystem is 48 hours old and
adding dozens of repositories a day, so the review queue will lengthen fast.
Submit the day Track E clears the bar, not before and not much after.

**This gate is a checklist item, not a background task.** Whoever finishes
Track E is responsible for opening the four submissions in the same session.

## Track A — persistence

Storage uses Node's built-in `node:sqlite` (`DatabaseSync`), verified working
on Node 22.23.1. It keeps the package at zero runtime dependencies.

- [ ] SQLite rollup schema keyed by `(day, site, provider, model)`.
- [ ] Checkpoint store: `(sessionId → consumedSeq, logRevision)`.
- [ ] Session discovery via `listSnapshots()` revisions; incremental
      `readFrom(id, consumedSeq + 1)`.
- [ ] Full-rebuild path: `readFrom(id, 0)` over every session, tested as a
      first-class operation rather than a recovery-only one.
- [ ] CSV/JSON export.
- [ ] Reindex, integrity, lag, and missing-usage diagnostics.

Acceptance: a synthetic session that switches models mid-run, has one
failed-but-billed request, and is interrupted and resumed produces totals
matching a hand-computed expectation — before and after a full reindex, and
byte-identical between an incremental fold and a from-scratch fold.

## Track B — pricing and cost

Pure functions over the buckets Phase 0 already produces. No I/O.

- [ ] Rate table with explicit effective dates and currency.
- [ ] DeepSeek official peak/off-peak windows, expressed as a timezone-anchored
      schedule rather than a hardcoded offset.
- [ ] Separate rates per bucket: uncached input, cache read, cache write,
      output.
- [ ] Per-site rate overrides — a relay sets its own prices and is the whole
      reason a local estimate and a site's charge can legitimately differ.
- [ ] Estimated cost stored beside the tokens that produced it, never
      recomputed retroactively at a changed rate.
- [ ] An unpriced model yields an explicit "no rate" result, never zero.

Acceptance: repricing the same day's tokens under two rate tables yields two
stored estimates that both survive, and neither rewrites the other.

## Track C — relay billing adapters

Standalone, no DSH dependency, so UsagePlane and other agents can consume them.
Endpoints below were read from New API's router source, not its docs.

New API — reachable with only an **API key** (`TokenAuthReadOnly`):

- [ ] `GET /api/usage/token/` — granted, used, remaining quota. `summary`.
- [ ] `GET /api/log/token` — that key's own request log. Potentially
      `request`-level, which is better than the previously assumed
      summary-only ceiling for key-based access.

New API — reachable with a **user session/PAT** (`UserAuth`):

- [ ] `GET /api/log/self` and `/api/log/self/search` — account-wide request log.
- [ ] `GET /api/log/self/stat` — aggregated statistics.
- [ ] `GET /api/data/self` — quota time series. `aggregate`.
- [ ] `GET /api/user/self` — balance and quota.

Sub2API:

- [ ] `GET /v1/usage` with an API key — key-scoped totals, model statistics,
      actual cost, subscription counters, wallet balance.
- [ ] `/api/v1/usage` authenticated user adapter, if request-level logs are
      needed and the deployment exposes them.

Cross-cutting:

- [ ] Recorded fixtures so every adapter is testable without a live account.
- [ ] Credentials in an OS-protected or existing DSH credential store. Always
      an `Authorization` header, never a query string — `?key=...` leaks into
      browser history, reverse-proxy logs, and diagnostics.
- [ ] Every adapter reports which evidence level its data can support, rather
      than the caller assuming.

## Track D — reconciliation

Starts once Track C's normalized fact shape is agreed; does not wait for
finished adapters. The DSH side it compares against, `bySite()`, already exists.

- [ ] Normalized billing fact: site, window, model?, tokens?, cost?, currency?,
      quota?, balance?, evidence level, fetched-at.
- [ ] Comparison emitting `request | aggregate | summary` and never claiming a
      level its inputs cannot support.
- [ ] Keep estimated cost, reported cost, quota, wallet balance, and currency
      as five separate facts; never silently add or convert.
- [ ] Report the difference, its direction, and the freshness of both sides.

Acceptance: two sites serving the same model each produce that site's DSH
totals beside the site's own reported figures, with an honestly labelled
evidence level and a stated difference.

## Track E — plugin surface and listing

The tail, and the gate for the ecosystem submissions recorded above.

- [ ] Cordis plugin registering the collector on the session event seam.
- [ ] `dsh.bundle` manifest in `package.json` and a `cordis.patch.yml` — both
      are hard requirements of the largest curated index.
- [ ] Web UI page: model-first usage, relay-site filter, date ranges.
- [ ] Separate site-centric reconciliation page: exact domain, site type, data
      freshness, balance, reported cost, local estimate, difference, level.
- [ ] Publish to npm.
- [ ] **Open the four index submissions in the same session** — see the
      ecosystem listing gate above.

## Later — beyond DSH (conditional)

Reconciliation has nothing to do with which agent spent the tokens; it depends
only on where the tokens were bought. Only pursue once A–E are solid.

- [ ] Extract the relay adapters as their own published package.
- [ ] Pluggable usage sources so Claude Code, Codex, or OpenCode logs can feed
      the same reconciliation engine.
