# RED-258 回合结束选择隔离

base_branch: `main`
base_sha: `00df31f8bd35b34200d507fd83853bf5ac99ba94`

风险：Medium。范围是回合结束触发器和 reactive card 在注入 pending 输入后的上下文生命周期；不修改角色数值、存档格式、公共命令或依赖。

## 验收覆盖

- Colt 先触发并选择落点后，Minato 仍产生自己的 pending；反向触发顺序也保留 Colt 的 pending。
- 取消任一 pending 后继续同一回合结束链；选择会话的 `playerId` 与实际规则归属一致，错误玩家、旧 `selectionId`、旧 `stateRevision`、占用格和越界格均被拒绝且不污染状态。
- 没有 Colt、Colt 已死亡、Colt 没有合法移动格，以及 Minato 没有合法锚点格时，链按规则跳过无效消费者并保持可观察的最终状态。
- 固定 seed `258` 下，Colt 与 Minato 的完整双选择链可以重放到相同的逐动作 hash、终态 hash，并在 `beginPhase` 后推进到下一位玩家。
- reactive card 的目标答案不会泄漏给后一个 reactive card；规则在收到答案后显式改写目标仍会传递给后续消费者。

## 验证证据

- `npx vitest run tests/game/red258-endturn-choice-isolation.test.ts --maxWorkers=1`：13 tests passed。
- 相关回归套件、浏览器差异套件、TypeScript、定向 ESLint、编码检查和 `git diff --check` 在实现阶段通过；生成的浏览器资源为 `data/pages/js/game-engine.js`。
- 修改前的最小 Colt + Minato 顺序夹具已复现共享上下文泄漏：Colt 输入会改变后续 Minato 的锚点输入；修改后同一夹具按两种触发顺序均通过。

已知限制：本记录覆盖源码规则运行器和生成的 Windows/browser engine bundle；未重建 Android 资源包。已有 `RED-129` 旧测试中关于 `canCancel` 的基线断言与当前规则数据不一致，本任务未修改该无关测试。

回退方式：恢复 `lib/game/triggers.ts` 的两个消费者快照顺序、对应 RED-258 回归测试、生成的 `game-engine.js` 与本记录即可。
