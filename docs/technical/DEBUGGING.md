# 调试与故障复现

状态：RED-9 基线草稿

基线提交：`594977b`
目标链路：LAN Windows/Electron + Android；两端均可开服或加入

本文供下一项“恢复运行基线”任务直接执行。RED-9 不要求现在运行这些命令或一次解决全部缺口。

## 1. 当前基线声明

项目负责人确认：当前提交作为正式基线，但最后一版出现重大问题且尚未定位。`BUILD_AND_RUN.md` 为空，因此当前没有经过验证的安装、启动、测试和打包步骤。

这意味着：

- 本文不能声明项目可以成功启动或打包。
- RED-9 的静态代码结论不等于运行验证通过。
- 第一项后续任务必须重建运行基线并保存证据。
- 在故障定位前，不升级依赖、不改规则、不删除历史生成物。

## 2. 当前可用入口

根 `package.json` 声明：

- `npm run dev`：Next 开发服务。
- `npm run dev:electron:server`：Electron 服务端管理器。
- `npm run dev:electron:client`：Electron 玩家客户端。
- `npm test`：Vitest 单次运行。
- `npm run lint`：ESLint。
- `npm run build`：Prisma、Tailwind、Next standalone 和静态资源。
- Android 构建：根脚本中的 `build:game-engine`、`build:mobile-server`、`build:android` 等。

这些是“清单中存在的命令”，不是“已验证可用命令”。RED-9 检查时本地没有 `node_modules`，未安装依赖，也未运行测试或构建。

## 3. 稳定运行基线的建议验证顺序

后续独立 Linear 任务应按以下顺序执行并逐步停止在第一个失败点：

1. 记录 Windows、Node、npm、Java、Android SDK 和 Electron 版本。
2. 从锁文件安装根依赖，保存完整安装日志。
3. 运行 Vitest。
4. 运行 ESLint。
5. 增加并运行显式 TypeScript 检查；当前 Next 构建会忽略 TS build errors。
6. 启动 Next/WS，调用只读状态端点。
7. 启动 Electron 服务端，记录端口、子进程和窗口状态。
8. 启动 Electron 客户端并完成加入房间冒烟流程。
9. Android 加入 Windows 房间。
10. Android 开服，Windows 客户端加入同一房间。
11. 同一设备同时运行服务端与客户端，确认本机玩家仍走公共命令协议。
12. 从全新临时输出目录构建 Android，记录生成物 hash 和安装结果。

不得为了越过某一步而同时修改多套配置。每个失败点都应保存命令、退出码、日志和 commit。

## 4. 最小问题报告

每次 Bug 至少记录：

```text
commit/build:
运行模式: Electron server / Electron client / Android
设备与系统:
roomId:
playerId/seat/faction:
回合与阶段:
seed:
最后一个 clientActionId:
复现前状态 hash:
命令或点击序列:
预期结果:
实际结果:
复现后状态 hash:
服务端日志:
客户端日志:
截图/录屏:
复现次数:
```

如果 seed、状态或 action ID 取不到，应写“当前系统未提供”，不能省略或猜测。

## 5. 按层定位流程

### 玩家点击无响应

1. 在 `battle.html::doAction()` 确认动作是否生成。
2. 确认当前 transport 是 LAN WS、HTTP、Relay 还是 local engine。
3. 检查消息是否包含 room/player/action ID。
4. 在 `ws-server.ts` 或房间 API 确认接收。
5. 在 `runBattleAction()` 比较输入/输出 hash。
6. 确认 `RoomStore.setRoom()` 成功。
7. 确认 `stateUpdate` 广播并进入 `applyServerState()`。

### 对战页永久停留在“连接战场…”

`battle.html` 的“连接战场…”是脚本执行前的静态初始文案。正常初始化会先把它改成“加载本地资源...”，再连接战场；如果初始文案始终不变，应先检查页面脚本是否解析或执行失败，而不是直接归因于 WebSocket。

先运行战场页源码回归：

```powershell
npm run test -- tests/electron/battle-page-runtime.test.ts
```

该测试会解析所有内联脚本、拒绝 CSS 块中的 HTML 节点、检查实际 DOM 的重复 `id`，并确认终止初始化错误会停止加载动画。真实 Windows Electron 冒烟测试还会直接打开缺少 room/player 参数的战场页；预期显示红色错误，且 spinner 为隐藏状态。

