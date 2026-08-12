# 模块状态与后续路线

状态：RED-9 代码核对稿

基线：`594977b`

## 人工审查入口

项目负责人当前只需确认四句话，无需一次读完其余技术细节：

1. 当前版本作为故障基线，第一优先级是恢复真实安装、测试和启动链。
2. Windows/Electron 与 Android 的目标是都能开服和加入，并共享 JS/TS 核心。
3. 每局由当期服务端负责状态、规则和胜负；服务器可以有自己的规则。
4. RED-9 只交付代码地图和问题索引，不解决加密、迁移、规则沙箱或公开回放。

当前唯一建议进入开发的下一任务：**恢复当前版本的依赖、现有测试和 Windows Electron 启动基线，并记录第一个真实失败点。**

状态含义：

- 已核对：入口和主要调用链已与当前代码核对。
- 部分核对：可定位实现，但运行或边界尚未验证。
- 待确认：无法从当前代码或现有测试确定。
- 历史遗留：仍在仓库/发布链中，但不符合已确认方向。

## 1. 模块状态表

| 模块 | 状态 | 真实入口 | 主要问题 | 建议下一步 |
| --- | --- | --- | --- | --- |
| 核心动作归约 | 已核对/未运行 | `lib/game/turn.ts::applyBattleAction()` | 文件过大、类型重复、动态效果 | 先补规则 harness，不立即拆分 |
| 战斗初始化 | 部分核对 | `battle-setup.ts::createInitialBattleForPlayers()` | 全局触发器、seed 注入顺序 | 固定 seed 初始化测试 |
| Runner/回放 | 部分核对 | `battle-runner.ts` | 输入隐式修改、RNG 恢复问题 | 状态 trace 与纯度测试 |
| 技能/卡牌 | 部分核对 | `skills.ts` | 动态代码、模块缓存、日志分散 | 建最小技能 fixture 测试 |
| 触发器 | 部分核对 | `triggers.ts::globalTriggerSystem` | 进程级单例、并发隔离未知 | 多房间隔离测试 |
| 胜负判断 | 历史遗留 | `battle.html::checkClientGameOver()` | UI 承担规则、无统一出口 | 独立设计/迁移任务 |
| LAN WebSocket | 部分核对 | `ws-server.ts::startWsServer()` | 协议/错误无版本，空 catch | WS 集成测试与日志上下文 |
| HTTP 动作 API | 部分核对 | `rooms/[roomId]/battle::POST` | 与 WS 验证可能漂移 | 同快照双入口一致性测试 |
| Prisma RoomStore | 部分核对 | `RoomStore` | 外层无格式版本，字段读取重置 | 定义新格式并做 round-trip |
| Electron 服务端 | 未运行 | `electron/main.ts` | 最后版本重大故障、启动链复杂 | 第一优先级冒烟基线 |
| Electron 客户端 | 未运行 | `electron-client/main.ts` | 本地服务和静态资源分支复杂 | LAN 加入房间冒烟测试 |
| Android 客户端/服务端 | 正式产物/未验证 | `android-client`、`MobileHttpServer`、`mobile-server-entry.ts` | 生成物漂移；服务端外壳与 Windows 重复 | 双向开服冒烟和共享 Server Core |
| 浏览器战斗 UI | 已核对/历史遗留 | `data/pages/battle.html` | 超大跨层文件、全局 `G` | 先记录状态边界，再逐步抽离 |
| Relay | 非首要链路 | `relay-server` | 主机客户端权威 | 暂不阻塞 LAN+Android 基线 |
| Training/PVE | 非首要链路 | `app/api/training`、`app/api/pve` | 状态边界与 LAN 不同 | 基线稳定后单独核对 |
| Electron IPC | 部分核对 | preload + `ipcMain` | 字符串协议、无共享类型 | 定义协议清单和错误 envelope |
| 构建与运行文档 | 缺失 | `BUILD_AND_RUN.md` | 文件为空 | 故障定位后用真实证据补写 |
| 自动测试 | 部分存在/未运行 | `tests/game` | 无跨层、存档、胜负、Android 测试 | 恢复依赖后先运行现有测试 |

## 2. 类型状态

`BattleState`/`BattleAction` 至少在以下文件重复：

- `lib/game/turn.ts`：当前规则核心使用。
- `lib/game/battle-types.ts`：当前确认由 `lib/game/ai.ts` 导入，有效性待确认。
- `lib/game/training-types.ts`：训练模式自己的相似类型。

当前决定：全部保留并标注调用方，不宣布 `battle-types.ts` 已废弃。未来任务应先生成 import 清单和结构差异，再决定采用共享类型、适配器还是版本化协议。

## 3. 历史问题清单

