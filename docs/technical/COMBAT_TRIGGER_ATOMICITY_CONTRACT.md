# Combat trigger atomicity and `after*` contract (RED-72)

Status: approved for implementation on 2026-08-16. Risk: Medium.

This contract applies to one `runBattleAction` / `applyBattleAction` command. It does not change trigger ordering, skill-code execution, numeric balance, random algorithms, save formats, network protocols, or the damage-pipeline redesign.

| Outcome | Commit and cost | Randomness | Consumer continuation | `after*` events |
| --- | --- | --- | --- | --- |
| `success` | Commit the before phase, core effect, AP/charge/cooldown/hand changes, and approved logs | Commit consumed cursors | Continue in approved order once | Exactly once for the successful core action |
| `blocked` | Commit completed before effects, their limits, and trigger messages; do not pay AP/charge or write the core action log | Commit randomness consumed by completed before consumers | Stop after the blocker | None |
| `pending` | Commit completed consumers and the selection session; do not pay action cost or write the core action log | Commit completed consumers; the prompting consumer is not committed twice | Persist rule/source and remaining queue; resume does not repeat completed consumers | None while pending; once after successful resume |
| invalid input | Reject with `BattleRuleError`; no state, cost, log, or dispatch mutation | No cursor advance | No before/core/after dispatch | None |
| exception | Roll back the complete command, including battle state, costs, hand, logs, rule limits, and earlier consumers; rethrow with context | No committed cursor advance | Stop immediately; never swallow | None after failure; an exception in `after*` rolls back the core and earlier `after*` work |

`after*` means `afterMove`, `afterSkillUsed`, and `afterCardPlay` at their existing core-action call sites. Each is emitted at most once for a committed core action. A pending request from an `after*` consumer is unsupported in this task and is treated as an observable contract error that rolls back the action.

Exceptions include event type/id, consumer kind/id, root/depth, turn, player, action, seed, and random cursor where available. The implementation must preserve the existing RED-61 ordering and RED-62 event-chain limits.

## Evidence

The RED-72 regression suite covers fixed minimal states for blocked `beforeMove`, trigger exceptions, action rollback, and event consumer continuation. RED-80 retains the four-category ordering evidence after removing the obsolete AttachedEffect state path. The required validation order is focused regression, affected-module tests, `npm test`, and `npm run build:game-engine`.

## Rollback

Production changes are isolated in the RED-72 commit and can be reverted independently. Tests and this document remain useful as failure reproduction evidence and may be reverted separately if the contract is withdrawn.
