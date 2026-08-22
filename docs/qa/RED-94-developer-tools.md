# RED-94：局外 Trace 可视化回放与规则调试器 MVP 验收

## 目标与边界

RED-94 在公开客户端提供局外开发者中心。玩家可以导入权威终局生成的 Trace v2，在不连接房间、不重新执行当前版本规则的前提下，按命令浏览整局棋盘和调试事实。

本次包含：

- 权威战斗初始化时记录首个脱敏状态检查点，成功命令后记录命令后检查点、语义事件、随机流游标和 hash 链。
- 只有权威终局公开投影携带完整回放归档；进行中公开投影删除 action trace、applied action IDs 和回放归档。
- 终局生成 `rvb-match-trace/v2`，可立即下载，并保存为最近一场记录。
- 开发者中心支持文件选择和拖放导入；导入前把文件视为不可信输入，验证体积、结构、深度、字段、版本和完整性链。
- 独立只读回放页复用正式 `BattleViewModel` 和 `BattleRenderer3D`，支持时间轴、逐步、播放、速度、红/蓝/全知视角、镜头复位和棋子检查。
- 检查器展示当前命令、事件、关键状态差异、权威 hash、检查点 hash、随机流游标和终局结果。
- 未识别的新角色、新技能或新事件使用 Trace 自带的展示快照和通用文本降级，不调用当前规则实现。
- 原固定 seed、正式 Runner、内存隔离的双人规则场景继续作为次级工具保留。

本次不包含：

- 压缩回放码、云端分享、观战服务、视频导出或像素级镜头录制。
- 导入 Trace 后恢复房间、发送动作、领取奖励、写入战绩或统计。
- 用当前版本规则重算旧对局，或承诺 v1 诊断 JSON 可升级为可视化回放。
- 在真实进行中对局内打开或使用开发者工具。

风险等级：High。Trace v2 是新格式，涉及终局公开投影、本地持久化和不可信文件导入；不变更游戏数值、胜负、随机算法、数据库或存档格式。

## Trace v2 事实模型

- `initial.checkpoint` 保存整局初始记录状态。
- 每个 `frame` 保存一条成功命令和该命令后的 `postState`。该帧的命令前状态就是上一检查点，因此不会重复保存相邻帧相同的大状态。
- `preStateHash/postStateHash` 是权威规则状态 hash；`preCheckpointHash/postCheckpointHash` 是导出检查点的 SHA-256 链。导入器同时验证两条链。
- 每帧保存 `events` 和 `randomStreams.before/after`，检查器无需猜测状态变化原因。
- `content` 只保存回放显示所需的棋子/技能名称、描述和安全本地图片标识。缺失内容时显示稳定 ID。
- 回放器只消费记录事实，不调用 `runBattleAction()`、`applyBattleAction()` 或房间 API。

因此后续增加角色或事件不会让旧 Trace 依赖新规则重算；只要 v2 外层合同仍受支持，未知内容会降级显示。若未来必须破坏该合同，应发布新格式版本并显式迁移或拒绝，不得静默误放。

## 自动验证

从 RED-94 工作树根目录执行：

```powershell
npm.cmd test -- tests/game/debug-battle.test.ts tests/game/developer-tools-trace.test.ts tests/game/developer-tools-api.test.ts tests/game/battle-page-contract.test.ts tests/electron/developer-tools-page.test.ts tests/electron/replay-page.test.ts tests/electron/battle-page-runtime.test.ts
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npm.cmd run build
npm.cmd run check:main-baseline
```

实际结果（2026-08-22）：