### P0：阻塞公开测试基线

- 当前版本存在未定位重大运行问题。
- 没有经过验证的 BUILD_AND_RUN。
- 本地依赖未安装，现有测试状态未知。
- Android 生成物是否来自当前源码不可证明。

### P1：严重影响定位

- 不同运行模式使用不同状态权威。
- 日志和错误缺少统一上下文。
- 随机、时间和全局触发器不能完整隔离/回放。
- 存档外层格式无正式版本；新格式兼容边界尚未建立。
- UI 中存在胜负和部分规则判断。

### P2：协作和维护成本

- 公共类型重复。
- Electron/WS/Relay 使用不同字符串协议。
- `battle.html`、`turn.ts`、`skills.ts` 职责集中。
- 生成资源与源码关系不清。
- Next 构建忽略 TypeScript build errors。

## 4. 已确认产品与技术方向

1. 首要 Demo 是 LAN Windows/Electron + Android；两端均可开服和加入，同一设备可同时运行独立服务端与客户端角色。
2. 当前提交作为正式故障基线，不回退到旧版本猜测正确实现。
3. JS/TS 源代码成为唯一真实源，Android 安装包是可追踪的生成产物。
4. 不兼容任何公开测试前旧存档；兼容承诺从新的版本化格式开始。
5. 账号和服务器均去中心化；服务器规则自治，胜负由当期权威服务端裁决。
6. 文档、测试和日志先行，不进行“重构整个项目”的超大改动。
7. 存档签名、加密恢复、规则沙箱和公开回放属于已延期愿景，不是 Demo 当前承诺。

## 5. 后续模块队列

以下是队列，不是一次性计划。只有阶段 A 现在进入执行；后续阶段必须重新确认任务合同。

### 阶段 A：恢复基线

1. 记录并固定 Windows/Node/npm/Java/Android 工具链。
2. 定位当前版本第一个安装、测试、启动或打包失败点。
3. 完成 Electron server + Electron client 最小 LAN 冒烟。
4. 完成 Android 加入 Windows LAN 房间的冒烟。
5. 完成 Android 开服、Windows 加入的反向冒烟。
6. 用验证证据填写 `BUILD_AND_RUN.md`。

### 阶段 B：提高可观察性

1. 统一启动、连接、动作、存储、广播错误上下文。
2. 建立脱敏状态导出和状态 hash。
3. 在 Android 产物写入 commit、构建时间和引擎 hash。
4. 清点空 catch，并按调用链逐项处理，不做全库机械替换。

### 阶段 C：建立确定性

1. 统一可注入 RNG，确保 seed 在初始化前生效。
2. 引入可注入 clock。
3. 统一 action trace 和 replay 格式。
4. 建立固定 seed 的完整核心流程回归。

### 阶段 D：建立新存档兼容边界

1. 定义新外层存档版本、动作序号、hash 链和 server term 字段。
2. 建立保存—读取 round-trip 测试。
3. 从首个公开版本开始维护兼容矩阵。
4. 公开测试前旧存档明确拒绝，不做静默猜测或迁移。

### 阶段 E：收敛模块边界

1. 统一服务端胜负归约，并让 Android/Electron 只显示结果。
2. 核对并收敛重复状态类型。
3. 建立共享 WS/Electron 协议类型。
4. 最后再逐步拆分 `battle.html`、`turn.ts` 和 `skills.ts`。

### 延期模块：长期 High Risk 愿景

1. 玩家/服务端身份、双签名动作链和服务端任期。
2. 端到端加密、隐藏状态、账号和服务器恢复/撤销。
3. 多方随机贡献、秘密 seed 和终局随机审计包。
4. 服务器规则下载、脚本沙箱、声明式 UI 和资源配额。
5. 服务器迁移/备份、数据库导入身份和历史统计规则。
6. 自动匿名公开回放、视角权限和社交账号加密备份网站。

上述内容各自需要 ADR、威胁模型、安全审查和跨平台测试，不作为第一版 Demo 的整体前置条件。

## 6. 明确不在 RED-9 中处理

- 不修改规则、数值、UI 或存档。
- 不删除 `battle-types.ts` 或历史生成物。
- 不升级依赖。
- 不修复当前重大故障。
- 不确定 Relay/PVE 的最终产品地位；Android 内嵌服务明确属于公开测试的对等开服范围。
- 不宣布任何测试、构建或安装包已通过验证。

## 7. 人工确认点

- Android 构建的正式工具链版本。
- Relay 和 PVE 是否进入公开测试范围。
- `battle-types.ts` 的历史用途和仍需支持的调用方。
- 具体密码算法、密钥存储 API、规则沙箱 ABI 和公开回放托管方式；这些尚未选择。
