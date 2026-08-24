# RED-69 motion feedback evidence

## Scope

RED-69 adds presentation-only feedback for piece press/release, pending command, movement, hit, heal, status changes, death, and target cells. No rule, numeric balance, save format, asset, dependency, or authoritative-state mutation is introduced.

The page exposes one pending command through `BattleViewModel.interaction`; the Three.js renderer owns interruptible controllers, deterministic event-key deduplication, reduced-motion fallbacks, and lifecycle disposal.

## Automated evidence

- Focused renderer, motion contract, and battle-page regression suite: 3 files, 36 tests passed.
- TypeScript: `npm run typecheck` passed.
- Encoding: `npm run check:encoding` passed (564 text files checked).
- Final full Vitest after independent-review fixes, with a non-persisted 10-second timeout allowance: 76/76 files and 608/608 tests passed in 180.54 seconds.
- Independent final full Vitest at the repository's default 5-second timeout reached 603/608 tests; the five failures were load timeouts in unmodified `red43-ui-acceptance` (2), `ai-environment` (1), `combat-event-audit` (1), and `turn-timer-room` (1) tests.
- Isolated rerun of those four files passed 39/39 in 9.68 seconds. The repository timeout was not changed to hide the load-sensitive baseline behavior.
- ESLint could not start because the current dependency tree does not contain the configured `eslint-plugin-import`; no dependency or lint configuration was changed for this UI-only task.
- Coverage includes one-frame press response, pan cancellation, ten rapid submissions producing one transport admission, duplicate/unrelated snapshot retention, confirm/reject/timeout/disconnect recovery, pending switch blocking, pending lift/outline, movement retargeting from the visible position with the 0.08-height cap, duplicate event suppression, simultaneous target entry, target press during entry with one scale controller, outline retarget continuity, status add/remove, reduced hit/heal/reject/death bounds, no redraw replay, 120ms target exit disposal, piece removal, dispose, and remount cleanup.

## Authority correlation (resolved by RED-99)

`PublicBattleSnapshot` now carries an optional response-envelope `acceptedClientActionId`. Applied and duplicate player commands echo the submitted ID; target/option preparation responses use the same field. Initial snapshots, reconnect snapshots, timer/system commits, and unrelated authority updates omit it.

`battle.html` keeps the single-flight guard until that field exactly matches the pending command, or until a correlated rejection, timeout, disconnect, or page disposal occurs. `stateHash` and `authorityVersion` remain snapshot ordering/deduplication signals and are no longer treated as command acceptance. Relay forwards the ACK transiently without persisting it in the reconnect state blob.

## Manual visual matrix

The routed training battle was opened in headless Chromium at each required viewport in normal and reduced-motion modes. All six captures reached the battle canvas with the expected viewport, one canvas, hidden body overflow, exact motion token values, and the requested media-query state.

| Viewport | Normal | Reduced motion | Static render result |
| --- | --- | --- | --- |
| 1280×720 | captured | captured | Board, pieces, HUD, and action controls visible without page overflow. |
| 390×844 | captured | captured | Portrait battle remains operable; bottom controls and end-turn action remain visible. |
| 844×390 | captured | captured | Landscape battle remains operable; HUD and board share the viewport without page overflow. |

Observed console noise is unchanged from the RED-68 route baseline: missing optional resource-pack probes, the existing `evil-explosion.json` 404, and Chromium/WebGL `readPixels` warnings. No RED-69 JavaScript exception was observed.

### Remaining merge-time manual evidence

The following acceptance evidence needs a human/device pass because static headless screenshots and deterministic unit tests cannot prove physical timing, thermal behavior, or subjective motion quality:

- Record the per-action 60 FPS trace/video in normal and reduced-motion modes.
- Exercise 16 simultaneous pieces and confirm health/status readability while effects play.
- On a physical Android WebView, execute 20 selections, 10 moves, and 10 target selections, then record the three-minute FPS/heat result (required floor: 30 FPS).
- Confirm press latency, retarget continuity, and reject/timeout/disconnect recovery by eye.

## Rollback

The change is presentation-only and has no migration. Revert by boundary: motion CSS; renderer controller/effects; page pending-state wiring; regression tests and this evidence note.
