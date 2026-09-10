# Same-map adventure single-player implementation

## 2026-09-10: Draft PR checkpoint

The user explicitly requested committing and uploading the current PVE progress as a Draft PR. This authorizes a normal push and Draft creation on the existing RED-181 feature branch; no ready-for-review transition, merge, release or new Linear transmission. Include the current same-map framework, shared content/availability gates, resource-pack integration, supply/growth slice, random map/recruitment extension, native browser assets, tests and documentation. Local output logs and temporary previews remain ignored.

The branch was fast-forwarded from `12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441` to freshly fetched `origin/main` `895834297e3e49ebbf10b12074c08979931b6e01`. Upstream changes were confined to the resource editor and did not overlap the PVE working changes. This supersedes earlier historical statements about the current branch being two commits behind. Re-run validation and Draft status are recorded in docs/qa/RED-181-draft-progress.md. This checkpoint preserves the explicitly unfinished first-act scope and known targeting-fixture hash discrepancy; it is not a release or product acceptance.

## 2026-09-10: occupied sites, generated terrain and recruitment

User requests fixing clicks on occupied event cells, rule-constrained random maps and recruitment. This authorizes the following High-risk extension to the existing local slice: preserve authored encounter sizes/formations while moving landmarks within bounded neighborhoods, generate connecting paths and scenery with the existing seeded RNG, and add map recruitment facilities with per-run candidates, coin costs and direct reserve membership. Defaults are configurable framework values, not a balance pass. New runs choose and expose a seed; a supplied seed reproduces placement/candidates. Existing packs without generation/recruitment continue using their authored layout.