### 状态在 Electron 与 Android 不一致

1. 确认两端连接同一个 roomId 和服务端。
2. 比较最后收到的服务端 state hash。
3. 如果 hash 相同但画面不同，问题位于客户端渲染/资源版本。
4. 如果 hash 不同，检查消息丢失、动作重复、客户端是否进入 Relay/local 分支。
5. 记录两端 `game-engine.js` hash，检查 Android 是否使用旧生成物。

### 相同操作结果不同

1. 保存初始状态 JSON、`_v`、seed 和动作序列。
2. 搜索该路径上的 `Math.random()`、`Date.now()` 和模块级缓存。
3. 用 `replayBattle()` 执行两次并比较每一步 hash。
4. 若核心回放一致而 UI 不一致，检查客户端胜负、目标过滤和本地 dry-run。
5. 若核心回放不一致，检查 RNG 注入、动态效果代码和全局触发器。

### 目标高亮与提交不一致

1. 保存动作草稿、`selectionId`、`stateRevision`、步骤和完整候选数组。
2. 比较提交时的 `BattleState.targetingRevision`；不同则应稳定返回 `TARGET_SELECTION_STALE`，不得尝试旧候选。
3. 重复提交或取消已经结束的会话应返回 `TARGET_SELECTION_ALREADY_RESOLVED`；错误 ID 返回 `TARGET_SELECTION_ID_MISMATCH`，两者都不得产生新日志或推进 revision。
4. 对候选和提交分别记录 source action/card/skill ID、source piece、owner player、filter、range 与目标引用。
5. 确认 UI/AI 只消费 `prepareAction()` 结果，`skill-targeting.js` 没有执行效果或 reducer。
6. 在 20x16 fixture 上运行 `tests/game/targeting.test.ts`；预期 320 格扫描、0 次 reducer 执行，且 fixture hash 不变。

### 新格式存档读取后行为改变

1. 保留原始存档副本，不在原文件上测试。
2. 记录存档 `protocolVersion`、格式版本、规则/数据 hash、server ID 和 match ID。
3. 记录 `BattleState._v` 和数据库修订号，两者含义不同。
4. 比较保存前后关键字段，特别是回合、棋子、资源、pending selection、`currentTurnIndex` 和 `actions`。
5. 验证动作序号、hash 链、玩家签名和服务端任期签名。

公开测试前旧存档不要求兼容，不应为它们编写静默迁移；新存档一旦发布才进入兼容承诺。

## 6. 当前日志现状

- `turn.ts`、`skills.ts`、`triggers.ts`、`battle-setup.ts` 分别维护日志代码。
- 日志可能写 `game.log`，Electron/Next/浏览器还各用自己的 console。
- 当前日志经常缺少 roomId、seed、action ID、前后 hash 和错误栈。
- 代码中存在空 `catch {}` 和阶段性 `[STAGE*]` 日志。
- mobile 生产构建会禁用一部分 console 输出。

因此“没有日志”不能证明流程没有发生，“看到 stateUpdate”也不能证明各端使用了相同资源和相同状态。

### 6.1 Electron 子服务日志转发断管

Electron Server 与 Electron Client 把内置子服务的 stdout/stderr 转发到宿主标准流。宿主
关闭管道时，主进程输出一条 `[electron:child-log-forwarding]` 结构化诊断，字段包括：

- `event: electron.child-log-forwarding.error`
- `runtime: electron-server | electron-client`
- `stream: stdout | stderr`
- `side: source | target | write`
- `code`、`message`、`recoverable` 与 `action`

`code: EPIPE` 的唯一恢复动作是 `action: stop-forwarding`：停止对应 stream 的后续转发，
不重试、不重复报告，也不终止 Electron 主进程。其他错误使用 `action: report-error`，并
继续进入 unexpected-error 诊断；子进程自身的启动、`error` 与 `exit` 反馈路径保持不变。

## 7. 统一日志愿景

后续建议所有关键操作使用同一结构：

