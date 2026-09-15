# RED-181 — Draft PR progress checkpoint

2026-09-10. Requested by the user to upload the current implementation as a GitHub Draft PR.

## Current scope

Single-player same-map PVE on the native tabletop battle page, with captain exploration, free reserve deployment, encounter boundaries, predictable IP enemy programs, camp/search/currency dialogs, seed-based landmark maps and recruitment. Native game rules remain authoritative.

Shared piece/skill/card directories now include PVE availability flags enforced at selection and execution. Exploration world, build catalog, supplies and recruitment definitions participate in the existing resource-pack validation. The six proposed card families contain 60 definitions: 4 executable cards, 56 explicitly draft designs. Three supply relics support repeat use of growth cards across encounters; no draw system, one-use cards, temporary cleanup and the shared 10-card hand limit.

This is a progress checkpoint. Full three-act progression, multiplayer, save/resume, fog of war, general community adventure loading and the remaining card effects/balance are unfinished.

## Baseline and validation

Before committing, the existing feature branch was fast-forwarded to freshly fetched main `895834297e3e49ebbf10b12074c08979931b6e01`. No task changes overlapped upstream's resource-editor update; existing staged and unstaged work was preserved.

Checks rerun on that baseline:

- `npm.cmd run lint`: passed. After the final test-harness change, its focused ESLint check also passed.
- `npm.cmd run build:game-engine`: passed, regenerating the game, practice and adventure browser engines.
- `npm.cmd run check:encoding`: passed (1,163 text files). `git diff --check`: passed.
- Regression selection: 39 files / 693 tests, initially 690 passed and 3 failed. Two adventure deployment tests were missing the supply-choice UI dependency in their VM harness; that harness was corrected and all 45 tests in `tests/game/battle-page-contract.test.ts` passed on rerun. The remaining failure is the previously recorded targeting admission hash discrepancy, with its expected snapshot unchanged.
- `npx.cmd tsc --noEmit`: blocked by TS2345 at `electron-editor/content-pipeline-worker.ts:8`. The newly fetched main introduced an import-project branch whose synchronous result differs from the asynchronous pipeline-operation result inferred by `Promise.then`. That file is unchanged by this PVE checkpoint; the upstream diff from `12a0937` to `8958342` identifies the added branch. No type error was reported in the PVE files.
- `npm.cmd run check:main-baseline`: attempted twice after the successful fetch/fast-forward; both failed with `REMOTE_UNREACHABLE` while querying GitHub. The verified fetched baseline above is retained; a later remote-head check was not available during these checks.
- Independent read-only review of the full commit scope passed. All task sources, shared content, required browser engines and adventure images are included; logs and local preview output remain ignored.

The regression selection covers PVE, deployment, progressive deployment, battle page/card metadata, targeting, Sonic, practice movement, the 3D renderer, ESLint configuration and content-pipeline suites. Logs are local under `output/pve-roguelike/draft-pr-*`; they are not bundled into the game or PR. Historical implementation/browser evidence is in:

- [Same-map slice](RED-181-adventure.md)
- [Resources and mode isolation](RED-181-resources.md)
- [Supply and growth](RED-181-card-supply.md)
- [Maps and recruitment](RED-181-map-recruitment.md)

The targeting fixture expected `efb69827…609a` and received `fc1fe4dd…5a66`. Prior baseline-isolation evidence is recorded in the supply QA document. A Draft PR must not describe all repository tests or the whole-project type check as passing.

The six-family HTML discussion handbook and its generator remain a local preview under ignored `output/pve-roguelike/build-handbook`. Canonical build/card definitions and design documents are versioned in this checkpoint.

## Rollback

Revert this RED-181 checkpoint commit or remove the independent adventure entry and optional mode-gated seams. Preserve old PVE/PvP data; no existing save format was migrated. No merge, release or deployment is requested by this checkpoint.
