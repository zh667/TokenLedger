# TokenLedger Roadmap

Updated: 2026-08-17

## Product definition

> **TokenLedger measures DeepSeek Harness token usage and attributes it to the
> relay site that served each request — with no configuration and no
> credentials.**

This replaces the definition this document carried until 2026-08-15, which read
"…and reconciles it against New API and Sub2API billing data" and called
reconciliation "the product". That was wrong in two ways, and both were found by
using the thing rather than by reasoning about it:

1. **Reconciliation needs credentials most users cannot supply.** Reading New
   API's per-request consumption log means `GET /api/log`, an *administrator*
   endpoint. A normal relay customer holds an API key, which reads a balance and
   nothing else. Realistically only a relay's own operator can run
   reconciliation against New API.
2. **The question users actually have is smaller.** "Which relays am I using and
   how many tokens went to each" needs only the origin a request was sent to. No
   billing endpoint, no key, no admin account.

So the product is the attribution, and it is free. Reconciliation stays in the
codebase as a library — see [Not doing](#not-doing-reconciliation).

## Status

| Capability | State |
|---|---|
| Usage fold from session logs (dual-source, `(turn,step)` replacement) | ✅ shipped |
| SQLite rollups, checkpoints, incremental sweep, full reindex | ✅ shipped |
| Per-day / per-model / per-provider / per-site queries, CSV+JSON export | ✅ shipped |
| Cost estimation with effective-dated rates and off-peak windows | ✅ shipped |
| Relay software fingerprinting (credential-free) | ✅ shipped |
| Relay-site attribution, auto-discovered from the host | ✅ shipped, no configuration |
| `/tokenledger` — report, `site`, `export`, `diagnostics`, `reindex` | ✅ shipped |
| Web UI — sidebar panel, site filter, activity heatmap, sortable models | ✅ shipped |
| Balances — DeepSeek, New API and Sub2API, one key each | ✅ shipped |
| Settings-page plugin card | ⛔ blocked upstream by a seven-name allowlist |
| Reconciliation engine | ✅ library only — **cut from the plan**, see below |
| npm publish, index submissions | ⬜ the owner's call |

`dsh-tokenledger@0.1.0`, one runtime dependency, 282 tests, unpublished.

Verified against a real install throughout, and against the relay's own console
line by line: three requests at 45,752 + 45,682 + 45,467 = 136,901 prompt tokens
and 428 + 58 + 207 = 693 output, matching the panel exactly.

## Proposed next roadmap (2026-08-17)

**Status: proposed, not approved** ([issue #44](https://github.com/zh667/TokenLedger/issues/44)).
This section records the gaps found in a market review; each item still needs
the repository owner's approval before it becomes implementation work. The
order is deliberate: turn the accurate local ledger into a decision tool before
adding broader platform integrations.

### Position

Representative products fall into four groups:

| Group | Representative capability | What it establishes |
|---|---|---|
| Local log readers | Session/block reports, burn rate, projected totals and limit warnings ([ccusage](https://github.com/ccusage/ccusage/blob/main/docs/guide/blocks-reports.md)) | Local-only tools can provide forecasts and warnings without intercepting traffic. |
| AI gateways | Per-project/user spend, budgets, rate limits and virtual keys ([LiteLLM](https://docs.litellm.ai/), [Portkey](https://portkey.ai/docs/product/ai-gateway/virtual-keys/budget-limits)) | Mature spend control exists, but only after the gateway owns the request path and credentials. |
| LLM observability | Session/user dimensions, cost and latency trends, errors, dashboards and alerts ([Langfuse](https://langfuse.com/docs/metrics/overview), [LangSmith](https://docs.langchain.com/langsmith/dashboards), [Helicone](https://docs.helicone.ai/features/sessions)) | The useful layer above counting is drill-down: explain where a spike came from and whether it was costly, slow or broken. |
| Provider billing | Organization/project usage and invoice-reconcilable costs ([OpenAI](https://help.openai.com/en/articles/10478918-api-usage-dashboard), [Anthropic](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)) | Provider reports are the financial source of truth, but frequently require organization/admin authority and do not unify relays. |

TokenLedger's advantage is narrower and defensible: DSH-native, local,
credential-free accounting that attributes usage to the relay origin and
project while never reading conversation content. It is already strong at
**measurement**. The gap is turning that measurement into answers to four
questions:

1. What became unusually expensive?
2. Which session, project, model or relay caused it?
3. At the current rate, when will a quota or budget be exhausted?
4. How much of the displayed cost is known rather than guessed?

### P0 — decision support without changing the product boundary

#### 1. Session drill-down

Expose the session dimension the SQLite rollups already retain:

- project → session → relay/model breakdown;
- start time, last actual usage time, request count and token buckets;
- estimated cost and pricing coverage;
- an anonymized session identifier, not prompts, titles or message text.

It is done when a user can start from a high project/day total and identify the
specific sessions responsible without reading raw logs. The query must come
from existing metadata; no content field may be opened merely to make a label.

#### 2. Time trends and period comparison

Add arbitrary date ranges and day/week/month granularity, with:

- stacked input/output/cache token trends;
- relay, project and model series;
- previous-period deltas;
- cumulative cost and peak-day links into the session view.

It is done when "why is this week higher than last week?" can be answered in
the panel rather than by exporting CSV and building a second report.

#### 3. Soft budgets, burn rate and local alerts

Support optional token and cost budgets for the whole machine and for a relay,
project or model. Show current tokens/hour and cost/hour, projected period-end
usage, and estimated exhaustion time. Warn at configurable thresholds and when
subscription windows approach exhaustion or reset.

These are **soft** budgets: local notifications and visible warnings only.
TokenLedger does not become a proxy and does not block a request. Forecasts
must say which observation window they use and must degrade to "insufficient
data" rather than inventing confidence.

#### 4. Pricing provenance and coverage

Preserve the current effective-dated, bucket-aware rate engine and add:

- a bundled, updateable catalog for common models;
- source, currency, effective date and catalog version on every rate;
- percentage of tokens and requests with known pricing;
- explicit separation of estimated cost from provider-reported cost;
- aliases and user overrides for relay-specific model names and multipliers.

Price updates must never silently apply today's rate to historical usage. An
unknown model remains unpriced rather than becoming zero-cost.

#### 5. Data-quality center

Turn diagnostics into a user-facing explanation of trust in the totals:

- unknown-route, unknown-model, unpriced and missing-project shares;
- log count, indexed count, failures and index lag;
- latest actual usage time separate from latest refresh/index time;
- timezone/day-boundary disclosure;
- proof that site/project/model subtotals reconcile to the same grand total;
- direct actions for a stale route directory or a required reindex.

It is done when a mismatch has a named bucket and a next action instead of a
plausible but false label.

### P1 — metadata-only observability and integrations

#### 6. Request health, only where the DSH log proves it

Add request counts, billed failures, cancellations, retries and latency
percentiles only for fields the host log exposes reliably. Never infer latency
from index timestamps, and never present absence of an event as success.

#### 7. Local anomaly detection

Detect cost/token spikes, a newly observed relay or model, sudden cache-hit
regression and attribution/pricing coverage drops. Start with transparent
rules and historical percentiles; every alert must show the baseline and the
rows that triggered it.

#### 8. Stable query and export surface

Version the read-only query API; add paginated session/range queries, NDJSON
incremental export and optional scheduled local reports. Prometheus or
OpenTelemetry metrics may follow, but only for numeric usage and non-content
labels. CSV/JSON compatibility remains part of the public contract.

### Explicit non-goals

Do not turn TokenLedger into:

- an LLM gateway, router, retry layer or cache;
- a virtual-key issuer, RBAC system or hard rate limiter;
- a prompt/response trace store, prompt manager or evaluation platform;
- a mandatory cloud account or cross-user surveillance service.

Those are different trust boundaries. Integrate through metadata-only exports
when useful instead of taking ownership of traffic, credentials or content.

### Recommended implementation order

1. Session drill-down and its store/query contract.
2. Trends and previous-period comparison on the same query dimensions.
3. Soft budgets, burn-rate forecasts and local alerts.
4. Pricing catalog/provenance and the data-quality center.
5. Only then evaluate request-health metadata, anomalies and external metrics.

The success criterion is not feature count. TokenLedger should move from "the
numbers add up" to "the user can locate, explain and anticipate the spend"
without weakening the zero-configuration, local and content-blind guarantees.

## Approved plan (2026-08-15)

Reviewed and approved by the repository owner. Five items, in dependency order.

### A. Auto-discover relay sites — remove the configuration entirely

Today a user must write the relay's base URL into TokenLedger's config. They
already typed it once, into DSH's own provider settings. Asking twice is a
defect, not a configuration surface.

The host will tell us, and the chain is verified against
`@deepseek-ai/dsh-llm@0.1.0-rc.6` and `dsh-llm-pi-ai`:

```js
ctx.get('llm').listConfigurableProviders()
// → [{ provider, displayName, settingsNs, settingsPath, declared? }]

ctx.get('settings').get(settingsNs)     // any registered namespace is readable
// → walk settingsPath to that provider's profile → its `baseURL`
```

`declared` is the discriminator, and upstream defines it as exactly what we
mean by a relay:

> whether the owning adapter knows this route only because configuration
> declared it — **a gateway or self-hosted server it ships nothing about**

Rules:

- Read **only** `baseURL`. The resolved value also contains the API key; it is
  never read, never logged, never stored. Site records already reject `apiKey`
  and `token` fields and that stays enforced.
- A discovered site's id is its exact domain.
- Software type stays unknown until background fingerprinting answers.
- Manual `relays` config remains, demoted to an override for what discovery
  cannot see.

Two cases discovery cannot cover, which is why the manual path survives:

- a composition with no `settings` provider mounted;
- a provider mounted by an agent preset, whose configuration lives inline in
  `agent.cordis.yml` and can register no settings namespace at all.

**Attribution is resolved at fold time and history is never rewritten.** A site
discovered after the fact does not retroactively re-attribute old rows, so a
change to the origin set must trigger a reindex rather than silently showing an
incomplete past.

### B. Register the `tokenledger` settings namespace

`ctx.settings.register('tokenledger', schema, { base })`, reached through
`ctx.get('settings')` so a composition without a settings provider still works.

Buys two things: configuration lives in the `settings.yaml` the user already
has, and `watch` makes a change live without restarting DSH.

**Cost: a peer dependency on `@deepseek-ai/schemastery`.** This ends the "zero
dependencies" claim, which must be corrected everywhere it appears. The
practical cost is nil — DSH already installs schemastery — but the claim was
made and has to be withdrawn honestly rather than quietly qualified.

Prerequisite for C: `get`/`update` only work on a registered namespace.

### C. `/tokenledger site add|rm|list`

Configuration without opening a file, persisted through
`ctx.settings.update()` / `mutate()`.

Scope note: DSH commands take arguments in one shot. There is no multi-turn
prompt, so this is `/tokenledger site add <url>`, not an interactive wizard. A
question-and-answer flow needs the panel in [Later](#later--sidebar-panel).

### D. Report defaults to per-site grouping

With sites discovered rather than configured, the site breakdown is the default
view. The provider-route breakdown stays as the fallback when no relay exists —
a single "direct" row is worse than no table.

### E. Correct the README

The README's headline currently promises reconciliation against New API and
Sub2API billing, and its capability table marks the reconciliation engine ✅.
The engine is ✅; the feature is not reachable by any user. Both statements go,
replaced by the honest state and by the fact that New API reconciliation needs
administrator credentials.

## Not doing: reconciliation

Decided 2026-08-15 by the repository owner: **cut, not deferred.** It stays
in the codebase as a library and comes off the plan.

The reason it never earned its place is the audience. Comparing a relay's
per-request charges against the fold needs New API's `/api/log`, an
administrator route — so the feature is usable by people who run a relay,
not by people who buy from one. Balances turned out to be the part that
mattered and the part an ordinary key can reach, and that shipped instead.

What is kept, and why: `verifyCharge` recomputes New API's charge from the ratios the site
itself publishes, in exact BigInt rationals with round-half-away-from-zero.
Measured against 1960 real consumption rows: 1950 reproduced under the declared
OpenAI convention, 10 under the Anthropic variant, **0 unexplained**. Floating
point mis-rounds roughly 2% of those rows, which is why the rationals are there.
Nothing else in the ecosystem does this, and it is the one part of this package
that would be genuinely hard to rebuild.

What it would take, if it is ever wanted: a `createBillingReader(site,
credentials)` factory and wiring in `collectReconciliations`, which today reads
`config.billing[siteId]` — a map of **functions** that only tests can supply.
The credential seam it would have needed now exists, because balances use it.

## Shipped — the web UI

Built 2026-08-15. Plan and its post-mortem in [`UI-PLAN.md`](UI-PLAN.md);
feature comparison against `dsh-usage-stats` in [`COMPARISON.md`](COMPARISON.md),
including the claim it disproved — this document's earlier assertion that no
usage plugin records relay attribution.

Four defects reached a real install before being caught, all of them invisible
to the tests and to local reasoning, and all found by asking the affected
machine for data:

1. The loader entry named a subpath (`dsh-tokenledger/plugin`). The client
   scanner resolves `<entryName>/package.json`, so the throw was swallowed as
   "not a client package" and cached forever. No error anywhere.
2. `webServer` was sampled with `ctx.get` at mount instead of waited for, so
   the routes never registered — the third time that same mistake shipped.
3. The balance result's `ok` overwrote its envelope's `ok`, so a served request
   with no key read as a failed one and rendered nothing.
4. **The panel was laid out past the sidebar's right edge.** `sidebar.footer.action`
   is a list slot whose container is a nowrap row, and every occupant claims
   `width:100%`. One plugin: fine. Two: the second overflows off the panel,
   visible and `opacity: 1` at `x: 268` in a column ending at 268 — identical
   in appearance to never having loaded.

The common thread: every one of them was diagnosed only after getting a
measurement from the machine that had the problem. Local reproduction kept
"passing" because the local profile had one plugin installed and the affected
one had two.

The background research below is what the plan was built on.

## Background — sidebar panel

A left-sidebar entry the user clicks when they want to look. Researched
2026-08-15; feasible.

The seat is `sidebar.footer.action` (declared by
`@deepseek-ai/dsh-client-ui-sidebar`): a root-scoped **list** slot for "optional
actions beside Settings at the sidebar foot", receiving only `wide`. The panel
it opens goes in `shell.overlay`, the frame-wide floating list slot
`dsh-client-runtime` names as the additive alternative to a React root. The
precedent to copy is `@deepseek-ai/dsh-client-ui-cordis`, whose registration is
about ten lines.

It is nearly empty real estate — one occupant today — unlike `settings.section`,
where everything with a UI will pile up.

Cost, and the reason it waits: a React browser half, ~6
`@deepseek-ai/dsh-client-*` peer dependencies, a bundling step this package does
not have, and a surface with no test coverage. One unknown remains: how a
third-party plugin registers its own RPC so the panel can read the index.

**Blocked, separately:** the native plugin-configuration card
(`settings.plugin.item`) cannot be used at all. `dsh-host-apiproxy` gates
settings namespaces served to the browser behind a hardcoded seven-name
allowlist — `agent-loop`, `shell`, `locale`, `permission`, `ui-conversation`,
`ui-theme`, `web-search-deepseek` — and anything else answers
`settings-not-exposed`. Upstream documents the fix as deferred work:

> Moving that declaration to `settings.register()`, so a plugin can expose its
> own configuration without a change in this package, is deferred work.

Note this gates only the **browser's** settings RPC. Host-side
`ctx.settings.get/register/update` is unaffected, which is what makes A, B, and
C possible.

## Out of scope

- Another live token HUD, TPS meter, or context-occupancy widget. Solved 30×.
- Skins, pets, sidebars, desktop shells.
- Writing to relay sites. Every adapter is read-only.
- Claiming `request`-level reconciliation when only aggregates exist.
- Cross-device or cross-agent aggregation — that is UsagePlane's scope.
  TokenLedger stays single-machine and DSH-side.

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
- **Read seam** is `sessionPersistence.readFrom(id, fromSeq)`; discover changed
  logs via `listSnapshots()` opaque revisions.

## Storage

The DSH session log is the authoritative append-only fact. TokenLedger does not
copy it. Two layers only:

| Layer | Role |
|---|---|
| DSH session logs | Authoritative, owned by DSH |
| `(sessionId → consumedSeq)` checkpoints + SQLite rollups | Disposable, rebuildable |

Storage uses Node's built-in `node:sqlite` (`DatabaseSync`). Rollups are keyed
`(sessionId, day, site, provider, model)` so a re-fold **replaces** rows rather
than requiring subtraction. Checkpoints advance only after the rollup write
commits, in the same transaction. Index failures never block a DSH turn,
startup, or shutdown. Diagnostics expose counts, lag, and failures — never
prompts, tool arguments, API keys, or response content.

## Verified against a real DSH install

Installed `@deepseek-ai/dsh@0.1.0-rc.6` and dumped the default `web` profile
composition on 2026-08-14. Checked rather than inferred:

**Sessions are JSONL on disk.** `@deepseek-ai/dsh-session-persistence-jsonl`
with `root: dshHomePath('sessions')`. A separate `dsh-session-query-sqlite` runs
at `:memory:` — DSH's own index, not somewhere TokenLedger should write.

**Third-party endpoints are configuration, not code.** The shipped adapter is
`@deepseek-ai/dsh-llm-pi-ai`; a route it does not ship "is declared outright, so
an OpenAI-compatible gateway, a self-hosted server, or a provider newer than the
installed catalog is configuration rather than a code change". Relay sites are
ordinary DSH provider routes, which is what makes this project possible.

**The provider → base URL map has a known location and shape** — that adapter's
`config.providers`, keyed by the route name that later appears in
`AssistantProvenance.provider`. As of item A this is read from the host rather
than restated by the user.

**Credentials already have a home.** `@deepseek-ai/dsh-credentials-local` is in
the default profile, so a future credential seam has somewhere to live.

**Session logs are zstd, and not in one piece.** `$DSH_HOME/sessions/<encoded
cwd>/session-<uuid>/session.jsonl.zstd`, written as **multiple concatenated
zstd frames** — one per flush. A single `zstdDecompressSync` decodes only the
first frame and silently returns a fraction of the log: an 11.9 KB file appeared
to hold one line. This is a good reason not to parse them directly at all;
`sessionPersistence.readFrom()` is the supported seam.

## Windows first-run verification

Performed by the repository owner on 2026-08-14 against a real
`npx @deepseek-ai/dsh web` install. Closed three unknowns that could not be
tested on Linux: the plugin loads from a published tarball, the sweep finds real
session logs under a Windows `$DSH_HOME`, and the report renders in the
conversation stream. It also found a real defect — the reconciliation view was
telling users to write config keys (`sites`, `providerBaseUrls`) that had
already been removed.

## Ecosystem listing

Verified 2026-08-14 against each index's contributing rules.

| Index | ★ | Mechanism | Requirement |
|---|---|---|---|
| `AdamPlatin123/awesome-dsh-plugins` | 623 | **Automatic** — scans the `dsh-plugin` topic | None; the topic is set. |
| `awesome-dsh-plugin/awesome-dsh-plugin` | 483 | Pull request | `package.json` must declare `dsh.bundle` **and** a `cordis.patch.yml` must exist. |
| `0xsline/awesome-deepseek-harness` | 289 | Pull request | A real repository, no placeholders. One factual line. |
| `bruc3van/awesome-dsh-plugin` | 54 | Pull request | Explains what the plugin solves and for whom. |

The repository owner opens these submissions.

**Unverified lead:** `dshworks/awesome-dsh-plugins` (created 2026-08-13) lists
entries with a version column sourced from package metadata, which suggests
automatic pickup on npm publish. It has already starred this repository without
listing it — consistent with the crawler skipping an unpublished package. Worth
confirming before opening a PR that may be unnecessary.

## Later — beyond DSH (conditional)

Attribution and reconciliation depend on where tokens were bought, not on which
agent spent them. Only pursue once the plan above is solid.

- [ ] Extract the relay adapters as their own published package.
- [ ] Pluggable usage sources so Claude Code, Codex, or OpenCode logs can feed
      the same engine.

## Subscription-plan providers (not implemented)

Three providers expose a *plan quota* rather than a money balance: rolling and
weekly windows with reset countdowns. Endpoints probed on 2026-08-15 — each
answers 401 to a bad Bearer while a sibling path under the same prefix answers
404, so the route exists:

| Provider | Endpoint | Probe |
|---|---|---|
| OpenCode Go | `https://opencode.ai/zen/go/v1/usage` | 401 `AuthError`; sibling path → 404 HTML |
| Kimi For Coding | `https://api.kimi.com/coding/v1/usages` | 401 `unauthenticated`; sibling path → 404 JSON |
| MiniMax Coding Plan | `https://api.minimax{.io,i.com}/v1/token_plan/remains` | **HTTP 200** with `base_resp.status_code: 1004` |

MiniMax is the trap: it answers **200 on an auth failure** and puts the error in
`base_resp.status_code`, so a `response.ok` check reads a rejected request as a
successful one. Any adapter for it must branch on the body, not the status.

These are deliberately out of scope for now. `BalanceCard` renders one amount
against a total; a plan quota is a set of windows, each with its own limit,
usage, and reset time. That is a new component, not a new scheme — and the
existing `SCHEMES` shape cannot express it without lying about what it holds.

## Reconciliation: removed

Removed in the audit sweep, closing issue #1. It had become the most expensive
possible state: 934 lines of source and 59 tests, a `/tokenledger reconcile`
command a user could type, no mention anywhere in the README, and a dependency
on config keys that had already been deleted.

The product reason has not changed and is unlikely to: New API's per-request
consumption log lives behind `/api/log`, an administrator route. Only a relay's
owner can read it, so for essentially every user of this plugin the comparison
had no left-hand side to compare against.

What survived, because it earns its place independently:

- `pricing.js` — cost estimation from a configured rate table
- `adapters/detect.js` — relay fingerprinting, which now selects a balance scheme
- `balance.js` — the New API and Sub2API balance readers, which need only an
  ordinary key and are what the panel actually shows

The engine is in git history at `1828c44~1` if it is ever wanted back.
