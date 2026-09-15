# Same-map adventure single-player implementation

## 2026-09-10: three-act expansion and roaming encounters

User requests both movement and site interaction on occupied special cells, unmistakable combat boundaries, larger arenas/maps, stronger IP enemies, visible rewards, at least five first-act encounters, both following acts and pursuing roaming enemies with kill rewards. This explicitly authorizes implementation of the extended single-player framework and configurable encounter numbers/economy defaults. Risk High: campaign transitions, rewards and encounter authority. Existing restrictions on new Linear transmissions remain; latest user scope supersedes the older one-act implementation limit. This amendment remains local.

base_branch: main; base_sha: 53c2c9ca3eef73d2158645b93138e242c225c604 (fresh fetch succeeded). Working checkpoint ea84269a122f5219df25da1c60d62ce702e0306d is ahead 1 / behind 2; check:main-baseline reports BEHIND_MAIN. Do not rewrite the uploaded Draft branch or claim release readiness.

Allowed paths: lib/pve/roguelike/**, lib/pve/contracts/roguelike-content-v1.ts, lib/game/adventure-boundary.ts, terminal.ts and skills.ts (mode-gated enemy encounter summon uniqueness; player/PvP uniqueness unchanged); data/pve/roguelike/adventure.json, data/pieces/pve-*.json, necessary PVE skills; native adventure page JS/CSS, adventure-only battle input and battle-renderer-3d decorations; corresponding tests, generated runtime engines and product/technical/QA documents. No dependency updates, changes to core RNG algorithms, PvP rules, old save migration, multiplayer implementation, merge or release.

Implementation: three 64x64 authored landmark layouts, five encounters per act, larger 16x16 arenas, seeded generation retaining reachability. Native moves remain authoritative. Clicking an occupied facility selects the pawn; a distinct nearby action opens its site dialog. Pursuers move with public plans during exploration and trigger a bounded encounter when close, then use existing enemy programs; defeated roaming enemies award coins once. Cleared final encounter unlocks an on-map exit to the next act. Preserve run coins, recruited pieces, wounds, upgrades, relics, growth and retained cards; replace only the map/act encounter state. Defeat never advances the act.

Acceptance: occupied-cell selection + repeated movement + optional site action; visible ground-aligned boundaries; three valid/reproducible maps and five encounters each; transition requires cleared encounters/exit proximity/resolved choices and preserves run state; predictable roam movement and combat with no enemy AP, no off-map/blocked moves, no duplicate kill reward; fixed and final encounter reward display; PVE suites, adjacent native tests, lint/types/build/encoding and browser verification, independent review. Rollback these additive optional campaign/roaming fields, modules and UI changes to ea84269; do not touch old PVE/PvP data or saves.


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

### 冒险准备与合作存档（实现中）

`adventure.html` 使用既有木桌、纸页与动漫角色画像，提供六套初始队伍、返回主页、单人出发、创建/加入四人房间和存档列表。初始队伍来自资源包 `builds.json`；服务器按流派 ID 解析棋组，不接受客户端任意角色列表。换队取消准备，房主等其他玩家准备后开始。未开局离开释放席位；房主离开准备房时移交给剩余玩家。

合作冒险由 Colyseus `adventure` 房间持有完整状态，通过 PostgreSQL 保存带版本的检查点。检查点使用规范 JSON 哈希，兼容 JSONB 键顺序变化。保存仅允许所有战区及奖励结算后的稳定边界；资源身份必须匹配。多人增加敌方援兵和首领生命，系数为可调整的资源包配置，尚未进行平衡验收。

验证：112 项冒险及真实 SDK 测试通过；涵盖准备门槛、改队清准备、房主保存、重开房读档、规范化哈希和独立战区。引擎构建、相关 ESLint、编码检查通过。全仓类型检查仍受既有 `electron-editor/content-pipeline-worker.ts:8` TS2345 阻碍。浏览器已检查准备页与角色画像；数据库与完整联机浏览器验收仍待完成，不应把该状态标记为可发布。

### 公共资源与房间发现

探索三幕的源地图现在存放在 `data/maps/adventure-act-{1,2,3}-v1.json`，加入公共地图 manifest，并标记 `availability: { modes: ["pve"], status: "ready" }`。冒险源配置只保留地图 ID；读取资源包时解析引用，运行态与存档保留生成后布局。旧内嵌地图格式继续兼容。首版共享地图须使用标准 . # C O 图例，其他地形语义会明确拒绝，不会静默忽略。

PVE 怪物、技能、卡牌继续存放在公共 pieces/skills/cards 目录，使用同一可用模式元数据；拉法姆标为仅 PVP，招募候选与实际初始化均检查模式。地图登记、缺失引用、模式及布局校验纳入资源包闭合验证。

PVE 大厅复用同一个 Colyseus 服务与 `/rooms` 发现入口，通过 `?mode=pve` 读取冒险房间 metadata。默认 PVP 查询保持原行为。摘要仅含房间状态、人数和队伍资料；全员离线房间隐藏，缺席席位可申请接管。房间规则类仍按模式分离，避免把探索回合和 PVP 对局状态混用。

### 地形生成 terrain-regions-v1

按用户确认实现开阔地、街巷、废墟和峡道四类算法地形，采用带随机偏移的区域中心划分区域，再生成院墙出入口、断墙掩体及弯曲峡道。三幕通过 terrainProfile 分别偏向 streets、ruins、fortress。地形使用独立的派生种子流；已有 landmark-routes-v1 资源继续走原路径。

战区也生成地形，不再复制空白基础战场。地标和敌方阵容布置后开路，保证事件、出生点、巡逻怪和区内敌人可达；无法从营地到达的探索地格，以及无法从战区入口到达的内部地格，转为掩体，避免多人出生/回归选中封闭院落。存档保留已生成布局，不重生成旧局。

验证：14 文件、114 项冒险测试通过，覆盖三幕多种子可达性、密度、确定性、资源包与旧模式回归；相关 ESLint 和冒险引擎构建通过。类型检查仍只有既有 editor TS2345。已刷新本地预览资源并打开 seed=42 的实际原生棋盘确认地形表现。

### 招募池扩充

原配置仅有4名角色，每次抽3名，在固定种子下同一地点候选必然重复。现将正式招募池扩至33名，每个地点仍按种子与地点ID无放回抽3名。排除仅PVP角色、PVE敌人，以及当前不支持中途招募的玩家级开局规则/渐进部署角色。既有存档候选保留，新开局读取扩充配置。

26项招募与资源包测试通过，包括32个种子的候选差异、单组不重复、相同种子复现及33名候选全部可构造。此验证不代表所有技能组合已完成实战平衡验收。独立只读审查未发现本轮配置或引用阻断。已刷新本地预览资源缓存。

### 行动结算后跟随队长

PVE 镜头聚焦缓存加入权威 revision，每次行动/结算提交后定位到己方队长当前位置；同一 revision 的重复 UI 渲染不抢占手动拖动视角。队长不在场时不强制定位。仅修改冒险 UI，不修改 PVP 相机行为。14 项 world-ui 测试通过，相关 ESLint 通过；独立审查确认同地图表现队列不会覆盖聚焦。


### 2026-09-11 可选战斗与敌人压力调整

每幕保留五处遭遇：两处普通可选据点、两处可选精英、一处必需首领。可选据点不要求顺序，可跳过；击败本幕首领后即可前往下一幕。普通战斗提供卡牌与金币；精英提供遗物候选，每位玩家整个三幕流程最多领取一件奖励遗物，初始配套遗物不计入。领取计数随玩家成长账本保存并跨幕保留。

增加《魔兽世界》憎恶（相邻范围横扫）、《我的世界》凋灵骷髅（近身追击）、《星球大战》帝国冲锋队员（远程射线）。资源仍存入共享棋子、技能、图像目录并标注仅 PVE 可用。精英初始生命乘 1.5、攻击加 2；多人首领生命在包含精英强化的初始化基线上计算，不重复累乘。

敌人可以提前宣布移动后攻击的完整序列。玩家占据预告路径或落点时，敌人停在阻挡前最后一个空格；后续攻击从实际停点按原预告方向执行。第一格就被挡住则原地出招。追魂斩明确锁定目标，可追踪位置；普通攻击不更换方向。攻击范围与移动路线均提前展示。取消选择及重置视角优先聚焦正在进行的战区，探索时聚焦队长；权威取消回执后再次落实该焦点。


#### 同日追加：敌人机制

- 憎恶：奇数轮可使用4格弹射物肉钩，命中后将目标拉向身前，途中受占位与地形阻挡则停下；相邻目标使用横扫。
- 凋灵骷髅：偶数战斗轮锁定4格内目标发动追魂斩，结算时无视距离与阻挡；目标离场则失效，正常伤害结算仍生效。
- 帝国冲锋队员：爆能射击与回合外警戒射击。玩家移动后若停在四方向5格内且射线无阻挡，触发警戒伤害，每个玩家回合最多一次。
- 直接进入冒险的默认队伍同步为猎空＋安娜。
- 憎恶使用新绘制的纸面手绘插图；冲锋队员插图因图像服务两次拒绝暂未生成，保留现有图标。


### 敌人下一次技能提示

敌人详情顶部与据点敌人列表读取权威 world.plans，按该棋子的预告顺序显示技能名，例如“下次行动：移动 → 横扫”。技能列表突出“即将使用”的技能，其他主动技能标“本轮不使用”，被动标“条件触发”；无预告时不预测技能。锁定攻击追加锁定标记。联机友方棋子保持原技能显示。16项world-ui测试与HTML内联脚本语法检查通过。此次未修改敌方决策与战斗结算。远端fetch因GitHub连接失败未刷新，未提交或推送。


### 世界回合敌人成长

每完成10个世界回合，场上存活且未进入战区的敌人提升一级：生命上限增加基础生命的20%（向上取整），攻击+1。等级1为初始等级，10回合结束后升至等级2。精英初始强化计入生命基线，不复利；增加生命额度但保留已有伤势，死亡棋子不复活。当前所有战区的敌人冻结，不改变已发布预告对应的强度。联机按共同世界轮次计算，与人数无关；跨幕保留完成轮数，存档保存各怪物已应用等级，防止重复升级。资源包根配置enemyGrowth支持调整间隔与增量。详情显示等级。


### 卡牌计数与阵亡预估

当前可用的四张PVE伤害牌在牌面只显示实时威力和简短效果，右键/长按详情显示同名成长加值与完整说明，构筑面板集中展示基础值、成长与当前值；敌人详情显示本场受你方被动命中的次数。adventurePower声明由执行与投影共同读取，牌面威力不包含目标防御/护盾和施放者增减伤。未启用的设计卡没有伪造可执行预览。

权威快照以独立副本执行已公布的敌方计划，计入原生防御、阻挡、钩拉与追踪等效果，输出预计剩余生命和阵亡标记。只推演当前公开行动，不替玩家作出后续选择，不预演回合结束效果或尚未触发的警戒射击。需要额外选择/无法完成时明确提示预测不可用，不给出必死断言。结果按revision缓存；同一状态的联机查看者共用预测，各自卡牌计数分开，返回时复制避免污染缓存。


### 手牌与棋子提示可读性
PVP/PVE 共用加大的手牌，取消描述行数截断；过长规则可在牌内滚动，右键详情仍保留。冒险部署头像支持右键查看完整棋子详情，不能部署时仍可查看。预计阵亡显示在棋盘棋子的血量标记旁，随棋子移动；移除部署区重复警告，历史画面不显示当前预测。
