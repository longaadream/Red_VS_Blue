# RED-51 browser evidence

Date: 2026-08-16
Page: `data/pages/battle.html?mode=training`
Browser: Chromium through Playwright CLI

## Screenshots

- Before: `red-51-baseline-1280x720.png`, `red-51-baseline-390x844.png`
- After: `red-51-desktop-1280x720.png`, `red-51-tablet-1024x768.png`, `red-51-mobile-390x844.png`

The after screenshots use the existing training fixture and art. The tablet and mobile screenshots use an in-memory eight-card hand assembled from already loaded card definitions; no source data or rules were changed.

## Responsive layout

| Viewport | Document client/scroll | Board region | Hand | Result |
| --- | --- | --- | --- | --- |
| 1280×720 | 1280/1280 × 720/720 | 1280×457.6; canvas 1070.4×442 with detail rail | 1280×154, visible | No page overflow or HUD/hand overlap; board is the largest region |
| 1024×768 | 1024/1024 × 768/768 | Detail rail visible; phase HUD ends at x=652 and topbar starts at x=656 | 8 cards visible | No page overflow and zero horizontal HUD/topbar overlap |
| 760×844 | 760/760 × 844/844 | 760×449.6; mobile rail floats only the 104×42 turn control | 8 cards, 791/760 scroll/client | Breakpoint produces independent hand overflow |
| 390×844 | 390/390 × 844/844 | 390×449.6; canvas 379×439 | 8 cards, 791/390 scroll/client | No page horizontal overflow; 42×42 reset target remains visible |

Five-card mobile case: 506px hand scroll width in a 390px scroller; every card was enabled, the last card scrolled into view at `scrollLeft=116`, and selecting it set card index 4 to pending.

Long-content stress case at 390×844 used a 29-character Chinese player name, a long English player name, resources `1234/987`, a long stacked status, and 5999 seconds. The document and HUD both retained equal client/scroll widths (390/390 and 317/317); names truncated inside 109px while preserving their full accessible text; timer rendered `99:59`.

Final rollback-split smoke loaded both `battle-responsive.css` and `battle-responsive-mobile.css`: 390×844 retained 390/390 client/scroll width and a 163.96×42 details control; 1024×768 retained zero horizontal HUD/topbar overlap.

## Canvas, resize, and input mapping

- Detail rail open: canvas backing/CSS size 1070×442 / 1070.4×442. Projecting cell `(3,14)` and feeding its client point back into `screenToCell()` returned `(3,14)`.
- Detail rail closed: canvas grew to 1258×442 with no CSS stretch. The same round trip returned `(3,14)`. A real mouse click at the projected `(11,6)` point selected `training-red-1`.
- DPR 2 emulation at 390×844: canvas CSS size 379×439 and backing size 758×878 (`2×` on each axis); `(11,6)` still round-tripped correctly.
- Mobile mouse/wheel path: zoom changed the projected point, drag moved it again, and reset restored the original point with delta `0,0`; each intermediate point round-tripped to `(11,6)`.
- Mobile single-touch drag under DPR 2 moved the projected point by `52,28.01` CSS px for a `52,28` CSS-pixel gesture and preserved the selected cell hit mapping. Canvas CSS/backing sizes remained 379×439 / 758×878.
- Mobile two-touch pinch changed the projected point by approximately `36.0,72.0` CSS px and preserved `(11,6)` hit mapping.

## Detail, targeting, and accessibility

- Selecting a piece exposed a compact 163.96×42 details button at x=13, y=507.6. A real touch tap on that button opened the 390px-wide `role=dialog` bottom sheet with no document overflow. Entering an in-memory target-prompt state closed the sheet before showing `请选择一个目标`.
- Card details opened as a 390px-wide sheet anchored to the viewport bottom. Entering card targeting closed the sheet before showing `选择一个敌方角色`.
- Target prompt occupied y=120–143.2 and did not overlap the hand at y=702–844.
- Board reset is keyboard reachable and 42×42 on mobile. Keyboard focus produced a 1.6px solid focus outline with 2px offset.
- `prefers-reduced-motion: reduce` produced `0s` transition duration on the reset control and cards.
- Computed touch actions were `none` for the canvas (renderer owns gestures) and `pan-x` for the hand scroller.

## Console and tests

No `TypeError`, `ReferenceError`, or syntax error was emitted by the implementation during the browser run. The fixture reported only pre-existing static-server resource misses: repeated fallback attempts for `js/game-engine-runtime.js`, `favicon.ico`, and the absent `data/skills/evil-explosion.json`; the latter is also logged by the existing pack fetcher.

Focused automated verification:

```text
npm test -- tests/game/battle-ui-boundary.test.ts tests/game/battle-page-contract.test.ts
2 test files passed, 13 tests passed
npm test
28 test files passed, 242 tests passed
npm run check:encoding
[check-encoding] OK (530 text files checked)
npx eslint data/pages/js/battle-renderer-3d.js data/pages/js/battle-ui/battle-dom-ui.js data/pages/js/battle-ui/battle-presentation.js data/pages/js/battle-ui/battle-view-model.js tests/game/battle-ui-boundary.test.ts tests/game/battle-page-contract.test.ts output/playwright/red-51-static-qa.mjs
exit 0
```

The results above were captured on RED-51's original `origin/main` base. After rebasing onto `origin/main@416e74a`, the three direct RED-51 files passed 32/32 tests and the focused lint command remained green. The latest full suite ran 32 files and passed 261/262 tests; its sole failure is the upstream encoding contract detecting question-mark-only strings in `data/pages/js/game-engine.js:120`. `npm run check:encoding` likewise reports that file plus `lib/game/turn.ts:661-677`. `git diff origin/main...HEAD` is empty for both files, so RED-51 does not modify the failing paths.

`npm run lint` remains red at repository scope with 981 pre-existing findings (627 errors, 354 warnings) in unrelated API, generated, mobile-server, relay, script, and existing test files. The directly updated `tests/game/targeting.test.ts` also retains 14 pre-existing `no-explicit-any` findings outside the changed assertion. No task-local JavaScript lint finding was reported by the focused command above; RED-51 does not modify the unrelated failing lines.
