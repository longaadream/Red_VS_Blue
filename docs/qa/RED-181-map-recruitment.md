# RED-181 — occupied sites, random maps and recruits

2026-09-10. Local implementation; no commit, merge or release. User requested all three features. Scope and rollback are in the newest section of `docs/technical/PVE_ROGUELIKE.md`.

## Delivered

- Occupied friendly event cells open the facility and retain native piece selection. Empty legal movement cells, reserve deployment and local/authoritative target choices retain priority. Regression reproduced before the fix: 1 failure / 6 passes in `world-ui-before.log`.
- `landmark-routes-v1` uses the existing mulberry32/derived-seed implementation. It shifts authored landmarks within a configurable neighborhood, retains encounter formations/terrain, adds connected travel roads and scenery, and may mirror the full layout. Bounded attempts explicitly fail if an authored pack cannot fit. Camps, noncombat facilities and encounter interiors remain reachable with later zones closed. This is constrained landmark generation, not arbitrary biome or full-act generation.
- The worker chooses a fresh root seed unless an explicit uint32 seed is supplied; initialization uses generated terrain and spawns before native game start. The immutable session content owns generated sites/zones/enemies. Two simultaneous sessions retain separate worlds. Same-map camp visits and victories never regenerate it. Old packs without optional generation retain their authored layout.
- Two recruitment facilities, three fixed candidates each, one recruitment per facility. Shared pool: Ana, Reaper, Liadrin, Anduin. Default cost 15 coins. New members are core reserves with native skills/rules, free deployment, retained wounds and their own settlement baseline. Camp dismissal costs 10, then 20, etc.; cannot remove captain. Prices/pool are pack configuration, not balance conclusions.
- `battle-setup.ts` exports the existing `applyInitialRules` and accepts `skipMissingPlayerDefaults` only for off-board recruitment construction. Default PvP callers are unchanged. This avoids adding a fallback opponent during a one-sided recruitment construction. Match-start player rules/reserve initialization scripts are explicitly unsupported in this first recruitment pool and fail validation.
- Pack references include recruitment templates, their declarative rule-trigger skills and related executable cards. Missing Ana, blood-echo-trigger or holy-charge is rejected. Existing signed/Base/Patch handling is reused.

## Validation

- `map-recruit-regression.log`: 9 files / 86 tests pass — all roguelike tests and old PVE prototype fixtures. Includes 128 seeds, reproducibility/variation, map/session separation, currency/distance/phase/revision validation, native recruit deployment and a real lethal skill followed by settlement.
- `map-recruit-adjacent.log`: 4 files / 73 tests pass — native deployment, progressive deployment, PvP movement and the final 9 site-input tests. The site file overlaps the previous group: **150 distinct tests across 12 files**.
- `map-recruit-types.log`: `npx.cmd tsc --noEmit` passed.
- `map-recruit-encoding.log`: encoding check passed across 1159 text files.
- `map-recruit-lint.log`: scoped ESLint passed after the final UI edit. JS syntax and `git diff --check` passed. `battle.html` remains at its prior unstaged 10 insertions / 3 deletions; this turn did not edit it.
- `map-recruit-build.log`: `npm.cmd run build:game-engine` passed, including independent adventure worker and game engine bundle. The local QA resource service was restarted to load the updated pack configuration.
- Independent read-only review by `resource_pack_review`: passed after fixing authoritative target-choice interception and missing recruitment dependency checks; optional setup seam also reviewed. Reviewer did not run tests.

## Real browser evidence

Existing native tabletop art and board renderer, 1280×720 browser viewport. Fixed-seed URL: `http://127.0.0.1:8876/battle.html?mode=adventure&seed=42`.

1. Panned the 3D board to show the landing camp; selected Tracer at (4,27).
2. Moved onto camp, AP 3→2; clicked the occupied camp cell and saw its usable rest dialog.
3. Moved onto the nearby supply cell, AP 2→1; clicked that occupied cell, searched and received 15 coins once.
4. Ended the exploration round, walked onto the recruitment cell and clicked it again. Paper dialog showed Anduin/Liadrin/Ana with portraits, stats, skill names and enabled 15-coin buttons. Distant facilities previously showed disabled buttons.
5. Recruited Liadrin: confirmation shown, wallet 15→0, dock now contains Tracer/Uther/Liadrin, Liadrin at 14/14 in reserve, still only Tracer on the board. Console error log empty. Screenshots emitted in the conversation tool results.
6. Latest normal entry `adventure.html` → start successfully generated seed **1525188811**, visible in the notebook without a seed URL parameter.

## Limits and rollback

Still a single-player first-act slice; no save/resume, multiplayer, full three-act/biome generator or complete balance. Candidate pool intentionally limited. The previous unrelated PvP targeting fixture hash mismatch remains documented in `RED-181-card-supply.md`; this turn does not claim the entire repository suite is green.

Initial `git fetch origin --prune` failed with GitHub connection reset. The final `check:main-baseline` successfully refreshed main at `895834297e3e49ebbf10b12074c08979931b6e01`, then failed `BEHIND_MAIN`: HEAD `12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441` is two commits behind. See `map-recruit-baseline.log`. The dirty task branch was not synchronized. Existing external-write restriction keeps the RED-181 amendment local. This is not a release-ready baseline.

Rollback only this turn's optional world generation/recruitment fields, modules and UI edits plus the narrow setup options/exports. Leave the pre-existing dirty PVE work and user tabs intact; there are no old saves to migrate or delete.
