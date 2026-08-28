# Combat trigger atomicity and `after*` contract (RED-72 / RED-121)

Status: extended and approved for implementation by RED-121 on 2026-08-28. Risk: High.

This contract applies to one logical root action across one or more `runBattleAction` / `applyBattleAction` commands. RED-121 extends the atomic boundary to every synchronous trigger point without changing trigger ordering, numeric balance, random algorithms, or the damage pipeline.

| Outcome | Commit and cost | Randomness | Consumer continuation | `after*` events |
| --- | --- | --- | --- | --- |
| `success` | Commit the before phase, core effect, AP/charge/cooldown/hand changes, and approved logs | Commit consumed cursors | Continue in approved order once | Exactly once for the successful root action |
| `blocked` | Commit completed before effects, their limits, and trigger messages; do not pay action cost or write the core action log | Commit randomness consumed by completed before consumers | Stop after the blocker | None |
| `pending` | Keep the authoritative battle at the root-action pre-state and commit only the versioned selection session plus server-private transaction record | Restore the root runtime checkpoint; no cursor or clock read is committed while pending | Replay from the root action and inject validated answers at their recorded consumer ordinals | Supported at `after*` and every synchronous trigger point; no `after*` effect is visible while pending |
| invalid input | Reject with `BattleRuleError`; no state, cost, log, or dispatch mutation | No cursor advance | No before/core/after dispatch | None |
| exception | Roll back the complete logical root action, including battle state, costs, hand, logs, rule limits, and earlier consumers; rethrow with context | No committed cursor advance | Stop immediately; never swallow or wrap the suspension signal | None after failure; an exception during resume leaves the authoritative pre-action state and current session intact |

`after*` includes `afterMove`, `afterSkillUsed`, `afterCardPlay`, damage/heal after-events, card-added events, summon events, and status-change events at their existing call sites. Each committed effect is visible at most once. A prompt from any of these consumers suspends the logical action instead of exposing a half-completed state.

Exceptions include event type/id, consumer kind/id, root/depth, turn, player, action, seed, and random cursor where available. The implementation must preserve the existing RED-61 ordering and RED-62 event-chain limits.

## Suspendable transaction record

The server-private record is serializable and versioned. It contains the root action, pre-action targeting revision, deterministic runtime checkpoint, ordered validated answers, and the current interaction key. The key includes consumer kind, consumer ID, source ID, event type, and a deterministic consumer ordinal, so repeated uses of the same rule cannot consume another prompt's answer.

A resume replays the root action from the pre-action battle state. Trigger rules and reactive cards consume recorded answers before executing their interactive branch. A new prompt replaces the current session while retaining the answer transcript; successful replay promotes the complete result once.

A target prompt may be raised after the provisional action has moved a source, removed an occupant, or otherwise changed target geometry. Candidate discovery therefore uses a server-private snapshot of that provisional suspension point, while the authoritative battle remains at the root-action pre-state. The stamped candidate set is authoritative for submission validation; the provisional snapshot, logical suspended turn, and transaction record are discarded from every public projection.

Legacy skill results that return a post-effect `pendingTargetSelection` are adapted into a synthetic target consumer. Replay first reconstructs the provisional skill result, then consumes the recorded target and executes the serialized target effect once. Cancellation skips only that post-effect target when allowed; costs and the root effect still commit together.

Public battle projection exposes only owner, candidates, source, cancellation policy, selection ID, and revision. It must never expose the root action, answer transcript, runtime checkpoint, trigger context, or continuation data.
Option sessions may declare `selectionMode: 'multi'`, `presentation: 'hand'`, and authoritative `minSelections` / `maxSelections` bounds. Multi-select submissions are arrays of unique candidate values; cardinality, duplicates, stale instances, credentials, and ownership are validated before replay. The owner projection receives these presentation fields and the linear per-item candidate list, while opponents and spectators receive neither candidates nor owner-only presentation metadata.


Cancelling a rule or reactive-card prompt records a skip for that consumer and continues deterministic replay. Cancelling a direct skill/card release prompt without a declared fallback cancels the root action. Timeout resolution submits through the same validated reducers; it does not bypass the transaction.

The timer remains attributed to the logical suspended turn through server-private `suspendedTurn` metadata, even when an end-turn replay has already reached the next provisional phase.

## Evidence

The RED-72 and RED-97 suites retain blocked, cancellation, ordering, timeout, stale-input, and rollback coverage. RED-121 adds nested skill/card/reactive-card `afterDamageDealt`, Turalyon `afterCardPlay`, provisional `afterMove` target geometry, legacy post-effect target adaptation, pre-commit public-state, deterministic replay, and resume-exception coverage. Validation order is focused regression, affected-module tests, `npm test`, typecheck, lint, encoding, differential runtime tests, and `npm run build:game-engine`.

## Rollback

Revert the RED-121 transaction commit together with its engine bundle, tests, and this contract. Do not revert only the session types or only one client bundle, because mixed transaction protocols would split authoritative and projected state.
