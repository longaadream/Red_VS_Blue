# Combat trigger atomicity and `after*` contract (RED-72 / RED-121 / RED-139)

Status: extended by RED-139 under accepted ADR-0021 on 2026-08-31. Risk: High.

This contract applies to one logical root action across one or more `runBattleAction` / `applyBattleAction` commands. RED-121 extended the boundary to every synchronous trigger point. RED-139 includes the transient four-kind `EffectChain`, its typed FIFO ledger and budgets in that same transaction without adding BattleState, save, trace, or network fields.

| Outcome | Commit and cost | Randomness | Consumer continuation | `after*` events |
| --- | --- | --- | --- | --- |
| `success` | Commit the before phase, core effect, AP/charge/cooldown/hand changes, and approved logs | Commit consumed cursors | Continue in approved order once | Exactly once for the successful root action |
| `blocked` | Commit completed before effects, their limits, and trigger messages; do not pay action cost or write the core action log | Commit randomness consumed by completed before consumers | Stop after the blocker | None |
| `pending` | Keep the authoritative battle at the root-action pre-state and commit only the versioned selection session plus server-private transaction record | Restore the root runtime checkpoint; no cursor or clock read is committed while pending | Replay from the root action and inject validated answers at their recorded consumer ordinals | Supported at `after*` and every synchronous trigger point; no `after*` effect is visible while pending |
| invalid input | Reject with `BattleRuleError`; no state, cost, log, or dispatch mutation | No cursor advance | No before/core/after dispatch | None |
| exception | Roll back the complete logical root action, including battle state, costs, hand, logs, TriggerSystem event IDs/rule limits, EffectChain ledger/budgets, and earlier consumers; rethrow with context | No committed cursor or logical-clock advance | Stop immediately; never swallow or wrap the suspension or EffectChain fatal signal | None after failure; an exception during resume leaves the authoritative pre-action state and current session intact |

`after*` includes `afterMove`, `afterSkillUsed`, `afterCardPlay`, damage/heal after-events, card-added events, summon events, and status-change events at their existing call sites. Each committed effect is visible at most once. A prompt from any of these consumers suspends the logical action instead of exposing a half-completed state.

Exceptions include event type/id, consumer kind/id, root/depth, turn, player, action, seed, and random cursor where available. `EffectChainFatalError` additionally carries action/chain/batch/parent IDs, effect kind, enqueue sequence or endogenous origin stage, processed/limit counters, source/skill/targets where applicable, and preserves the original cause. The implementation preserves RED-61 ordering, the RED-62 local event limits, and ADR-0021's action-wide 20 depth / 100 Batch / 1000 dispatch limits.

## EffectChain transaction boundary

Each authoritative root attempt installs one transient `EffectChain`. Sequential root facades share it while it is idle; during Batch/consumer processing, follow-ups must use approved typed writers. Damage, Heal, Summon, and Death entries share one enqueue sequence, so kind changes never reset budgets or create a type priority.

Every attempt snapshots BattleState, RuleRuntime, TriggerSystem, and EffectChain state. Validate, Prepare, Commit, Emit, follow-up drain, dynamic surface execution, and budget failures all roll back together. A fatal error is rethrown with its original code/context/cause; dynamic wrappers may add consumer context but may not convert it into a normal failed result.

Detached low-level helpers retain compatibility behavior for focused tests and single helper calls. They are not evidence of authoritative rollback or action-wide budgets.

## Suspendable transaction record

The server-private record is serializable and versioned. It contains the root action, pre-action targeting revision, deterministic runtime checkpoint, ordered validated answers, and the current interaction key. The key includes consumer kind, consumer ID, source ID, event type, and a deterministic consumer ordinal, so repeated uses of the same rule cannot consume another prompt's answer.

A resume replays the root action from the pre-action battle state and creates a fresh EffectChain whose sequence and counters are deterministically rebuilt. Trigger rules and reactive cards consume recorded answers before executing their interactive branch. A new prompt replaces the current session while retaining the answer transcript; successful replay promotes the complete result once. A half-finished Batch or ledger is never serialized into pending or public state.

A target prompt may be raised after the provisional action has moved a source, removed an occupant, or otherwise changed target geometry. Candidate discovery therefore uses a server-private snapshot of that provisional suspension point, while the authoritative battle remains at the root-action pre-state. The stamped candidate set is authoritative for submission validation; the provisional snapshot, logical suspended turn, and transaction record are discarded from every public projection.

Legacy skill results that return a post-effect `pendingTargetSelection` are adapted into synthetic target consumers. Replay reconstructs each provisional selection point in order, consumes its recorded answer, and executes each serialized target effect once. A target effect may raise the next target consumer without committing the provisional root action. By default, cancellation skips the post-effect target and commits the root action, preserving the legacy contract. A skill may explicitly declare `rollbackPendingTargetOnCancel`; only then does cancellation at any synthetic target stage discard the whole provisional root action, including costs and earlier provisional target effects.

Public battle projection exposes only owner, candidates, source, cancellation policy, selection ID, and revision. It must never expose the root action, answer transcript, runtime checkpoint, trigger context, or continuation data.
Option sessions may declare `selectionMode: 'multi'`, `presentation: 'hand'`, and authoritative `minSelections` / `maxSelections` bounds. Multi-select submissions are arrays of unique candidate values; cardinality, duplicates, stale instances, credentials, and ownership are validated before replay. The owner projection receives these presentation fields and the linear per-item candidate list, while opponents and spectators receive neither candidates nor owner-only presentation metadata.

Target sessions may also declare `selectionMode: 'multi'` with authoritative `minSelections` / `maxSelections`. The client collects individual piece references from the board and submits one primary target plus `extraTargets`; it must not materialize combinations or a target-by-cell Cartesian product. The server validates credentials once for the submitted group, then validates cardinality, uniqueness, and every reference against the stamped linear candidate set before cloning, payment, trigger execution, or mutation. A later grid stage receives a separate selection ID, revision, and exact stamped cell candidates.


Cancelling a rule or reactive-card prompt records a skip for that consumer and continues deterministic replay. Cancelling a direct skill/card release prompt without a declared fallback cancels the root action. Timeout resolution submits through the same validated reducers; it does not bypass the transaction.

The timer remains attributed to the logical suspended turn through server-private `suspendedTurn` metadata, even when an end-turn replay has already reached the next provisional phase.

## Evidence

The RED-72 and RED-97 suites retain blocked, cancellation, ordering, timeout, stale-input, and rollback coverage. RED-121 adds nested skill/card/reactive-card `afterDamageDealt`, Turalyon `afterCardPlay`, provisional `afterMove` target geometry, legacy post-effect target adaptation, pre-commit public-state, deterministic replay, and resume-exception coverage. RED-139 adds malformed writer, cross-kind depth/batch/dispatch, full cancellation, resume exception, TriggerSystem/RuleRuntime/EffectChain restoration, scope cleanup, and Node/browser parity regressions. Validation order is focused regression, affected-module tests, `npm test`, typecheck, lint, encoding, differential runtime tests, and `npm run build:game-engine`.

## Rollback

Revert RED-139 in dependency order: content facades/data/bundles, then Heal/Summon/Death handlers, then EffectChain and runner/trigger transaction integration. Use normal commits/reverts; do not keep a mixed Node/browser bundle or remove only one snapshot boundary. RED-121's existing transaction and session contract remains after a complete RED-139 revert.
