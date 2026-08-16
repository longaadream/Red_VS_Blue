# skillCode compatibility matrix (RED-45)

Status: incomplete RED-45 audit with RED-70 integration addendum; no general compatibility guarantee. Baseline date: 2026-08-15. Integration date: 2026-08-16.

| Environment | Invocation | Observed signature | Result |
| --- | --- | --- | --- |
| Rule `skillCode` | `rule-loader.ts` | ambient `context`, `battle`, injected helpers | semantic difference from skill code |
| Rule `triggerSkill` | rule loader → skill executor | skill execution context | not equivalent to inline rule code |
| Skill/card `code` | `skills.ts` | skill/card context and selection helpers | baseline only |
| Attached effects | `triggers.ts` | `(ctx, battle, self)` | signature differs |
| pending `effectCode` | `turn.ts` | re-evaluated serialized function | closures unavailable |
| browser bundle | `engine-browser-entry.ts` | build fixture needed | NOT RUN |

Data uses helpers including selection, damage, effect/rule/card mutation, `fireEvent`, plus ambient `Math.random` and `Date.now`. Deterministic RNG/time compatibility is BLOCKED on RED-28. Node/browser differential fixtures remain required before acceptance.

`scripts/audit-skillcode-compat.mjs` produces the evidence list of helper use per data file; it is static and does not execute untrusted data code.

## RED-70 integration addendum

RED-64 restores the browser entry and RED-70 verifies one fixed-seed Node/browser movement fixture plus a browser-bundle trigger fixture covering all five consumer categories and response-card hand snapshots. RED-28 supplies deterministic RNG/time primitives used by the integrated runtime. These results remove the earlier build blocker, but they do not establish full equivalence for every helper or all six execution environments; unsupported and semantic-difference rows above remain audit findings.
