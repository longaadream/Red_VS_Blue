# skillCode compatibility matrix (RED-45)

Status: incomplete RED-45 audit with RED-70 integration addendum; no general compatibility guarantee. Baseline date: 2026-08-15. Integration date: 2026-08-16.

## Static data evidence

`node scripts/audit-skillcode-compat.mjs` is the authoritative repeatable inventory for this audit. Schema version 2 walks every JSON file under `data/skills`, `data/rules`, `data/cards`, and `data/effects`; it reports every `code`, `skillCode`, `filterCode`, and `effectCode` field with the referenced known helpers and lexical free variables.

The inventory is evidence of data usage, not proof that a helper has equivalent behavior in every execution environment. It currently finds executable fields in 110 skills, 54 rules, 16 cards, and 47 effects. The companion `combat-event-audit` test rejects a missing execution surface or an unclassified executable field.

| Environment | Invocation | Observed signature | Current evidence |
| --- | --- | --- | --- |
| Rule `skillCode` | `skills.ts` loader | ambient `context`, `battle`, injected helpers | static inventory complete; runtime equivalence open |
| Rule `triggerSkill` | rule loader to skill executor | skill execution context | static inventory complete; runtime equivalence open |
| Skill/card `code` | `skills.ts` | skill/card context and selection helpers | static inventory complete; runtime equivalence open |
| Attached effects | `triggers.ts` | `(ctx, battle, self)` | static inventory complete; runtime equivalence open |
| pending `effectCode` | `turn.ts` | re-evaluated serialized function | static inventory complete; closures unavailable by design |
| browser bundle | `engine-browser-entry.ts` | build fixture | fixed fixture passes; six-surface matrix remains open |

Data uses helpers including selection, damage, effect/rule/card mutation, `fireEvent`, plus ambient `Math.random` and `Date.now`. Deterministic RNG/time compatibility is BLOCKED on RED-28. Node/browser differential fixtures remain required before acceptance.

## RED-70 integration addendum

RED-64 restores the browser entry and RED-70 verifies one fixed-seed Node/browser movement fixture plus a browser-bundle trigger fixture covering all five consumer categories and response-card hand snapshots. RED-28 supplies deterministic RNG/time primitives used by the integrated runtime. These results remove the earlier build blocker, but they do not establish full equivalence for every helper or all six execution environments; unsupported and semantic-difference rows above remain audit findings.