```ts
interface GameLogContext {
  build: string;
  runtime: 'next' | 'electron-server' | 'electron-client' | 'android';
  roomId?: string;
  playerId?: string;
  turn?: number;
  phase?: string;
  seed?: string;
  actionId?: string;
  actionType?: string;
  beforeHash?: string;
  afterHash?: string;
}
```

错误还必须包含稳定错误代码、message、stack 和 cause。该结构是愿景，不在 RED-9 实现。

## 8. 现有调试接口

`app/api/debug-battle/route.ts` 支持创建 duel、执行动作、回放、identity/selection/loopback 场景。它是最接近无 UI 调试 harness 的现有入口。

注意：部分模式会创建或修改数据库房间，不能视为只读端点；调用前必须使用隔离数据库或明确测试房间。

`lib/game/debug-battle.ts` 可以用固定 seed 创建调试对局并生成状态 hash，测试入口为 `tests/game/debug-battle.test.ts`。

### RED-94 公开局外 Trace 回放与规则调试器

- 页面入口：主菜单“开发者中心”打开 `data/pages/developer-tools.html`；导入成功后由 `data/pages/replay.html` 提供独立只读回放。
- 局内门禁：两个页面通过 `RvBDeveloperTools.readActiveBattle()` 检查 `rvb_active_battle` 并 fail closed。该标记是产品门禁，不承担服务端授权；真正的数据边界是进行中公开投影删除完整 action trace、applied action IDs 和 replay archive。
- 隔离边界：固定 seed 场景仍只调用 `createDebugDuel()` 与正式 `runBattleAction()`，不接受 roomId、不创建/读取房间、不发奖励、不写统计。它是开发者中心的次级工具。
- Trace v2：`recordBattleInitialization()` 保存脱敏初始检查点和所用技能的最小展示定义；正式 Runner 只在成功动作后追加命令、可物化的命令后检查点、语义事件、随机流游标与双 hash 链。地图不变时以 `inheritsMap` 继承，累计 actions 不重复进入检查点；重复或拒绝动作不追加。
- 终局导出：只有权威 `terminalResult` 提交后的公开投影携带完整脱敏回放归档。`battle.html` 在终局生成 `rvb-match-trace/v2`、立即下载并保存最近一场。
- 记录状态回放：回放器先继承上一检查点的不变地图，物化当前帧完整 postState，再验 hash 和展示；不调用当前 `runBattleAction()` 或规则数据重算历史。增加角色/规则后，旧 Trace 依赖展示快照和稳定 ID 降级，而不是产生新的比赛结果。
- 展示复用：`replay.html` 复用正式 `BattleViewModel`、`BattleRenderer3D`、状态展示和战术几何。棋盘覆盖整个视口；帧摘要、底部时间轴/播放控制和按命令/棋子/事件/变化/完整性分组的可折叠检查器作为浮窗。棋子页展示记录时技能定义和该帧的当前冷却、剩余次数、充能与解锁状态。
- 导入安全：`match-trace.js` 把文件视为不可信输入，限制 32 MiB、深度、节点、数组和字符串预算，拒绝危险键、敏感字段、外部/脚本 URL、版本不符和 hash 链篡改。失败导入不覆盖最近有效记录；导入文本只进入文本节点。
- 本地存储：最近一场 v2 以 IndexedDB 为主，受限环境才回退 localStorage；回放页不使用 fetch、WebSocket、房间动作、奖励或统计接口。
- 旧格式：`rvb-match-trace/v1` 没有完整状态检查点，只能作为历史诊断证据，导入时明确提示“旧诊断格式，无法回放”。
- 详细合同与人工步骤：`docs/qa/RED-94-developer-tools.md`；格式决策：`docs/decisions/ADR-0016-trace-v2-recorded-state-replay.md`。

## 9. 当前测试缺口

- Electron 启动和退出。
- Next/WS/Prisma 集成。
- Android 与 Electron 同房状态一致性。
- Android 资源来自当前源码的校验。
- 新格式存档、签名动作链和加密 envelope round-trip。
- 权威胜负结果。
- 多房间全局触发器隔离。
- 完整固定 seed 对局。
- Relay 与 LAN 行为差异。

## 10. 最高优先级调试任务

