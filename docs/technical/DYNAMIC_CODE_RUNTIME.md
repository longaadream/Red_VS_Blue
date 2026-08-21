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

Run `node scripts/benchmark-skillcode-runtime.mjs` to record a reproducible
compiler-cost sample. Keep raw Node/browser evidence with the PR; do not infer a
cross-device percentage target from this microbenchmark.
