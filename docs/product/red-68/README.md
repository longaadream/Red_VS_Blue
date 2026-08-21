# RED-68 browser and test evidence

## Reference and fixed state

- Art-direction source: [dark tactical table v3](../art-direction-dark-tactical-table-v3.png).
- Same-viewport reference: [v3 at 1280 × 720](./reference-1280x720.png), compared with the [1280 × 720 dense result](./after-1280x720-dense-8cards.png).
- Fixed camera: a single-axis 45° rake with orthographic projection; the stronger pitch, 0.72-unit board slab, and balanced initial coverage make the table plane itself read as tilted while keeping authoritative grid coordinates unchanged.
- Product-review simplification: player information stays inline at the top without individual boxes; the CSS board frame is removed; RED-68 button skin overrides are removed so existing battle controls keep their original UI and the board retains the dominant viewport share.
- Fixed map: 20 × 16 with seed `red-68-fixed-seed-2026-08-20`.
- The committed fixture contains 8 red pieces, 8 blue pieces, 0/1/2/3 negative statuses, and 5/8-card hands.
- `battle-renderer-3d-runtime.test.ts` actually mounts and renders that 16-piece fixture. The interactive training pack currently creates 15 visible pieces after selecting eight templates for each side, so the density screenshots replace only the presentation model and hand DOM; they do not write to `G` or invoke rules.

## Viewport comparison

| Viewport | Before | After |
| --- | --- | --- |
| 1280 × 720 | [before](./before-1280x720.png) | [after](./after-1280x720.png) |
| 1440 × 900 | [before](./before-1440x900.png) | [after](./after-1440x900.png) |
| 1024 × 768 | [before](./before-1024x768.png) | [after](./after-1024x768.png) |
| 760 × 720 | [before](./before-760x720.png) | [after](./after-760x720.png) |
| 360 × 800 | [before](./before-360x800.png) | [after](./after-360x800.png) |
| 390 × 844 | [before](./before-390x844.png) | [after](./after-390x844.png) |
| 844 × 390 | [before](./before-844x390.png) | [after](./after-844x390.png) |

Additional acceptance evidence:

- Target mode: [390 × 844](./after-390x844-target.png) and [844 × 390](./after-844x390-target.png).
- Dense 16-piece table with 8 cards: [1280 × 720](./after-1280x720-dense-8cards.png) and [390 × 844, scrolled to the last card](./after-390x844-dense-8cards.png).
- Dense 16-piece table with 5 cards: [360 × 800, scrolled to the last card](./after-360x800-dense-5cards.png).

## Browser verification

- The orientation guard stayed hidden and the Three.js canvas was available at all seven required viewports.
- Final 844 × 390 measurement: projected cell minimum axis `44px`, page overflow `0px`, and zero visible buttons below 44 × 44.
- Final 844 × 390 target flow selected Arthas and Frostmourne. Phase bar, toolbar, hand, end-turn, training tools, piece detail, tile detail, and card detail all resolved to `display: none`; cancel measured 112 × 44 and page overflow remained zero.
- Final 390 × 844 density flow had 8 cards, horizontal scrolling enabled, the last card visible after scrolling, projected cell minimum axis `44px`, and zero page overflow.
- Final 360 × 800 density flow had 5 cards, horizontal scrolling enabled, the last card visible after scrolling, and zero page overflow.
- A 5 × 3px movement stayed a click; a 48 × 30px movement panned more than 20px. Chromium two-touch pinch increased the projected cell span by more than 35%; reset restored the fixed camera pose.
- Both board sides and all four corners were reachable through pan/reset without changing authoritative coordinates.
- The final routed static-browser run emitted no page exception. Its only console error class was the existing missing `data/skills/evil-explosion.json`. Optional resource-pack and log-manifest probes also returned their pre-existing 404 fallbacks; RED-68 adds no asset request.

## Executable renderer coverage

`tests/ui/battle-renderer-3d-runtime.test.ts` uses the repository's real Three.js geometry, camera, materials, projection, and raycaster with only WebGL output replaced. It verifies:

- mount, 20 × 16 / 16-piece update, center/corner project-to-hit round trips, DPR cap, and a minimum 44px projected cell axis;
- tap activation, 10px drag threshold, pan, pinch zoom, and reset;
- blue faction emissive restoration after damage plus one-pip/two-pip non-color faction encoding;
- unchanged serialized presentation input after interaction;
- dynamic piece-removal and remount/dispose cleanup of RAF, listeners, resize observer, WebGL context, geometry, material, and canvas.

## Quality gates

- Focused battle regression set after product-review changes: 9 files and 68 tests passed.
- Full suite after latest-main integration: 71 files and 564 tests passed.
- `npm run typecheck`: passed.
- `npm run check:encoding`: passed for 555 text files.
- `npm run lint`: repository configuration stops before source lint because its last flat-config object references `import/no-anonymous-default-export` without registering the installed `eslint-plugin-import`.
- A temporary uncommitted mirror config that only adds that plugin mapping ran full ESLint with zero errors and zero warnings. The config was deleted after the gate.

## Remaining manual check

Physical Android WebView validation was not available. Before merge, record the real device model, DPR, average/minimum observable FPS, and a three-minute result while verifying safe areas, rotation, one-finger pan, two-finger pinch, third-touch rejection, target selection/cancel, card scrolling, and edge controls. This is the only RED-68 contract item without direct environment evidence.

## Rollback

The change is presentation-only and has no data or save migration. Revert the RED-68 commits by boundary: tactical CSS; 2.5D renderer/helper and HTML wiring; renderer/input tests; review fixes and evidence.