1. **运行基线**：确定工具版本并找到当前重大故障的第一个失败点。
2. **统一上下文**：为启动、连接、动作、持久化和广播添加关联 ID 和错误栈。
3. **状态导出**：服务端导出脱敏状态、seed、action trace 和 hash。
4. **Android 来源校验**：构建产物写入 commit/hash，启动时可查看。
5. **固定种子回归**：同一初始状态和动作序列在 Node/Android 引擎得到相同结果。

长期的端到端加密、密钥恢复、服务端迁移/撤销、规则沙箱和公开回放安全测试应拆分为 High Risk 任务，不作为恢复当前运行基线的前置条件。

每项都应单独建 Linear 任务、独立分支、测试证据和人工批准。

## 11. Windows Electron 同机双客户端验收

网页玩家端已移除。`http://127.0.0.1:3000` 是服务端状态/API 页面，不能用于玩家账号或双玩家验收。Windows 玩家必须使用 Electron 客户端。

开发模式可使用命名 profile 启动两个隔离客户端：

```powershell
npm run dev:electron:client -- --rvb-dev-profile=player-one
npm run dev:electron:client -- --rvb-dev-profile=player-two
```

开发模式的 `rvb-client://app/` 会从 `data/pages/` 提供页面，并把允许的
`data/**/*.json` 请求映射到仓库 `data/`；页面内不存在的允许图片会从 `public/`
回退读取。进入棋子选择页前可在 DevTools 执行
`fetch('./data/pieces/manifest.json').then(r => ({ status: r.status, url: r.url }))`；
预期 `status` 为 `200`。资源包中的同名文件仍优先于仓库内置数据，打包客户端仍只读取
候选包内的 `app/www`。

仓库内置 SVG 可以从 `public/` 回退读取；可激活资源包仍只允许 JSON 和安全光栅图片，不允许 SVG 覆盖。

两个命令应在不同终端运行。profile 名称只允许 1–32 个 ASCII 字母、数字、连字符或下划线，且必须以字母或数字开头。每个 profile 的 `userData`、Chromium localStorage、身份与单实例锁均位于默认 `userData/dev-profiles/<profile>` 下：不同 profile 可同时运行，同一 profile 仍保持单实例。

开发版 Electron 直接读取 `data/pages/`，无需先把玩家页面同步到 Android 生成目录。打包客户端仍读取构建流程生成并装入安装包的 `app/www`。

人工验收顺序：

1. 在两个客户端分别打开玩家首页；确认不是服务端状态页。
2. 在开发者工具执行 `({ secureContext: window.isSecureContext, hasSubtleCrypto: !!window.crypto?.subtle })`，两项都应为 `true`。
3. 两端分别设置不同玩家名称，右上角应立即显示名称。
4. 关闭并用相同 profile 重启，名称应保留；两个 profile 的名称与身份 ID 应不同。
5. 两端连接同一个 Windows 服务端，完成建房、加入与进入对局。
6. 不带 profile 参数重复启动客户端时，第二个实例应退出并聚焦第一个实例。

`--rvb-dev-profile` 仅允许源码开发模式使用。打包客户端传入该参数会拒绝启动，正式 `userData` 和默认单实例行为不会改变。账号初始化失败时，首页右上角显示“账号错误”；点击后可在账号面板查看错误，并在开发者工具中查找带 `[identity]` 前缀的日志。

### Windows 源码工作树验收前置检查与 AI 引导护栏

本次人工引导暴露了以下错误操作，后续 AI 不得重复：

- 未先确认 Windows PowerShell 的命令解析方式，直接提供了可能命中受限 `npm.ps1` 的 `npm` 命令。
- 未先执行 worktree 环境预检或检查本地依赖，就要求启动 Electron，导致缺少 `node_modules` 后才补救。
- 未先确认 Electron 服务端要求 Next.js standalone 产物，就要求启动服务端，导致缺少 `.next/standalone/server.js` 后才补救。
- 未在调用调试房间 API 前确认本地数据库 migration 状态，导致请求进入缺少 `Room` 表的数据库。
- 建议执行 Prisma migration 时没有同时给出 Electron 实际数据库的会话级 `DATABASE_URL`，导致 Prisma CLI 再次失败。
- 后续只要求“重新创建 `$red73Room`”，没有重新提供变量定义和完整请求，使人工必须猜测上一段上下文。
- 在给出下一条命令前没有先读取预检输出、仓库脚本和实际运行路径，形成了报错后逐项猜测的低效引导。

