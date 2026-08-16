# Combat event pipeline audit (RED-45)

Status: historical RED-45 baseline plus RED-70 integration evidence; not a complete approved rules contract. Baseline date: 2026-08-15. Integration date: 2026-08-16. Risk: Medium.

## Evidence

`scripts/audit-combat-events.mjs` inventories direct `checkTriggers` dispatches and compares them with `TriggerType`. `tests/game/combat-event-audit.test.ts` verifies catalog findings and executes an isolated trigger fixture.

`tests/helpers/event-trace.ts` supplies a deterministic test-side trace record: action/event IDs, parent/depth, consumer identity, priority, stable context snapshots, outcome flags and state hash. It deliberately does not alter production dispatch behavior.

## Observed order and outcomes on the RED-45 baseline

The following paragraph records the pre-repair branch audited by RED-45; it is not a description of the RED-70 candidate. `TriggerSystem.checkTriggers` collected global rules, then piece rules, then player rules; global/piece priority was descending. Reactive cards executed after those rules, then attached effects executed by ascending effect-trigger priority. Same-priority ordering was driven by existing array/registration order. A successful `blocked` result stopped later consumers. Exceptions were logged and later consumers continued. Pending interaction recorded IDs and rebuilt work on resume.

## Findings (production changes are out of scope)

| ID | Result | Evidence |
| --- | --- | --- |
| F01 | FAIL | `TriggerType` declares `beforePieceSummoned` / `afterPieceSummoned`, while summon dispatches emit `beforePieceSummon` / `afterPieceSummon`. |
| F02 | FAIL | Consumer categories have no approved stable cross-category tie-breaker; attached-effect priority direction differs. |
| F03 | FAIL | nested `fireEvent` is synchronous and has no event id, parent id, cycle budget, or depth protection. |
| F04 | FAIL | exception, atomicity, and after-event semantics are observed but not contractually defined. |

Each baseline FAIL required a separate repair issue linked to RED-45; the audit itself did not change production behavior.

## RED-70 integration status

| Baseline finding | Integrated result | Evidence |
| --- | --- | --- |
| F01 summon event mismatch | REMEDIATED by RED-60 | `beforePieceSummoned` / `afterPieceSummoned` producers match `TriggerType`; the AST event catalog and audit test pass. |
| F02 unstable category/priority ordering | REMEDIATED by RED-61 | accepted ADR-0006 plus table-driven source test and browser-bundle five-category/snapshot fixture. |
| F03 unbounded nested `fireEvent` | REMEDIATED by RED-62 | parent/child IDs, depth 20, and dispatch budget 100 tests pass. |
| F04 incomplete exception/atomicity/after-event contract | OPEN | RED-70 does not redefine these semantics; the original finding remains valid. |
| Browser build/differential blocker | REMEDIATED by RED-64 | `npm run build:game-engine` and the fixed-seed Node/browser fixture pass in the RED-70 candidate. |
| Lost `turn.ts` text after RED-28 integration | REMEDIATED by RED-66/RED-70 | encoding check passes and the generated browser bundle contains the repaired text. |

## Historical RED-45 handoff status

| Check | Status | Evidence |
| --- | --- | --- |
| Static event catalog | PASS | detects F01 deterministically |
| Global/piece/player order, priority, blocked, exception | PASS | `tests/game/combat-event-audit.test.ts` |
| Full suite | NOT RUN | pending focused-audit handoff |
| Browser engine build / Node-browser differential | BLOCKED | `npm run build:game-engine` cannot resolve `lib/game/engine-browser-entry.ts` on this branch |
| Pending, response-card, attached-effect trace fixture | NOT RUN | test-only trace adapter not present |

The table above is retained as the original RED-45 handoff snapshot. Current RED-70 evidence is recorded in the integration table and PR; it does not retroactively turn unexecuted RED-45 checks into passes.

## Proposed contract requiring approval

Assign each action/event a deterministic ID, parent ID, depth, sequence, seed reference, and before/after state hash. Sort a snapshotted consumer queue by approved category, priority, owner order, and stable instance ID. Specify the commit/cost/after-event behavior of success, blocked, pending, invalid, and exception. Persist the remaining queue and context snapshot for pending resume.
