# RED-244 候选验证

日期：2026-10-08 至 2026-10-09。角色：实现者自检，另有独立 AI 代码审查；尚未人工产品验收、合并或发布。

## 基线与范围

- `base_branch: main`
- `base_sha: 9d1b0c30801cd733ec4cede37ce1ef0889a2313a`
- 承接 PR #231 的 `ce824e824409547321aeeead4d05613a96600b62`；没有丢弃其移动、预演、技能与美术修复。
- High 方案已经用户批准；范围及回退见 [技术说明](../../technical/RED244_PLAYER_PROFILES.md) 和 [ADR-0037](../../decisions/ADR-0037-player-profiles-and-terminal-replay.md)。

## 验收结果

| 项目 | 证据与结果 |
| --- | --- |
| 统一玩家档案弹窗 | 本人、排行榜对手、战绩玩家入口实测；本人显示编辑页，对手无编辑页。好友、房间和战斗头像复用同一接口，使用真实 accountId。 |
| 昵称与棋子头像 | 本地测试账号保存“纸桌旅人·测试”与吉安娜头像，刷新后保持；HTTP 测试验证重启持久化、只能修改本人、拒绝非法头像和额外字段。 |
| 光暗常用完整阵容 | 实际锁定的八人组合统计；实测光方八人与暗方八人。无记录明确为空，未锁定或未开局阵容不会进入统计。 |
| 战绩与排行榜 | 主战绩和弹窗显示双方记录时昵称、光暗方、八人阵容、地图、时间、结果、结算 Elo 与变化；排行榜点击打开相应档案。改昵称后历史保留原记录名称。 |
| 回放 | 真实官方终局经 repository / journal → HTTP → 浏览器 Trace 验证器成功；界面观看、逐帧推进、下载、文件导入验证与返回战绩通过。回合跳转另有自动化覆盖。 |
| 回放权限 | 匿名、无关账号、未结束对局被拒绝；先校验权限再取报告。大包、损坏记录及过期会话拒绝测试通过。 |
| 当前资源统计 | 本地一场实际开局并结算对局显示 1 场、2 套参赛阵容；角色选择率 50%，胜率依所在阵营分别 0% / 100%。资源身份隔离、重复读取不重复计数及一致性事务测试通过。 |
| 房间邀请 | 持久化与 HTTP / UI 测试覆盖好友权限、屏蔽、过期、重复发送、非收件人拒绝、并发仅接受一次、现有资源版本检查；真实界面收件箱空态通过。 |
| 异步与交互 | A 资料成功后 B 请求失败、退出登录重开、关闭按钮均有回归测试；真实界面键盘右箭头切换页签、关闭后恢复焦点通过。头像请求缓存与合并测试通过。 |

## 自动化与静态检查

均从仓库实际 Vitest、ESLint、TypeScript 脚本运行，未修改依赖版本或快照。

- 17 文件模块回归：**86 项通过**。覆盖 `player-profiles`、`player-replay`、三组 PostgreSQL 集成、community / lifecycle / presence、official-session、invites / multiplayer-entry、battle DOM / action-history / timer、mobile-online-layout、official-profile、replay-page。
- 最后 UI 修复后六文件定向复测：**38 项通过**（player-profile、official-profile、community、community-lifecycle、official-session-persistence、multiplayer-entry）。不与上一组相加，存在重叠。
- 独立审查九文件：**36 项通过**；最终旧资料清理复审：`player-profile.test.ts` **13 项通过**，无剩余已确认 P1/P2。
- 真实官方房间回放链路：`tests/colyseus/official-ranked.test.ts -t "uses only server assignments"`，**1 项通过，13 项按筛选跳过**。
- 所有本任务新增/修改的 JS、TS 运行 ESLint `--max-warnings 0`：通过。
- TypeScript：继承根 `tsconfig.json` 的临时 `output/tsconfig.integration-check.json`，仅在既有 exclude 上增排除旧 `output/baseline` 副本；`tsc -p` 通过。
- `npm.cmd run check:encoding`：1508 个文本文件通过。
- `git diff --check`：通过。刷新远端后 `npm.cmd run check:main-baseline`：落后 main 0 个提交。

PostgreSQL 测试使用本地 QA 数据库，各测试创建并清理自己的唯一 schema。`RVB_TEST_POSTGRES_URL` 从本地未跟踪配置读取，不放进证据或日志。内嵌 PostgreSQL 包的既有清单 hash 问题未改动；本任务使用可运行的真实外部 PostgreSQL 完成相同链路验证，没有用 mock 代替数据库。

## 实际候选与截图

候选页由本地 `38844` QA 服务提供，使用独立 `red244_ui` 数据，不影响正式玩家。实际测试对局：`ranked-7a83afd7-7591-43e4-95e4-56a060f6cd66`，回风曲径，双方完成禁选和八人锁定，光方投降，Elo 984 / 1016。

这是单回合、一条终局命令的最小真实链路，不以此宣称完整多回合对战已人工验收。多帧/回合行为由现有回放自动测试覆盖。

- [档案概览](profile-overview.png)、[头像昵称保存](profile-edit.png)、[对手资料](opponent-profile.png)
- [完整战绩](history.png)、[角色统计](statistics.png)
- [实际回放](replay.png)、[下载文件重新导入成功](replay-import.png)
- [公开 DTO 记录](live-match-summary.json)，只含本地测试账号和对局的展示字段。

## 人工验收与限制

1. 点击首页/联机右上角昵称，修改头像昵称；再点排行榜或好友头像确认资料对象正确。
2. “我的战绩”检查双方完整阵容和地图，点击观看、下载；回放可返回原战绩入口。
3. 双客户端进入可公开访问的同一资源版本房间，房主点“邀请好友”，好友从“约局邀请”接受并走原有入房流程。
4. 在实际桌面客户端小窗口检查弹窗滚动、头像目录、键盘切换和关闭焦点。本次 CUA 视口设置未可靠反映到实际窗口，不能把设置调用当成小窗口验收通过；已检查当前窗口弹窗无横向溢出。

本次未重新打包安装 Electron 发行客户端，也未对公网双客户端邀请进行人工验收。旧记录缺少归档/阵容/地图时明确不可用，无法补造历史。回放只允许已结束对局参赛者读取；其他玩家可以看公开战绩，不能借资料页下载不属于自己的回放。

回退关闭新增入口和 API，保留资料与邀请表；不反向迁移账号或改写原始对局记录。
