# Codex Cloud 独立 AI 玩家准备

关联任务：[RED-249](https://linear.app/redvsblue/issue/RED-249/准备-codex-cloud-独立-ai-玩家目标路线搜索与运行环境)。方案边界见 [ADR-0038](../decisions/ADR-0038-cloud-ai-player.md)，搜索协议见 [AI_GOAL_SEARCH](AI_GOAL_SEARCH.md)。

此入口是无窗口 Node 游戏客户端。Codex Cloud 提供执行环境，决策不调用 OpenAI API，不需要 API key。账号、服务器权威与对局规则使用现有官方服务；不启动 Electron、Next、浏览器或新的游戏服务器。

## 当前可以验证什么

- `ai:cloud-preflight` 检查 Node、已安装依赖和本地内容，不连接网络。
- `ai:goal-search -- --smoke` 在完整离线状态中用正式规则寻找五次连续召唤路线。搜索不需要先把每一步估成正分。
- `ai:cloud-bot -- --help` 查看独立玩家入口；配置检查不发起登录或匹配。实际联网由显式运行入口发起。

离线测试使用已知完整状态。线上影子推演使用白名单的公开信息、本地可信规则和独立假设种子，缺失服务器 continuation、隐藏状态和动态规则时不能保证后果精确。每次只提交下一步，服务端确认并同步后重搜。五卡完整路线需要9 AP；当前回合不足时不能假设对手会让整条路线完成。当前准备版不是已证明胜率的通用高手。

## 创建云环境

在 Codex 的 Settings → Codex Cloud → Environments 创建环境，绑定 `longaadream/Red_VS_Blue` 仓库。首次验证应选包含 RED-249 代码的分支；代码合并后再使用 main。环境名称可使用 `rvb-ai-player`。

让环境准备步骤使用 Node 22 或更新版本，在仓库目录执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run ai:cloud-preflight
npm run ai:goal-search -- --smoke
```

这里忽略安装生命周期脚本，避免下载和启动本任务不需要的 Electron。锁文件和依赖版本保持原样；需要的 esbuild 平台包由 npm 安装。

互联网设置先允许依赖下载所需的包管理器域名。联网对战时再允许官方服务器域名，包括其 HTTP API 与 WebSocket 入口。公网账号密码仅通过 HTTPS 发送；服务器的反向代理必须支持 WebSocket。Cloud 允许域名不代表服务器、防火墙、TLS 和原生 SDK 握手已验证。

安装、运行和网络配置依据 [OpenAI 官方 Cloud environments 文档](https://learn.chatgpt.com/docs/environments/cloud-environments)，核对日期2026-10-09。当前文档列出的默认 VM：Plus为2 vCPU/8 GiB，Pro、Business、Enterprise为4 vCPU/16 GiB。实际环境以预检输出为准。文档说明任务的文件状态可恢复，不承诺此机器人进程始终在线；不要用守护进程、后台脱离或反复唤醒伪装成持续托管服务。

保存并发布环境配置后创建一次有限运行的验证任务。这里的“发布环境”是保存可复用的 Cloud 设置，不是发布游戏版本或机器人到正式服。

## 离线验收

Linux / Cloud 使用：

```sh
npm run ai:cloud-preflight
npm exec -- vitest run tests/game/ai-goal-search.test.ts tests/ai-bot --maxWorkers=1
npm run ai:goal-search -- --smoke
npm run ai:cloud-bot -- --help
```

Windows 将 `npm` 替换为 `npm.cmd`。结果必须分别记录本地和 Cloud 的平台、实际节点数、耗时、预算停止原因和动作列表；不要用本地结果标记 Cloud 或生产连接成功。

## 官方账号和运行配置

使用一个已经完成邮箱验证的独立游戏账号。昵称应能明确识别为 AI，避免让对手误认真人。注册和验证沿用官方玩家界面，本任务不自动注册、不接入邮件管理、不修改积分或匹配规则。

官方账号认证沿用最新 main 的服务实现；Colyseus 的普通房间身份与官方认证是不同入口，不能用任意 playerId 代替官方会话。密码和会话令牌仅从进程环境变量提供，不写 JSON 配置、仓库、输出文件或聊天。Cloud 设置中使用环境变量供 Node 读取；HTTPS 代理 secret 的占位替换不能直接假定适用于 SDK 的 WebSocket join。

`direct` 模式仅用于本地受控 QA 房间。本次没有实现普通产品房间的 Ed25519 admission 身份流程，不能用它加入要求该认证的正式房间。线上使用下面的 `official` 配置。

不要把本机 `127.0.0.1` 填为云端目标；它在 Cloud 中指向 Cloud VM 自己。

非敏感配置示例（保存为 `bot-config.json`，服务器地址替换为实际官方入口）：

```json
{
  "mode": "official",
  "serverUrl": "https://your-official-server.example",
  "alignment": "dark",
  "pieces": ["arthas", "dark-aizen", "dark-grimmjow", "dark-muzan", "dark-ulquiorra", "guldan", "kiljaedan", "reaper"],
  "maxRuntimeMs": 600000,
  "maxActions": 100,
  "decisionBudgetMs": 1500,
  "goal": { "kind": "summon", "templateId": "kiljaedan" }
}
```

这8枚棋子属于当前可信Demo暗方目录，只是可运行示例，不是已验证的最佳阵容。`goal`可设为召唤指定模板或消灭指定公开棋子；未指定时由策略选择可见目标。预算增大可以搜索更多节点，但不能恢复未知信息或保证跨回合胜率。

在 Cloud 的环境变量设置中，二选一提供：

- 已有游戏会话：`RVB_BOT_OFFICIAL_TOKEN`。
- 已验证账号登录：`RVB_BOT_ACCOUNT_EMAIL` 和 `RVB_BOT_PASSWORD`。启动登录会按现有官方规则撤销该账号旧会话；不要同时在别处用同一机器人账号登录。

程序会读取当前账号及已有比赛；没有比赛时正常排队，自动提交公开禁图和配置阵容，等赛前进入battle后用官方令牌加入。赛前锁定使用自己的阵容revision，不能使用schema version替代。队列需要另一名已验证玩家；不会在服务端偷偷补机器人。

先检查不含凭据的配置，再显式运行：

```sh
npm run ai:cloud-bot -- --check-config bot-config.json
npm run ai:cloud-bot -- --run bot-config.json
```

可指定`roomId`恢复自己的当前官方比赛；它必须与`/official/me`返回的比赛一致。通常无需手填账号UUID，程序从已认证账号取得`playerId`及昵称。进程退出时不会自动调用赛前认负或改变战绩。

## 运行停止与回退

首次联网选择短时间、有限动作的验收任务，与受控测试对手核对真实服务器回执。观察机器人掉线、重连、输入暂停和终局；退出任务不等于退出比赛或认负。官方服务自身的计时、掉线接管和结算继续生效。

入口将最多70%的决策时间分给路线搜索，留出影子状态处理及备用动作开销。搜索预算耗尽时可以使用合法备用动作；完整决策超过期限则停止，不能提交过期动作。单次同步规则调用无法中途取消，因此这不是严格的CPU时间隔离，实际机器负载和大棋盘仍需测量。

独立CLI从启动开始计入`maxRuntimeMs`，到期先取消工作，给异步清理最多3秒宽限；如果SDK的HTTP请求或WebSocket关闭握手仍挂起，入口会以失败状态结束自己的进程。正常结果先刷新输出，结束后还有1秒退出兜底。SIGINT/SIGTERM也先取消再执行退出期限。这是独立CLI的进程管理保证；直接调用transport库只获得Promise等待期限。同步规则调用阻塞事件循环时，计时器也只能等该调用返回。

机器人必须停止新动作后关闭连接，不上传模拟胜负。回执未知时先查询原命令，不发送另一个命令掩盖不确定结果。环境/凭据缺失、版本不兼容或恢复失败应退出并提供具体原因。

回退只需停止 `ai:cloud-bot` 入口或撤销 RED-249，无服务器、数据库或存档变更。当前还没有用户创建的 Cloud 环境，因此本次只交付代码、说明和本地证据，Cloud 和正式服验收另行记录。