Allowed paths: lib/pve/roguelike/**, lib/pve/contracts/roguelike-content-v1.ts, data/pve/roguelike/adventure.json, adventure page/JS/CSS, the adventure-only battle.html input branch if necessary, related tests and product/technical/QA docs. Reuse native piece construction and free reserve deployment; no new dependencies, core RNG algorithm replacement, PvP rules, old-save conversion, multiplayer, balance pass, merge or release. Preserve all earlier staged/unstaged work. Recruitment must preserve initial template identity and wounds across victories; the captain remains fixed. Limited supported recruitment pool uses shared ready PVE-compatible pieces and is checked by pack validation.

Acceptance: occupied site click succeeds without stealing movement, skill targets or deployment; seeds reproduce maps/candidates; required facilities and encounters remain reachable with later encounters closed, non-overlapping valid spawns and safe captain arrival; concurrent sessions do not share generated layout; stale, repeated, distant, unaffordable and in-battle recruitment commands are atomic; recruited pieces can deploy and survive settlement with rules restored. Run regression, types/lint/build and browser tests plus independent review. Rollback removes only these optional configuration fields/modules and their UI, restoring authored maps without touching prior PVE work or saves.

Baseline: attempted fresh `git fetch origin --prune` failed with GitHub connection reset. base_branch: main; last known origin/main (historical, not freshly verified): `895834297e3e49ebbf10b12074c08979931b6e01`; working HEAD: `12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441`. Existing external-write restriction keeps this amendment local; no branch synchronization or release readiness claimed.

Recruitment scope additionally includes the existing `applyInitialRules` export and optional `skipMissingPlayerDefaults` in lib/game/battle-setup.ts. Only recruitment uses that option; normal PvP construction remains unchanged. Defaults: three candidates per facility, 15 coins per recruitment, one recruit per facility; camp dismissal starts at 10 coins and rises by 10. These are configurable framework values.

Final baseline check successfully refreshed origin/main at `895834297e3e49ebbf10b12074c08979931b6e01`, then failed with `BEHIND_MAIN` (2 commits). Earlier fetch failure remains recorded above; this final remote identity is now verified. No synchronization, merge or release was attempted. Evidence: docs/qa/RED-181-map-recruitment.md.

## 2026-09-10: card supply and growth framework


User now prioritizes the framework over balance, retaining the 60 designed cards and one-use/no-draw rules. Explicitly approved starting supply relics and additional relics that reliably generate growth cards. Implement a vertical slice using blood curse, star spark and calibrated shot plus the existing fixed cover-shot design. Other cards retain draft status. Three supply relics generate two copies of their growth card per encounter; initial calibration relic also supplies one fixed cover shot. Counts are configurable wiring defaults, not balance decisions.

Scope/allowed paths: shared data/cards for these four definitions; data/pve/roguelike supplies catalog and world reference; lib/pve/contracts, roguelike content/reference/session/worker/supply modules; lib/game/adventure-card-state.ts and optional PVE-only hand/passive-hit hooks in skills.ts; targeting.ts and declaration types for a target step whose origin is a previous selected ally; data/pages/js/adventure and CSS for native supply/relic/overflow dialogs; exact protocol/runtime JSON whitelist; capabilities and required fixture updates; related tests, handbook rebuild and docs. No new dependencies, old save conversion, PVP economy changes, 60-card effect completion, balance pass, merge or release. Risk High (content, authority and overflow state); user approved framework implementation. Baseline refresh evidence is recorded below; the existing external-write boundary keeps scope/evidence local.

Acceptance: deterministic/idempotent encounter supply, revision-validated relic/reward choices, run-scoped player/card-ID growth inherited by later copies, native committed damage/target rules, temporary cleanup vs retained run cards, 10-card limit with explicit overflow choice and blocked play while unresolved, no PVP behavior change, packaged/validated dependencies and optional old-pack absence, tests/build/browser/independent review. Rollback only these additive data, source, targeting and mode-gated seams; keep all earlier work intact.

Implementation uses a supply transaction inside the session's uncommitted clone: existing RuleRuntime with a deterministic seed derived under `adventure-supplies`, persisted cursor/tick in `adventureCards`, isolated TriggerSystem/RuleExecutionContext and bounded EffectChain. Narrow exports in turn.ts and battle-runner.ts reuse native piece/player rule hydration and serializable-effect cleanup; these files are included in this scope. Successful world receipts include the supply state; failed commands commit neither cards, growth, RNG position nor revision. The ordinary BattleTrace is not a standalone adventure replay. Queued cards record that beforeCardAdded already ran, so accepting them runs only afterCardAdded. No pending selection may be bypassed to handle supply. This remains the single-player slice; multiplayer reward ownership and save/resume are not implemented.

The `rvb-pve-roguelike-supplies/v1` catalog is included in the existing Base/Patch resource pack. Builds and supply document paths are fixed in v1 to the browser/Electron allowlist, rather than advertising arbitrary paths that those clients cannot load. Supply references must resolve to ready PVE cards with active/reactive type and nonempty executable code. The four activated cards still use ordinary one-use card execution. Unused reward cards survive encounters; generated relic/effect cards are temporary. Growth is recorded per run/player/cardId. Blood curse counts positive resolved damage, including damage immediately followed by healing; fully blocked self-hits do not grant growth. Calibration counts actual allied passive damage to the selected enemy.

Baseline evidence for this supply turn: `git fetch origin --prune` succeeded and confirmed origin/main `895834297e3e49ebbf10b12074c08979931b6e01`; the separate `check:main-baseline` refresh then failed with FETCH_FAILED after GitHub reset. Working HEAD remains `12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441`, two commits behind that remote baseline. No branch synchronization or release readiness is claimed.

## 2026-09-10: remaining regression follow-up

The user explicitly requested continuing the ten outstanding checks, then asked about shipping a PVP-only release first. This follow-up diagnoses and fixes those checks; it does not authorize a release or activate the 60 draft cards. Scope: tests/game/battle-card-metadata-runtime.test.ts, tests/practice/movement.test.ts, tests/game/sonic-roster.test.ts, their directly exercised battle.html/practice-controller/glossary seams only if a production defect is demonstrated, and this document plus docs/qa/RED-181-resources.md. Preserve prior changes. Initial risk Medium for potential presentation fixes; actual changes may be limited to test harnesses.

Acceptance: reproduce all ten failures before editing; retain deduplication, failure-cache, disposal and consecutive-movement checks; match the concise current momentum wording while retaining mechanic tests; targeted and previous wider regressions, type/lint checks, independent read-only review. Rollback only this follow-up's edits. No dependency, economic rule, save, merge or release changes. Fresh fetch and check:main-baseline again failed due to GitHub reset/unreachability; the last known SHAs below remain historical, not a verified release base. Existing external-write restriction keeps this scope/evidence local.

## 2026-09-10: shared content and exploration resources

Latest user authorization supersedes the earlier restriction on shared collection manifests: PVE pieces/cards/skills belong in data/pieces, data/cards, data/skills, with availability { modes: ['pve'], status: 'ready' | 'draft' }. Missing metadata preserves existing PVP/PVE access; malformed metadata fails closed. PVP selection, practice random/saved rosters, authority setup, card/skill execution and template summons enforce availability. Authoring and runtime status are separate: the 60 discussion cards are registered drafts without executable placeholders. Five existing enemies and four skills remain ready.

This changes shared loading/validation boundaries (High); the user's explicit resource-system request authorizes this additive implementation. Scope: those JSON collections/manifests; public/images/adventure; lib/game availability, piece types/repository, setup, targeting, skill/card and summon gates; lib/practice/setup; server piece catalogs and piece-selection page; electron-client/client-protocol-resource; data/pages/js/game-engine-runtime.js JSON priming allowlist; scripts/qa/practice-server.mjs resource serving; lib/pve/contracts/roguelike-content-v1 and roguelike content loading; content-pipeline capabilities/validator and old PVE snapshot recognition; related tests, handbook generator and documentation. No dependencies, trust-policy relaxation, old-save migration, merge or release.

The new rvb-pve-roguelike-adventure/v1 and rvb-pve-roguelike-builds/v1 documents under data/pve/roguelike describe the exploration world and build catalog. These are not old node-flow documents. The original PVE parsers retain their semantics and validate/skip only the two recognized exploration formats. The new adventure reads the current Profile/VFS JSON before initialization rather than importing data into compiled engine code. Zone array order determines the supported encounter sequence; initial player order chooses the captain. The existing single-map slice and supported enemy programs remain the runtime boundary; this is not a general third-party AI editor.

Canonical rvb-pack/v1 continues to own archive construction, signature, hashes, import and Patch application. Bundled Base scans include the shared JSON, exploration documents and images/adventure assets. Validation checks collection manifests, IDs, PVE availability, declared summon dependencies and catalog references against the complete resolved tree. A Patch payload may rely on its parent; deleting a referenced resource fails before activation. Untrusted executable-content restrictions remain intact. A combined Base archive is an internal bundled-resource QA artifact, not an externally installable release. Old clients do not gain exploration support from a content pack and may reject the new discriminators; no forward-compatibility claim is made.

Acceptance: both old Flow and new exploration tests pass; PVP denies PVE/draft content; browser payload includes optional new entries while old packs remain readable; archive round-trip preserves identity; a data-only map Patch changes the actual loaded map; broken references and invalid flags fail. Independent review and evidence are recorded in docs/qa/RED-181-resources.md. Rollback: revert only this resource migration and its gates/loaders; leave all pre-existing PVE work intact. There is no save conversion to undo.

Baseline refresh was attempted with git fetch origin --prune; GitHub reset the connection. Last known origin/main: 895834297e3e49ebbf10b12074c08979931b6e01; working HEAD: 12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441. This is local implementation and validation, not a freshly synchronized release candidate. Existing external-write restriction is retained; this scope update remains local.

## Current revision: IP enemies and public programs (2026-09-09)

User authorized implementation, then explicitly replaced direct PVP enemy reuse
with dedicated PVE IP variants, fixed public action plans and no enemy AP economy.
These decisions supersede earlier short-search/AI and symmetric encounter-AP notes.
Fresh origin/main and baseline check: 12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441.
Risk High; no merge/release/save/network work. Local contract and verification remain
local under the existing external-write restriction; no new Linear transmission.

Current UI revision additionally authorizes the native board renderer decoration API,
its runtime tests, and adventure dialogs. Acceptance: same-plane markers and camera
synchronization without polling; visible gold outside dialogs; keyboard-dismissable
site/camp/notebook dialogs; preserved native movement, deployment and PVP rendering.
Risk Medium for this presentation-only revision; no game economy or rules changes.

Scope: lib/pve/roguelike/**, optional adventure seams in battle-setup, battle-runner,
adventure-boundary and turn; adventure JS/CSS/page and native enemy skill metadata
branch; data/pages/images/adventure/*.svg; related PVE/page/team/practice tests and
product/technical/QA docs. No global PVP piece/skill manifest or dependency changes.
Rollback these optional seams and independent adventure modules/assets.

Enemies start on the board, mixing Minecraft minions and PVE-specific Overwatch /
Warcraft elite/boss variants. Skills use the normal SkillDefinition, damage helper
and declared summon queue. Definitions live in the versioned world extension,
because the formal runner intentionally removes the runtime skillsById cache after
actions. Its adventure-only hydration merges those definitions before execution.

Each player action phase publishes at most one program action per eligible enemy,
independent of AP. plansTurn makes publication idempotent within that player turn;
beginPhase no-ops cannot retarget. Plans contain source, fixed origin, fixed cells,
round, order and formal action. Movement, attack and summons are visibly distinct.
The native runner still validates cooldown/status/space and performs actual effects.
Invalid plans are cancelled with a receipt; no replacement target is selected.

Enemy AP stays zero. Skills cost zero; only an exact published enemy move bypasses
normal movement AP checks, including after beforeMove redirection and final landing.
Player AP, deployment and default PVP remain unchanged. Enemy movement is the same
native orthogonal walk, so the published path matches the actual move geometry.
Local content and skill text follow SKILL_DESCRIPTION_STANDARD and
SKILLCODE_AUTHORING_STANDARD; full descriptions remain in native skill details.

Acceptance: complete initial lineup, local definitions survive native commands,
four-way fixed shots, dodge stays a miss, duplicate beginPhase cannot retarget,
blocked movement cancels, exact move works with zero AP, arbitrary move rejected,
native summons have correct ownership/registration and no AP, core-only clear keeps
other zones intact, PVP/player-AP regressions, independent review, browser evidence.

RED-181, approved by the user's explicit implementation request on 2026-09-09.
Initial base: main / 03339a5efffde6cba4aaa53a33908db526d593e9.
Resynchronized at the user's request on 2026-09-09 to main /
12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441. Retains upstream team setup,
team victory, spectator read-only gating and official-server build commands.
Adjacent battle-page VM tests now declare the adventure mode flag explicitly
and verify that adventure commands stay local while spectator mode stays read-only.

The first slice uses one formal BattleState on a 32x32 map. AdventureSession owns
world commands and records world receipts. A standalone Worker runs the official
isolated reducer. There is no training API, client-supplied outcome, or persisted
save. BattleTrace alone does not replay world interactions; no replay/restore UI
is offered until the combined world command protocol is implemented.

The approved implementation scope covers independent adventure modules and the
default-off engine integration seams. Independent review requires an additional
participant filter in `lib/game/triggers.ts`: only the active encounter's pieces
may originate combat triggers. This is necessary to implement the user's rule
that a participant's outside pieces may only approach the encounter. The scoped
filter and regression tests leave default PVP unchanged. Scope and detailed review
records remain local after automatic approval review rejected their transmission
to Linear; this does not expand external transmission authorization.

Current boundaries: two fixed allied templates (Tracer/Uther), two Reaper core
encounters, one active encounter, no fog/multiplayer/save/mod distribution. All
initial pieces are cores under existing full-roster loss rules. Clear the outpost
before entering the final core region. Only the versioned adventure mode exempts
the global 40-round PVP limit. Encounter cleanup restores the supported roster's
initial incarnation plus explicitly recorded camp upgrades, retains wounds and
clears encounter-only cards/Recall data. Forced boundary violations reject the
whole transaction rather than implementing the proposed displacement truncation.

Review regressions: detouring to the ford while supporting; Recall after clearing
an encounter; casting buffs across a boundary; outside passive damage into the
encounter. Validate formal results and unchanged state after rejected commands.

Rollback: remove the adventure entry and modules and revert the default-off engine
seams. No existing save format, PVP room protocol or dependency is migrated.

## Captain/reserve revision, 2026-09-09

User explicitly confirmed 3 exploration AP, 1 AP encounter start, free deployment
once per own turn around the captain, and 1 HP captain revival after victory.
Risk remains High. Base remains main / 12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441.
The necessary local scope now includes lib/game/turn.ts in addition to the existing
adventure boundary, setup, runner, terminal, session, Worker, page and tests.
Linear transmission was rejected by automatic approval review for exceeding the
earlier external-write authorization; this contract extension and evidence stay local.

AdventureBoundary.party is the versioned single authority for captain ID, reserve
pieces, last captain position, encounter round and monotonic deployment revision.
Native next-player transitions allocate AP; outside this optional extension PVP is
unchanged. Entry completes its native movement before encounter AP initialization.
Terminal checks include living adventure reserve cores. Accepted reducer commands
update the captain anchor, including a death recorded in the graveyard/removed list.

The native deployReservePiece action checks expectedDeploymentRevision, action
phase, owner, one deployment per turn and legal cells. It reuses the formal summon
transaction (before/after triggers and crystal collection) and charges no AP.
Reserve rule effects are retained through safe clones and removed from public
serialization. UI consumes authoritative cells, reserve pieces and revision.
Camp interaction still requires a nearby living board actor; targetPieceId may
select a living owned reserve for numerical upgrades without deploying it.

Victory restores supported initial incarnations plus recorded camp upgrades,
retains living wounds, recalls surviving noncaptains and revives only a dead captain
at 1 HP. Loss does not revive. Deployment revisions do not reset between encounters.
This is still one fixed-roster single-player encounter at a time; multiplayer join,
reinforcement waiting/protection, arbitrary roster support and persistence remain out
of scope. The combined world-command replay limitation above remains unchanged.

Required acceptance: independent encounter AP and cap, zero-AP free deployment,
illegal/stale commands leave state unchanged, captain-death deployment, true final
core victory, injury/upgrade retention, reserve camp services, normal loss, native
PVP/practice/team/page regressions, typecheck, lint and real browser interaction.
