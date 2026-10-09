# RED-250 紧急交互与倍率修复

## 合同与基线

- Linear：[RED-250](https://linear.app/redvsblue/issue/RED-250)
- AI 角色：实现者；风险 Medium。
- `base_branch: main`
- `base_sha: 00df31f8bd35b34200d507fd83853bf5ac99ba94`
- 已执行 `git fetch origin --prune` 并显式刷新远端 main；独立分支 `codex/RED-250-urgent-fixes` 创建后 `npm.cmd run check:main-baseline` 通过。
- 用户确认虚闪为 0.5 倍；退出是关闭程序；黑色月牙问题是同一个方向或落点要重复点击，保留现有方向与落点两阶段。

## 虚闪

历史提交 `df3a91c74f` 修改描述和 `powerMultiplier` 为 0.5，但执行代码仍为 `Math.floor(caster.attack * 0.75)`。本次仅修正执行倍率，不改变射程、费用和其他技能。

`tests/game/red250-ulquiorra-cero.test.ts` 通过真实 `prepareAction → runBattleAction` 验证：攻击 4、目标生命 30 的固定状态，旧版生命为 27（失败），修复后为 28，伤害事件 `finalDamage: 2`。

## 显式取消

旧 `renderTargetOverlay()` 在当前技能卡可再次点击取消时隐藏公共取消按钮。现保留显式入口，仍遵守权威 `canCancel:false` 和提交等待限制。选项弹窗、手牌和规则选择原有入口保持；不将强制响应变成可跳过。直接测试验证凭证原样提交、等待时不重复发送、本地取消不发权威动作。

## 黑色月牙重复落点

公开预演会过滤对手隐藏规则，但旧提示 hash 使用所有消费者共用的 `consumerOrdinal`。固定一护场景中，隐藏对手规则使权威传送步骤全局序号为 1，公开预演为 0；首次落点答案的 hash 不匹配，权威保持 pending，迫使玩家再选一次。

修复为按 `(consumerKind, consumerId, sourceId, eventType)` 单独计数的 `consumerOccurrence`，提示 hash 带 `consumer-identity-v1` 域标记并严格匹配。原全局序号仍用于权威事务重放；旧内部事务缺少新字段时使用旧方案。没有下发事务、隐藏规则或增加客户端权限，没有更改一护两阶段手选规则。

测试覆盖公开投影到正式批量提交的真实链路，验证一次落点完成传送、AP 只扣 2、伤害只产生一次；不同发生次数、不同候选和旧序号域不可串答。独立审查指出的宽松序号别名已移除。

## 关闭程序

主菜单与战局设置提供“退出程序”。只允许可信 `game` 窗口通过 preload 请求既有 `requestApplicationExit()`，复用停服/持久化保护。共享 Promise 将异步停服失败传回 renderer，按钮恢复重试；原生关闭调用点接住已记录的失败。网页没有对应桥时隐藏入口。

## 验证记录

- 虚闪定向回归：修复前失败，修复后通过。
- 最终 `npm.cmd run typecheck`：通过。中间新增测试的类型错误已修复后重新验证。
- 相关 RED-163 套件有三项相邻失败：葛力姆乔描述及两项镜花水月伤害期望；暂未单独比较本次基线，不把该套件报告为全绿，不修改无关期望。
- 独立审查确认 `tests/electron/colyseus-player-path.test.ts` 的启动超时断言与基线不一致：HEAD 已是 900000ms，旧测试仍期望 240000ms。本次不修改该常量或无关断言。
- 最终直接及相邻回归：14 文件、257 项全部通过。中间两个启动测试失败来自退出接口改为 Promise 后的旧调用约定，现已更新真实拒绝断言及异步 mock，重新运行通过。
- 受影响 TypeScript/JavaScript/CJS 的 ESLint（`--max-warnings 0`）、Electron TypeScript 编译、`npm.cmd run check:encoding`（1518 文件）、`git diff --check` 通过。
- `node scripts/build-game-engine.js --windows-only`、`node scripts/build-practice-ai.mjs`、`node scripts/build-adventure.mjs` 从最终源码重建三个桌面浏览器引擎。
- 独立 AI 最终审查无阻塞发现；序号串答和退出失败重试两个发现已修复。审查者最后独立重跑启动/退出 22 项通过。
- `node tests/electron/red250-exit.smoke.cjs`：隔离 userData 启动真实 Electron，更新 dialog 打开时 `elementFromPoint` 命中右上退出按钮，CDP 鼠标点击后进程 `exitCode: 0`。截图见 [退出入口](RED250/exit-over-update-dialog.png)。
- 原生冒烟为源码开发入口，本地权威服务未构建，截图显示服务未就绪；仅验证此时仍能从真实窗口关闭，不代表完整客户端打包、联网双端或对局原生操作全部通过。一护和取消的状态/凭证验证来自真实规则链及 UI 回归，完整对局体验仍待人工。

最终回归命令：

```powershell
npm.cmd test -- tests/game/red250-ulquiorra-cero.test.ts tests/game/red250-ichigo-choice.test.ts tests/game/red227-local-skill-sequence.test.ts tests/game/skill-preview-privacy.test.ts tests/game/pending-interaction.test.ts tests/game/effect-chain-transaction.test.ts tests/game/deterministic-runtime.test.ts tests/ui/red250-pending-cancel.test.ts tests/ui/target-overlay-controls.test.ts tests/ui/red227-local-skill-sequence.test.ts tests/electron/red250-exit.test.ts tests/electron/ipc-trust.test.ts tests/electron/client-startup.test.ts tests/electron/local-game-lifecycle.test.ts
```

## 回退与人工验收

撤销本任务提交；若包含引擎源修改，使用项目构建脚本同步重新生成引擎。无存档、数据库、随机算法或依赖迁移。

人工验收：主菜单与战局关闭入口可见且能关闭客户端；可取消选择有显式入口且取消不误释放；黑色月牙每个阶段点击一次即可推进；虚闪实际伤害符合 0.5 倍。不得把自动测试视为人工体验验收、合并或发布授权。
