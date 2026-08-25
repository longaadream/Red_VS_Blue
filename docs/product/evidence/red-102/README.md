# RED-102 browser and test evidence

## Scope exercised

RED-102 changes presentation only. The browser pass used the canonical `battle.html` through the loopback QA route; no rules, economy, save schema, random algorithm, or network command shape was changed.

## Browser scenarios

### Dense battle

- Real room: `red43-light-mt3pe4v9`
- Fixed seed: `4301`
- 16 live pieces (8 per owner)
- Verified: one thin torn-paper map over a parallel tabletop, flat hand-drawn grid and terrain marks, portrait fallback, Jaina standee load, AP/CP HUD, selected-piece HP, four action buttons, special-status panel, tile-information panel, end-turn control, reset view, wheel zoom, and responsive layouts.

### Three pilot standees

The built-in training setup created a real battle containing exactly:

- `arthas`
- `jaina`
- `blue-naruto`

All three standees loaded from the explicit runtime manifest. No guessed filename requests were made, and faction color remained on the separate base.

## Evidence files

| File | State |
| --- | --- |
| `battle-1280x720.png` | Dense battle, default state |
| `battle-action-menu-1280x720.png` | Jaina selected, AP/CP plus action/status/tile panels |
| `battle-paper-map-v2-1280x720.png` | Thin paper map and simple symbols, default training state |
| `battle-paper-map-v2-selected-1280x720.png` | Real canvas click with action/status/tile panels visible |
| `battle-1440x900.png` | Desktop responsive pass |
| `battle-390x844.png` | Portrait mobile pass |
| `battle-844x390.png` | Landscape mobile pass |
| `three-ip-standees-1280x720.png` | Arthas/Jaina/Naruto manifest pass |
| `concept-vs-implementation.jpg` | Second combined design comparison |

## Automated checks

| Command | Result |
| --- | --- |
| `npm test -- tests/ui/battle-paper-puppet.test.ts tests/ui/battle-renderer-3d-runtime.test.ts tests/ui/battle-25d-mobile.test.ts tests/ui/tile-status-panel.test.ts tests/game/battle-context-layout.test.ts tests/game/turn-timer-status-ui.test.ts` | Passed: 6 files, 35 tests |
| `npm run typecheck` | Passed |
| `npm run check:encoding` | Passed: 586 text files |
| `node --check data/pages/js/battle-renderer-3d.js` | Passed |
| `git diff --check` | Passed |
| `npm test` | 75/79 files and 634/638 tests passed; four unrelated tests timed out at the default 5 seconds, with no assertion mismatch |
| `npm test -- --testTimeout=10000 --maxWorkers=4` | Environmental I/O run remained timeout-bound: 73/79 files and 624/638 tests; all 14 failures were timeouts in packaging, tooling, AI, debug, and baseline fixtures |
| `npm run lint` | Could not start source lint: current repository config references `import/no-anonymous-default-export` without an available `import` plugin |

The focused renderer and UI set was rerun after the paper-map pass and remained 35/35 passing.

## Network and console notes

RED-102 assets returned HTTP 200, including the manifest script, paper CSS, paper texture, tabletop texture, and Jaina standee. The browser still reports pre-existing 404s for resource-pack discovery probes, `favicon.ico`, and `data/skills/evil-explosion.json`; none points at a RED-102 path.

## Manual follow-up

- Art owner: approve the three character samples and the flat map-symbol set at gameplay scale.
- Android owner: run the same four viewport/gesture checks on a physical device and record thermal/frame stability.
- Independent reviewer: review this Medium-risk presentation change before merge.

## Rollback

Set any sample entry to `portrait-fallback` for a per-character rollback. For a full presentation rollback, remove the paper skin and runtime manifest includes and revert the renderer's standee/paper-terrain layer; the RED-68 portrait path remains intact.