# RED-206: Windows / Android 0.1.2

## Contract

- Owner requested a PR for manual merge, followed by release 0.1.2. This explicitly authorizes publishing after the owner merges; the agent must not merge the PR.
- base_branch: main; base_sha: 554f3fb16823fe4e6f6122da1c32872e9584c8a7 (freshly fetched and merged into the repair branch without rewriting history).
- Scope: the approved RED-206 fixes, package/lock version 0.1.2, Android versionCode 21, and this release report. Reuse existing synchronized-release tooling and signing identity.
- Non-goals: changing updater protocols, keys, application IDs, save formats, dependencies or unrelated known baseline failures.
- Risk: High (distribution). User authorized the version and release; source merge remains with the owner.
- Acceptance: Windows and Android artifacts built from the same merged source, version 0.1.2; formal non-debuggable APK with increasing versionCode and existing signer; matching source proofs, checksums and update feeds; verified previous-version delta when available; draft assets verified before publication.
- Validation: RED-206 focused regression evidence, repository lint/ESLint configuration checks, synchronized release and Android artifact/delta tests, packaged integrity and executable smoke checks.
- Rollback: withdraw a faulty release and restore the prior feed; correct installed Android builds with a higher versionCode rather than forcing a downgrade. Preserve signing identity and user data.

## Release notes

- Skill cooldowns now decrease at the end of the owning player's turn, including the turn when the skill is used. Itachi and Shishio apply at least one cooldown, matching the intended full-turn restriction.
- Hide the tutorial scrollbar while keeping long content and controls accessible; refresh deployment portraits and clear missing images.
- Velen prophecy choices show card names; prophecy and Kyoka Suigetsu targets remain private, including interrupted and resumed casts.
- Add Itachi's Amaterasu keyword. Venom displacement uses the shared root status.

The cooldown engine and character content must ship together. The authoring resource candidate alone is not an update for older engines.

## Preparation evidence

See [battle feedback validation](./battle-feedback-fixes.md) for 338 focused tests and the independent review. Nine unrelated full-suite failures were independently reproduced on the pre-existing baseline; their assertions were not weakened.

Version preparation is included in the source PR. Binary construction and publication follow the owner's merge; no 0.1.2 artifacts have been published by this preparation commit.


Additional approved release content: off-turn responses retain the initiating action; battle history stays highlighted above dialogs and remains accessible during target selection. Suspended secret casts preserve their target privacy before execution logs exist. Final focused suite: 30 files / 414 tests passed; hidden Electron history smoke passed at desktop and compact landscape sizes. Prior connection history is not persisted across full reloads.


## Latest main synchronization

The owner requested incorporating the latest main before publication and announcing the changes. Main 554f3fb adds RED-205 fast startup; merge 52a80d4 incorporates it. A new async runtime-verification test used an overly broad Buffer type; its mock now derives the return type from fs.promises.readFile without changing assertions or runtime behavior. Initial real PostgreSQL tests lacked this worktree’s staged runtime; the canonical preparation script supplies and verifies it before rerun. Final binary source is pinned in release-bundle.json.

PR #182 was merged by the owner as a209efe90c00294990db2d3036ae6d072ddecfaf. Release production sources include that merged main; the follow-up changes only the test mock type and this report. Validation after synchronization: 457 tests initially passed, and all 7 PostgreSQL tests passed after canonical runtime staging (459 distinct tests covered). Root and Electron type checks, full lint and 38 release-tool tests passed.
