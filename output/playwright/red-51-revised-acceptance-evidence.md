# RED-51 revised responsive battle acceptance evidence

Date: 2026-08-16
Branch: `codex/red-51-responsive-battle`
Risk: Medium

## Scope exercised

- Shared `battle.html?mode=training` route at 1280×720, 1024×768, 760×720, and 390×844.
- PR #55 compact board health/status presentation and the complete piece detail modal/sheet.
- Board-anchored piece skill menu, target-mode collapse, cancel restore, pan/zoom position signal, and 44px mobile controls.
- Existing single `#handCards` source rendered as a fanned hand; no duplicate arc hand container.
- Mobile training setup from a fresh reload, including reaching and activating `开始训练`.

## Results

- 1280×720: selecting an owned piece opened the compact translucent menu beside its projected position. Selecting `霜之哀伤` removed the menu before the target prompt appeared; cancelling restored it.
- 1024×768: the fixed phase/player HUD and top-right controls did not overlap. The board, end-turn control, training controls, and hand remained reachable.
- 760×720: exactly five cards rendered from the existing `#handCards` source with symmetric transforms (`-25°`, `-12.5°`, `0°`, `12.5°`, `25°`) and no clipping; the context menu stayed within the board stage.
- 760×720 frameless follow-up: the hand panel and training command container both computed to a zero border and transparent background; the hand edge pseudo-element computed to `content: none`, while five fanned cards and every local training control remained visible.
- 390×844 frameless follow-up: the page stayed exactly 390px wide, the five-card hand remained horizontally browsable (`532px` scroll width in a `390px` client), and removing the container materials caused no viewport overflow.
- 760×720 detail return: opening complete skills/status closed the context menu; pressing `✕` preserved `selectedPieceId` and immediately restored the same piece menu inside the stage.
- 390×844: the contextual skill and info controls were at least 44px high, stayed inside the board stage, and the info control opened the complete detail as a bottom sheet.
- 390×844 fresh load: the setup sheet scrolls internally while `返回` and `开始训练` stay visible. `开始训练` was activated successfully.
- The final mobile fanned-hand first-card bounding box began at `14.43px` with `scrollLeft=0`; the first card and its cost marker were no longer clipped.
- Browser log review found no `TypeError`, `ReferenceError`, unsupported battle intent, or call to the removed `_updateHpBarPositions`. The read-only local harness maps `data/pages` and the repository `data` pack directly; optional missing art and the absent `evil-explosion` pack entry account for the remaining expected 404 messages.

## Hand visual fixture

The training setup creates one visible coin card in this isolated harness. For the 8-card desktop screenshot and the exact 5-card 760px evidence, that card was copied to unique instance IDs in temporary browser state and `renderHand()` was called. No repository data, rule implementation, persisted state, or authoritative server state was changed. The production layout math is independently covered by `battle-context-layout.test.ts`.

## Evidence

- `red-51-context-menu-desktop-1280x720.png`
- `red-51-fanned-hand-desktop-1280x720.png`
- `red-51-context-tablet-1024x768.png`
- `red-51-five-card-760x720.png`
- `red-51-context-five-card-760x720.png`
- `red-51-context-menu-mobile-390x844-final.png`
- `red-51-status-sheet-mobile-390x844.png`
- `red-51-training-setup-mobile-390x844.png`
- `red-51-frameless-hand-training-760x720.png`
- `red-51-frameless-hand-training-390x844.png`

## Automated checks

```text
npm test -- --run tests/game/battle-context-layout.test.ts tests/game/battle-page-contract.test.ts tests/game/battle-piece-status-summary.test.ts tests/game/battle-ui-boundary.test.ts tests/red67-player-alignment.test.ts
5 files passed, 20 tests passed

npm test -- --run
37 files passed, 303 tests passed

npx eslint <affected RED-51 JS/TS files>
passed

npm run check:encoding
548 text files checked

git diff --check
passed
```

The first full-suite run was executed concurrently with ESLint and the encoding scan and saw one temporary Electron archive read as zero bytes. The isolated failing packaging case then passed, and the serial candidate run passed all 303 tests; the initial I/O anomaly is retained here rather than hidden by the retry.
