# RED-51 revised responsive battle acceptance evidence

Date: 2026-08-17
Branch: `codex/red-51-responsive-battle`
Risk: Medium

## Scope exercised

- Shared `battle.html?mode=training` route at 1280×720, 1024×768, 760×720, and 390×844.
- PR #55 compact board health/status presentation and the complete piece detail modal/sheet.
- Board-anchored piece skill menu, target-mode collapse, cancel restore, pan/zoom position signal, and 44px mobile controls.
- Existing single `#handCards` source rendered as a fanned hand; no duplicate arc hand container.
- Mobile training setup from a fresh reload, including reaching and activating `开始训练`.

## 2026-08-17 direct-hand and floating-tools follow-up

- The visible hand section was removed entirely: no panel, header, “手牌” label, empty-state strip, border, background, shadow, edge fade, or visible browser scrollbar remains. The existing `#handCards` node directly carries the fanned cards and collapses to `0px` when empty.
- At 760×720 and 390×844, a five-card in-memory visual fixture rendered from the same `#handCards` source with no page overflow. The computed scrollbar style was `none`.
- Training modification controls now start as one 44px floating trigger. The expanded popover remained fully inside both viewports; on 390×844 all three command buttons measured 44px high.
- Training tools and the piece action menu are mutually exclusive. Opening training tools changed the piece menu to `aria-hidden="true"`.
- Selecting an owned piece opens the anchored lightweight menu. Choosing “移动” hides it before legal routes appear; the browser observed 8 legal cells at 760px, then clicked a route successfully from `(12,11)` to `(13,11)`. The final 390px route screenshot likewise shows no menu over the green cells.
- The lightweight menu's explicit info button is the touch entry to complete skills and status; desktop right-click is an additional entry. Selection itself only opens the lightweight nearby actions.
- Console review found no runtime JavaScript exception from this follow-up. Remaining errors were only the known static-harness 404s for `game-engine-runtime.js`, `favicon.ico`, and the absent `evil-explosion` pack entry.

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

- `red-51-direct-cards-training-760x720.png`
- `red-51-direct-cards-collapsed-training-390x844.png`
- `red-51-training-popover-760x720.png`
- `red-51-training-popover-390x844.png`
- `red-51-move-route-clear-390x844.png`
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

For the 2026-08-17 follow-up, the first full-suite run exposed one stale `targeting.test.ts` assertion that still required the removed `#handTarget` node. The assertion was updated to preserve the actual contract—clear `pendingCardAction`, then submit the existing action—and the final serial run passed all 303 tests. ESLint passed for the changed RED-51 contract test; linting the whole legacy `targeting.test.ts` reports 14 pre-existing `no-explicit-any` violations outside the changed assertion, which were left out of this UI scope.

The first full-suite run was executed concurrently with ESLint and the encoding scan and saw one temporary Electron archive read as zero bytes. The isolated failing packaging case then passed, and the serial candidate run passed all 303 tests; the initial I/O anomaly is retained here rather than hidden by the retry.

## 2026-08-17 post-merge landscape acceptance

- The RED-51 branch was merged with `origin/main@a6544ba`, preserving the newer RED-50 authoritative target feedback, RED-32 projectile tracing, and the mobile landscape orientation policy.
- At 844×390, five cards rendered directly from the single `#handCards` source with symmetric `-25° / -12.5° / 0° / 12.5° / 25°` transforms, transparent background, zero border, no shadow, hidden scrollbar, and zero page overflow. The only visible uses of the word “手牌” were inside card rules text, not a section label.
- The remaining battle instruction strip was removed as a visual region: `#statusMsg` computed to zero border, transparent background, no shadow, and no backdrop filter.
- The training modification UI remained collapsed as one floating trigger. Its expanded popover stayed inside the viewport; after the 170ms transition, both selects and all three command buttons measured 44px high.
- A real canvas click on `training-red-1` selected the piece and opened the lightweight menu beside it, fully inside the board stage. The training popover stayed closed.
- Clicking the real “移动” control closed the piece menu before rendering 7 legal route cells; interaction mode reported `move`, so the menu cannot cover the route.
- A real right-click on the same projected piece opened the complete skills/status detail and closed the lightweight menu while preserving `selectedPieceId`.
- Browser console review found only the known static-harness 404s for `game-engine-runtime.js` and the absent `evil-explosion` skill entry; no runtime JavaScript exception was observed.

Post-merge artifacts:

- `red-51-direct-cards-training-844x390.png`
- `red-51-training-popover-844x390.png`
- `red-51-piece-menu-844x390.png`
- `red-51-move-route-clear-844x390.png`

Post-merge checks:

- Focused merge coverage: 8 files passed, 103 tests passed.
- Full Vitest candidate: 38 files passed, 335 tests passed.
- Encoding: 549 text files checked.