在独立 Git worktree 中进行 Electron 人工验收时，必须先完成下面的前置检查，再让人工启动窗口或调用调试 API。不得根据报错逐项猜测环境，也不得省略变量的完整定义后只要求人工“重试上一条命令”。

本流程在 Windows PowerShell 中统一调用 `npm.cmd` 和 `npx.cmd`。不要直接调用 `npm` 或 `npx`，因为 PowerShell 可能优先解析到被执行策略禁止的 `npm.ps1` 或 `npx.ps1`。不得为了运行 npm 建议修改系统级 ExecutionPolicy。

从一个全新的源码 worktree 开始时，按以下顺序执行：

```powershell
Set-Location 'C:\path\to\worktree'

# 1. 每个 worktree 必须安装自己的本地依赖。
npm.cmd ci --foreground-scripts

# 2. Electron 服务端预检要求 Next.js standalone 产物存在。
npm.cmd run build

# 3. 开发版 Electron 服务端使用当前 worktree 的 prisma/dev.db。
#    Prisma CLI 不会自动获得 Electron 子进程设置的 DATABASE_URL，
#    因此 migration 前必须在当前 PowerShell 会话显式设置同一路径。
$qaPrismaDir = (Resolve-Path '.\prisma').Path
$env:DATABASE_URL = 'file:' + ((Join-Path $qaPrismaDir 'dev.db') -replace '\\', '/')
npx.cmd prisma migrate deploy

# 4. migration 成功后再启动服务端和两个隔离客户端。
npm.cmd run dev:electron:server
npm.cmd run dev:electron:client -- --rvb-dev-profile=player-one
npm.cmd run dev:electron:client -- --rvb-dev-profile=player-two
```

服务端和两个客户端命令必须分别在独立终端运行。`npm audit` 报告不属于功能验收前置条件；不得在任务未授权依赖升级时执行 `npm audit fix --force`。

创建固定种子的双客户端调试房间时，必须提供完整、可复制的命令，不能假设调用者仍保留上一个终端会话中的变量：

```powershell
$qaRoomBody = @{
  mode = 'create-loopback-room'
  seed = 2173765951
  first = @{
    alignment = 'dark'
    templateIds = @('kiljaedan')
  }
  second = @{
    alignment = 'light'
  }
  piecesPerPlayer = 8
} | ConvertTo-Json -Depth 5

$qaRoom = Invoke-RestMethod `
  -Method Post `
  -Uri 'http://127.0.0.1:3000/api/debug/battle' `
  -ContentType 'application/json' `
  -Body $qaRoomBody

$qaRoom | Select-Object roomId, seed, stateHash
$qaRoom.urls
```

如果 API 返回 HTTP 500，应先读取响应体和服务端堆栈，不得直接建议重建、删除数据库或改动 schema。常见的 `The table main.Room does not exist` 表示 migration 尚未应用到 Electron 实际使用的 `prisma/dev.db`；应停止服务端、设置上面的会话级 `DATABASE_URL`、执行 `prisma migrate deploy`，然后重启。

如果 `prisma migrate status` 显示已是最新，但运行时代码仍报告 P2022、缺少当前 `schema.prisma` 已声明的列，说明仓库 migration 历史落后于 schema。仅对可丢弃的本地开发数据库，可以在停止服务端并确认路径后执行 `npx.cmd prisma db push`；不得把这一做法用于生产或持久数据，也不得未经明确批准添加 `--force-reset` 或 `--accept-data-loss`。同时应记录缺失 migration 的基线问题，不能把 schema drift 误判为当前功能修改引入。

本次 RED-73 人工验收实际遇到的 `Room.spectators` 缺列即属于上述基线 drift；只同步本地 QA 数据库，不修改仓库 schema 或 migration 文件。

## 大厅重新加入入口验证（RED-58）

Windows Electron 大厅只会在本地 `rvb_active_battle` 结构完整、服务端房间仍处于对战状态，且保存的玩家仍属于该房间时显示“重新加入”。可按以下步骤复验：

