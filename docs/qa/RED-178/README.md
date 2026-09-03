# RED-178 validation evidence

## Visual evidence

- `editor-fields-1200x780.png`: existing piece, common-field editing at the default window size.
- `editor-new-template-900x600.png`: new piece template opened directly in Complete JSON at the minimum window size.
- `editor-json-error-900x600.png`: malformed JSON with visible line/column feedback and the create action disabled.
- `editor-packaging-simple-1200x780.png`: the default Snapshot packaging form with advanced and Patch-only parameters collapsed.
- `editor-assets-1200x780.png`: image library with a selected static SVG preview, import/replace controls, and copyable pack path.
- `editor-pve-900x600.png`: arbitrary-depth PVE document open in the schema-neutral Complete JSON editor.
- `editor-package-content-1200x780.png`: current-workspace staging summary with data/PVE/image counts and added/overwritten paths.

The screenshots use `mock-editor-api.js`, which provides deterministic in-memory authoring data without writing to a real Electron user-data workspace.

## Automated checks

| Check | Result |
| --- | --- |
| `npm.cmd run check:main-baseline` | PASS after rebase; branch is 2 commits ahead / 0 behind `origin/main` at `de8b697150ade3de90b3c56a952a2d29306bdc44`. |
| `npm.cmd run lint:content-pipeline` | PASS. |
| Targeted Editor, Content Pipeline, protocol, store, tooling, archive and resolver suites | PASS; 266 tests. |
| Renderer JavaScript syntax check | PASS. |
| `npx.cmd tsc -p electron-editor/tsconfig.json` | PASS. |
| `npm.cmd run check:encoding` | PASS; 923 text files checked. |
| `npm.cmd run build:electron:editor` | PASS; 387 data, 37 script, and 129 runtime assets verified. |
| `npm.cmd run smoke:electron:windows -- editor-portable` | PASS; packaged app started and exited cleanly. |
| Impeccable detector | PASS with no findings; degraded regex mode was used because optional HTML parser modules were unavailable. |
| `git diff --check` | PASS. |

The packaged portable smoke loaded 34 piece, 133 skill, 17 card, 98 rule, and 16 recursive PVE JSON files. It created `red178-smoke-piece.json` through the UI, retained an unknown nested field, registered the ID in `pieces/manifest.json`, previewed a validated SVG, and rebuilt `sources/current-workspace` with 323 data JSON files, 16 PVE JSON files, and the SVG. It then completed build/sign/validate/resolve/smoke with matching CLI and Editor hashes. Fixed PVE smoke seed: `292604670`; resolved Profile hash: `74c41bebb64ad47815ee8f03ba08e04ed63ea89ce35f7fd790b1757028413cdb`; final run hash: `d588f262a7656209d66f07682a6a5bfa0072fcf3bd9467d571b580d12c4516b9`.

## Environment notes

- `npm.cmd ci` could not start because the repository lock file is currently out of sync with `package.json`. Validation dependencies were installed locally with `npm.cmd install --no-save --package-lock=false --ignore-scripts`; no dependency or lock file is part of this change.
- The complete `editor` distribution smoke correctly refused to run because an existing local Editor installation made its NSIS install/uninstall phase unsafe. The new `editor-portable` entry ran the same packaged application and full content pipeline checks without touching that installation.

## Manual review

1. Open an existing item in each of Pieces, Skills, Cards, and Rules.
2. Change a common field, inspect the synchronized Complete JSON, then restore it.
3. Add an unknown JSON field, format, save, reopen, and confirm it remains.
4. Enter malformed JSON and confirm the original file is not overwritten.
5. Create one item of each type, confirm the complete template, save it, and confirm its ID appears in the corresponding manifest.
6. Exercise the five Resource Pack operations and verify stable confirmation remains explicit.
7. Import or replace one PNG/JPG/WebP/SVG, preview it, and copy its `images/**` path.
8. Open a nested PVE JSON file, edit an unknown field, format, save, and reopen it.
9. Refresh packaging content and inspect the added/overwritten/deleted list before building.

Rollback is a revert of the RED-178 commit. Existing authoring workspaces, archives, keys, reports, and installed profiles must not be deleted.
