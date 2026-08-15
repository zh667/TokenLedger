# TokenLedger vs dsh-usage-stats

Compared 2026-08-15 against `Ychris12138/dsh-usage-stats` (20★, the
highest-starred plugin in the DSH ecosystem that is actually a token meter),
by reading its source rather than its README.

## Correcting an earlier claim

This repository used to say that usage plugins "all lack the one dimension:
your usage record does not say which relay the spend went to." **That is too
strong and has been removed.**

`dsh-usage-stats` aggregates on a compound `provider/model` key
(`lib/usage.js`) and renders it as `api99 · gpt-5.6-sol`
(`lib/client.js:modelLabelOf`). It does distinguish provider routes.

The accurate statement is narrower: it records the **route name you invented**,
not the **site identity**. Those are the same thing only when each relay has
exactly one route.

## Where the difference actually bites

`GET /api/usage-stats/usage` takes no parameters, and the client fetches it
unfiltered. Provider distinction exists only inside a day's model list, after
clicking into that day. So:

| Question | dsh-usage-stats | TokenLedger |
|---|---|---|
| Which relays am I using? | route names, inside each day | `/tokenledger site` |
| How much went to one relay this month? | click every day, read the `route · model` rows, add them yourself | `/tokenledger 30 <site>` |
| Two keys on one relay (one per model group) | two rows that never combine — but one invoice | one row, grouped by origin |
| What is the site called? | `api99`, a name that appears nowhere on the bill | `api.relay-one.example` |

Its own summary cards mix wallets: with a relay route selected, `本月` still
showed the direct-to-vendor traffic too, because the selector drives the
**balance** card, not usage.

## What it has that we do not

Verified in its source, not inferred:

| | Where |
|---|---|
| **A web UI at all** | sidebar-footer badge → overlay panel |
| **Balance queries** — DeepSeek, OpenRouter, Moonshot/Kimi, Z.AI/GLM | `lib/balance.js` |
| **Subscription quota windows** — OpenCode Go, Z.ai percentage windows | `lib/subscriptions.js` |
| Month calendar heatmap with day selection | `lib/client.js` |
| Today / this-month / cumulative stat cards | ditto |
| Per-day drill-down with per-model bars | ditto |
| i18n (zh + en dictionaries) | ditto |

Balance and subscriptions are real features with no counterpart here, and they
are the reason someone would keep it installed alongside.

## What we have that it does not

| | Where |
|---|---|
| **Relay site identity by origin**, auto-discovered from the host's provider config | `src/discovery.js` |
| **Site-level totals and filtering** | `src/store.js` |
| Cost estimation: effective-dated rates, per-bucket pricing, peak/off-peak | `src/pricing.js` |
| CSV / JSON export | `/tokenledger export` |
| Index diagnostics, including unattributed-row count | `/tokenledger diagnostics` |
| SQLite rollups keyed per session, so a re-fold replaces rather than subtracts | `src/store.js` |
| Relay software fingerprinting, credential-free (off by default) | `src/adapters/detect.js` |
| New API / Sub2API billing adapters + reconciliation engine | removed — see issue #1 |
| 177 tests | `test/` |

Its persistence is an incremental JSON cache at
`<DSH_HOME>/storages/usage-stats-cache.json`; ours is SQLite with checkpoints
and a tested full-rebuild path. Neither is wrong — the JSON cache is lighter,
the database makes range queries and per-site filters cheap.

It has no cost estimation for usage (its currency formatting serves the balance
card) and no export.

## Honest read

For one relay with one key — the common case, and the reporter's own setup —
the two overlap heavily and it is ahead on presentation. The gap opens with a
second key on the same relay, with more than one relay, or when the question is
"how much did this site cost me" rather than "how many tokens today".

Its balance and subscription features are strictly additive and worth having;
they are not on this project's roadmap.
