# RED-235 固定路线 PVE 候选验证

本记录用于候选验收，不代表人工体验验收、合并或发布。合同：[RED-235](https://linear.app/redvsblue/issue/RED-235)。

## 基线

origin/main: 9d1b0c30801cd733ec4cede37ce1ef0889a2313a。分支 codex/RED-235-pve-fixed-route。刷新远端后基线检查通过，候选检查 behind 0。修改为独立路线运行时、关卡页、原生战斗桥接、入口、构建与测试文档。

## 已执行检查

| 检查 | 结果 |
| --- | --- |
| 固定路线 content / route / session / worker / client，Vitest maxWorkers=2 | 5 文件 / 18 项通过 |
| 旧 roguelike + game/map-catalog + game/battle-page-contract | 首轮 207 通过 / 5 失败；4 项浏览器环境守卫回归已修复，针对性复测通过；1 项为原有提示断言不匹配 |
| world-ui + battle-page-contract 针对性复测 | 2 文件 / 68 项通过 |
| 固定路线5文件 + 上述2文件定版复测 | 7 文件 / 86 项通过 |
| npm.cmd run build:adventure | 新旧 Worker 构建通过 |
| npm.cmd run typecheck | 通过 |
| npm.cmd run lint | 通过 |
| npm.cmd run check:encoding | 1427 文本文件通过 |
| git diff --check | 通过 |
| npm.cmd run check:main-baseline | 通过 |

固定路线单元测试覆盖章节池、地图语义、真实敌人移动、revision/阶段拒绝、协议边界、单 Worker 桥接、伤势/牌/遗物传递和临时费用清理。构造 carry 的单元测试与模拟 Worker session 不作为真实通关证明。

已有失败为 roguelike/adventure.test.ts 的 cross-boundary shield：期望“跨区域”，实际“目标不在当前战区，请先进入战区支援”。独立审查确认该 fixture 直接构造 AdventureSession(state)，不经过新增可选地图初始化；测试、targeting、boundary 文件均与基线一致。未修改此断言。

Windows 沙箱曾限制依赖读取与临时文件，环境放开后重跑。未升级或安装依赖。内置浏览器控制两次超时，改用已有 Playwright CLI。

## 真实浏览器

启动 node scripts/qa/pve-route-server.mjs，打开 http://127.0.0.1:8879/pve-route.html?seed=235。资源由桌面协议读取，战斗使用原生 battle.html。

种子235第一战 large-hole-map（20×16）：实际点击进入，免费部署安娜到(1,7)，施放麻醉镖命中食尸鬼，移动安娜到(4,7)，结束回合等待敌人行动。revision 1→2→3→4→11；部署保持1 AP，移动后0 AP；敌方执行后恢复人类输入，turnNumber 3、AP 2。骷髅(18,10)→(16,10)，僵尸(18,4)→(16,4)。没有注入HP/AP、状态或赢家。

实际确认投降后返回节点1，提示未取胜，不能推进，只能重开。构造计数为父页1 Worker / 战斗iframe 0 Worker。角色独立资料和背包正常。1280×800、844×390、667×375关卡按钮、角色资料和背包均可见；横屏初次进入定位队长，原生全图按钮正常。敌方预告避开菜单和充能显示。

第二次浏览器实战通过原生双击出牌与目标选择使用掩护射击、校准射击、回溯10、闪现、生物手雷；revision51 最后核心被原生脉冲手枪击败，native reason=core-eliminated、winner=adventure-human。revision52 点击校准射击奖励后回到路线result；53进入事件，54进入第二战预览，55实际进入 winding-pass。HP7/10、两张奖励牌、成长+3保留；开场手牌5张（两张奖励牌+三张临时补给），Worker计数仍父1/子0。新证据 native-reward.png、route-victory.png、route-event.png、native-next-battle.png；详细操作见 browser-actions.json 的 victoryRun。

证据 output/pve-fixed-route/：browser-actions.json、route-desktop.png、route-844.png、route-667.png、character-details.png、route-backpack.png、native-battle.png（实际行动后）、native-desktop.png、native-844.png、native-844-fullmap.png。

本地主机 optional resource-pack active.json、favicon 404 不影响资源回退。共享原生提示图标有重复 tabletop-battle/tabletop-battle 路径404，相关逻辑未修改，记录为已有轻微资源问题。

## 完整回放与独立审查

首个完整 seed235 回放实际完成3章12胜、1310步、finalPhase=won、revision1343，所有终局均为原生 core-eliminated；但耗时341秒超过180秒设置，Vitest因此exit1，不能记为测试通过。独立审查确认将这项显式长验收回放上限调整为600秒属于有界工作量校准，未修改策略、游戏数值或原生胜负。每10步诊断由 FIXED_ROUTE_REPLAY_TRACE=1 控制；FIXED_ROUTE_REPLAY_EVIDENCE=1 写出完整行动证据。调整后的重跑结果见下。

调整后的完整回放 exit0：1文件1测试通过，总耗时344.42秒（测试342.53秒）。命令为设置 FIXED_ROUTE_REPLAY_EVIDENCE=1 后运行 npx.cmd vitest run tests/pve/fixed-route/replay.test.ts --maxWorkers=1 --silent。native-replay.json 保存种子235、3章、12场原生胜利、1310次战斗行动、最终won和revision1343，以及1343条公开命令记录。独立审查结论：通过，没有剩余实质性缺陷。审查者独立运行4文件16项定向测试通过，核对完整回放与浏览器胜利/奖励/下一战证据；平衡与最终体验等待人工验收。最后三个文件EOF空行已清理，git diff --cached --check exit0。

## 人工体验与限制

检查进度、资料与背包，进入战斗部署、移动、施放技能、使用卡牌，观察真实敌方行动；胜利选择奖励后继续直至章节首领。

事件/商店仍为待定占位，没有交易、额外奖励或免费治疗。刷新/退出不保留进度，界面明确提示。章节内容待人工校准。回退撤销独立路线模块和入口接线，不迁移或删除旧数据。