1. 无记录：在大厅开发者工具执行 `localStorage.removeItem('rvb_active_battle')` 后刷新；预期不显示重新加入横幅。
2. 有效记录：进入一场真实对局并返回大厅，保留该对局写入的 `roomId`、`playerId` 和 `playerName`；预期横幅显示，点击后进入对应 `battle.html`。
3. 失效记录：结束或删除服务端房间后再次打开大厅；预期横幅不显示，本地记录被清理，并在页面状态提示和控制台 `[lobby:rejoin]` 日志中说明记录已失效。
4. 损坏记录：执行 `localStorage.setItem('rvb_active_battle', '{broken')` 后刷新；预期记录被清理、横幅隐藏，并显示“保存的对局信息无效”。
5. 空状态点击：在开发者工具执行 `rejoinBattle()`；预期显示“没有可重新加入的对局”，不得静默无响应。

如果服务器暂时不可达，入口保持隐藏并显示验证失败原因，但不清理本地记录；恢复连接后刷新大厅重新验证。

## RED-109 权威延迟与恢复诊断

候选客户端会把最近 200 条精确回执样本保存在 `window.__RVB_AUTHORITY_PERF__`：

```js
window.__RVB_AUTHORITY_PERF__.summary()
window.__RVB_AUTHORITY_PERF__.clear()
```

每条样本包含客户端发出到精确回执应用的 `totalMs`、`clientApplyMs`，以及服务端提供的 `queueMs`、
`rulesMs`、`persistenceMs`。async journal 模式的 `persistenceMs` 只表示内存提交和日志入队，不包含
后台 Prisma 完成时间。快照/Transition 另带 `durableAuthorityVersion` 与 `persistenceStatus`；先用这些字段判断瓶颈，再检查网络与客户端渲染；不要用按钮动画或主观等待
代替精确 ID 样本。

- `queueMs` 高：同房间有慢命令或事件积压；检查队列 active/pending 和 timer/bot 命令。
- `rulesMs` 高：检查是否误设 `RVB_FORCE_RULE_RELOAD=1`、是否存在未缓存动态规则或异常候选枚举。
- `persistenceMs` 高：检查内存 clone/diff/hash 和日志背压；async 模式不应包含 SQLite 等待。
- `persistenceStatus=pending`：在线版本已经确认，后台 durable 水位尚未追上；若带 `lastError`，表示
  writer 正在保留队首 job 并从 SQLite/Prisma 瞬时锁或超时中恢复。记录版本差值和错误，但不要重发动作。
- `persistenceStatus=degraded`：确定性审计/hash/版本错误、约束/损坏/I/O 或队列溢出。立即保留 roomId、
  在线/耐久版本、`lastError` 和 Prisma 日志；不要把已应用动作重发成新 ID，房间会暂停新动作。
- Prisma `P2028`：async 模式下属于可恢复的后台耐久故障，会保持 pending 并退避重试，不应让 ACK 延迟
  5 秒；若客户端仍卡住，先确认
  同时设置了 `RVB_BATTLE_AUTHORITY_V2=1` 与 `RVB_BATTLE_ASYNC_JOURNAL=1`。
- 长局 patch 变大：检查 Transition 的 `internalPatch` / `publicPatch` 是否出现路径仅为 `actions` 的整数组
  `set`。正常尾部日志追加应是 `actions,<末尾索引>`；若客户端反复 hash recovery，确认桌面和 Android
  `game-engine.js` 已由当前源码重建。
- 服务端低而 `totalMs` 高：检查 WS/Relay 传输、patch hash recovery 和客户端渲染。
- `resyncRequired`：同时记录客户端/服务端 `battleAuthorityVersion`；不要使用 `Room.version` 判断战斗连续性。
- `BATTLE_PATCH_*_HASH_MISMATCH` 或版本 gap：保留 roomId、from/to version、前后 hash，完整拉取一次；重复失败应停止对局并检查 checkpoint/journal，不得吞错继续。

本地数据热编辑默认不会逐动作读盘。需要验证显式失效时调用内容工具的 reload；只有针对逐次读盘的专项调试才临时设置
`RVB_FORCE_RULE_RELOAD=1`。同步文件日志默认关闭，专项排错设置 `RVB_BATTLE_DEBUG_LOGS=1`，采证后关闭。
