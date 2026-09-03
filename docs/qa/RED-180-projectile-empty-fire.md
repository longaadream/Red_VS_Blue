# RED-180 弹道技能空发验证

## 基线与范围

- `base_branch`: `main`
- `base_sha`: `59d79dddb1a301b8e2090b39b8b939ba39a463f3`
- 风险：Medium（技能规则与目标交互）
- 受影响技能：`地狱火霰弹枪`、`共生拖行`。
- 不改变：技能范围、弹道跟踪、命中/阻挡顺序、伤害、拖拽落点、表现特效和行动栏结构。

## 修改前复现

`npm.cmd test -- tests/game/projectile-trace.test.ts`：4 项新增回归失败。两个技能的空方向/障碍方向候选集为空，提交时因目标选择无效而被拒绝。

## 验收证据

- 候选目标：两个技能均显示范围内所有横纵格，包含空方向和首先遇到不可穿透地形的方向。
- 空发结算：空路径、墙/掩体、友军阻挡以及共生拖行的其他释放后无效果分支返回已使用；扣 1 AP、进入 1 回合冷却、追加 `useBasicSkill` 行动记录并触发一次 `afterSkillUsed`。
- 效果记录：未新增 `outcome` 字段；无命中时不产生伤害、位移或状态效果。
- 原规则：命中伤害、掩体上棋子先于地形结算、深坑可穿过、非横纵目标仍被拒绝。
- 浏览器运行时：`build:game-engine` 后桌面与 Android 产物 SHA-256 相同；差分测试确认掩体方向可选且空发结算一致。

## 自动检查

- `npm.cmd test -- tests/game/projectile-trace.test.ts tests/game/venom-skills.test.ts tests/game/targeting.test.ts tests/game/turn.test.ts tests/game/engine-browser-differential.test.ts`：115/115 通过。
- `npm.cmd run typecheck`：通过。
- `npm.cmd run check:encoding`：通过（923 个文本文件）。
- `npm.cmd run build:game-engine`：通过。由于测试环境安装时跳过了 lifecycle scripts，首次构建在 Prisma browser client 缺失处失败；执行 `npm.cmd exec prisma generate` 后重试通过。
- `npm.cmd test -- tests/game`：1193/1202 通过，9 项失败。其中 5 项为 5 秒超时，提高单项超时后复跑的 AI environment、AI planner 和 4 个 summon redirect 用例均通过；2 项是未修改的 SQLite 异步持久化性能用例；2 项 static audit 固定数量断言要求 134 个技能/21 个 triggerSkill，而当前 `origin/main` 实际为 132/19。这些失败与本次修改路径无关，未在 RED-180 中改动。
- 独立 AI 审查：PASS；无阻塞项，确认修改路径、语义、浏览器产物与自动验证符合 RED-180 合同。

## 人工冒烟

1. 在死神四个方向均无棋子时使用「地狱火霰弹枪」，确认范围内横纵格都能点选。
2. 分别朝空路径和墙/空掩体方向释放，确认弹道特效照常播放，不造成伤害，AP -1 且技能进入冷却。
3. 查看行动栏，确认显示「死神 使用 地狱火霰弹枪」，效果只显示真实发生的状态变化，没有新增 outcome 文案。
4. 对「共生拖行」重复空路径、地形阻挡和正常拖拽场景，确认只有正常命中时改变敌人位置并附加腐蚀。

## 回退

回退 RED-180 PR 即可恢复原弹道碰撞前置声明、权威候选过滤和无效果释放拒绝语义。