- RED-94 聚焦测试：7 个文件、50 项断言通过。
- 全量 Vitest：82 个文件、647 项断言通过。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run build`：通过；保留主线已有的 Turbopack 动态文件访问警告。
- `npm.cmd run check:main-baseline`：通过；分支 Behind 0。
- `npm.cmd run lint`：在扫描源码前失败；主线 `eslint.config.mjs` 启用了 `import/no-anonymous-default-export`，但同一配置对象没有注册 `import` 插件。RED-94 未修改 ESLint 配置或依赖，需由独立基础设施任务修复。

浏览器冒烟（Playwright，loopback QA 页面）：

- 真实文件选择导入 v2 成功，摘要显示房间、地图、结果、命令数、事件数和最终 hash。
- 3D 棋盘在第 0 帧和命令后帧正确更新；逐步、时间轴、视角、镜头和棋子点击可用。
- 检查器展示生命/位置/技能变化、终局、事件、随机流以及两条 hash 链；未知事件使用通用显示。
- 网络记录只有本地静态资源，没有房间、WebSocket、奖励或战绩请求。

重点断言：

- 初始化归档和成功动作帧确定生成；重复或被拒绝的动作不追加帧，也不修改原状态。
- 真实固定 seed duel 经正式 Runner 终局后可以通过浏览器侧 v2 导出器和导入验证器。
- 相邻帧不重复保存 `preState`，但检查点 hash 和权威 hash 链连续。
- 进行中投影不含回放归档；终局投影保留完整脱敏归档。
- v1、未知版本、损坏 JSON、超限文件、超深结构、危险键、敏感字段、非法 URL 和篡改 hash 均被拒绝。
- 拒绝导入不会覆盖最近一次有效 Trace。
- 开发者中心和回放页不加载 WebSocket、不接受 roomId、不调用房间/奖励/战绩动作。
- 回放页加载正式战场展示模块，并提供全部时间轴与检查器控件。
- 回放页对导入文本只使用安全文本节点，不使用 `innerHTML`。

## 人工验证

### 1. 局外入口与进行中门禁

1. 从主菜单打开“开发者中心”。
2. 确认 Trace 导入是主功能，固定 seed 场景位于次级折叠区域。
3. 进入真实对局后再打开开发者中心，预期 Trace 导入、最近记录和隔离场景全部锁定，并显示“进行中对局”说明。
4. 检查战斗页没有开发者修改器；开发者中心没有 roomId、加入房间或发送动作入口。
5. 结束或清除过期活动标记后，工具恢复可用。

### 2. 生成真实终局 Trace

1. 完成一场真实对局，等待权威 `terminalResult`。
2. 终局覆盖层出现“下载比赛 Trace”，点击并保存 JSON。
3. 确认文件 `format = rvb-match-trace/v2`，包含 `initial`、`frames`、`final`、`content`、`integrity`。
4. 确认帧数量等于成功命令数量，第一帧前 hash 接初始 hash，最后一帧后 hash接最终 hash。
5. 搜索 authorization、signature、token、accountId、privateKey、mnemonic、password、cookie、session 等敏感字段，预期不存在。

### 3. 导入与不可信文件处理

1. 在开发者中心使用“选择 Trace 文件”导入刚下载的 v2；预期显示房间、地图、结果、命令数、事件数和最终 hash。
2. 把同一文件拖到拖放区域，预期结果相同。
3. 尝试导入旧 `rvb-match-trace/v1`，预期明确提示“旧诊断格式，无法回放”。
4. 尝试导入损坏 JSON 或手工篡改任意检查点/hash，预期拒绝并说明原因。
5. 拒绝后刷新页面，预期最近一次有效 v2 仍然存在，没有被坏文件覆盖。

### 4. 整局可视化回放

1. 点击“打开可视化回放”，预期进入独立页面，棋盘停在第 0 帧初始状态。
2. 点击“下一步”，预期棋盘进入第 1 条命令后的记录状态，命令、actor、回合/阶段同步更新。
3. 连续使用“上一步/下一步”和时间轴拖动，预期可到达任意帧，帧号和棋盘一致。
4. 点击播放/暂停，并切换 0.5×、1×、2×、4×，预期按选定速度推进，到末尾自动停止。
5. 切换全知/红方/蓝方视角并复位镜头，预期只改变展示，不修改帧或 Trace。
6. 点击棋子，预期显示名称、实例 ID、归属、位置、生命、基础属性、技能、冷却和记录状态。
7. 检查事件、差异、hash 与随机流面板；未知事件应以类型和安全字段通用展示，页面不能崩溃。

### 5. 隔离与本地持久化

1. 在浏览器网络面板回放整局，预期只有本地静态资源请求；没有房间快照、WebSocket、奖励或战绩请求。
2. 返回开发者中心，预期最近一场保留并可重新下载相同 Trace。
3. 点击“清除本地 Trace”，预期最近摘要和打开/下载按钮消失。
4. 断网后重新导入已下载文件并回放，预期除本地页面资源外不依赖服务端数据。

## 已知限制

- v1 只含诊断 action trace，没有完整记录状态，不能可靠还原棋盘，因此明确拒绝可视化回放。
- v2 默认只保留最近一场，主存储为 IndexedDB；不可用环境才降级 localStorage。
- 单文件上限 32 MiB；超长比赛可能需要后续分块/流式格式。
- MVP 保存每条成功命令后的状态，不保存每个动画毫秒或所有事件内部中间状态。
- 旧 Trace 可以显示未知角色/技能/事件，但不保证旧客户端理解未来破坏性 v3 字段。
- 镜头、播放速度和选中棋子不写回 Trace，也不恢复比赛房间。

## 回退

撤销 RED-94 提交即可恢复旧开发者中心。没有数据库迁移、规则数值、随机算法或正式存档变更。已经保存的 v2 是独立本地 JSON；旧客户端会把它视为未知格式，用户可在开发者中心清除 IndexedDB 最近记录。回退不会自动删除用户已下载文件。
