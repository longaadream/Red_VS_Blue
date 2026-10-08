# Dynamic content runtime (RED-82)

Trusted JSON content is compiled only through `lib/game/dynamic-code-runtime.ts`.
It is not a sandbox: project content remains trusted code, and this change does
not claim to make dynamic execution safe for third-party content.

The cache identity contains the runtime version, execution surface, content ID,
content revision, and deterministic code hash. Cached entries retain exact source
as a collision guard. A force reload removes only its surface/content entry.
Compiled functions are module-private and never written to `BattleState` or saves.

The current surfaces are skill `code`, card `code`, Rule `skillCode`, Rule
`triggerSkill`, `previewCode`, and pending-target `effectCode`. Compilation and
entry failures report surface, content ID, version, and phase. Action reducers
execute on candidate state, so a failed pending continuation cannot commit a
partial authority state.

Public battle previews install optional scoped `ruleResolver`, `skillResolver`,
and `cardResolver` capabilities in `RuleExecutionContext`. Authoritative rooms
leave these unset and retain their normal content loader. Card previews resolve
static definitions from canonical resources; generated Armor Assembly cards are
admitted only after re-running the canonical generator in a fresh isolated
context and comparing the entire resulting definition, including code. A card
ID or display name alone is not proof of executable provenance. Unknown nested
reactive card access fails closed without executing snapshot code.

An existing custom-card registry does not by itself disable move or skill
previews. Unsupported registry creation or mutation still makes that hypothetical
result unavailable; returned preview boards omit executable card definitions.
See `docs/qa/RED241/HAND_CARD_PREVIEW.md` for regression and candidate evidence.

Run `node scripts/benchmark-skillcode-runtime.mjs` to record a reproducible
compiler-cost sample. Keep raw Node/browser evidence with the PR; do not infer a
cross-device percentage target from this microbenchmark.
