# RED-256 猗窝座瞬步目标选择回归

状态：候选实现已落地，尚未人工验收。

- 任务：https://linear.app/redvsblue/issue/RED-256
- 风险：Medium，技能目标选择交互。
- 基线：`origin/main` `00df31f8bd35b34200d507fd83853bf5ac99ba94`。

## 自动场景

规则引擎使用 browser bundle，页面控制器函数通过 VM 提取运行；这是自动 VM 场景，不等同于实际 Chromium 验收。fixture 先建立一个可用的瞬步目标，再将状态交给页面控制器：

1. 点击技能后，页面把首个目标选择交给权威流程。
2. 点击敌方棋子后，页面进入下一步落点选择。
3. 非法目标点击不会提交动作，随后仍可继续选择合法目标。
4. 取消后可以重新进入同一技能流程；合法相邻格完成后，动作只生效一次。
5. 没有可用目标时，页面不会安装不可操作的本地草稿。

本任务新增的自动场景：

- `tests/ui/red256-akaza-step-selection.test.ts`
- `tests/ui/red227-local-skill-sequence.test.ts`

相邻行为由已有自动测试覆盖：

- `tests/ui/selection-retry.test.ts`：非法占用格保留当前目标选择，等待重试。
- `tests/game/akaza-flash-step.test.ts`：无合法目标、非法/占用/阻挡落点不改变战局，以及取消不改变位置、攻击和技能状态。
- `tests/ui/target-overlay-controls.test.ts`：取消控件、目标提示和临时非法目标反馈。

## 人工验证

在训练或联机战局中选择猗窝座瞬步，确认目标选择按“敌方棋子 → 合法落点”顺序完成；重复点击、非法落点和取消不会重复结算或改变未提交状态。自动测试未替代真实浏览器中的视觉和输入设备验收。

## 回退

普通 revert 本任务提交即可；不涉及数据迁移。

## 检查记录

候选实现的相关 UI/页面契约 62 项、规则与 browser bundle/targeting 50 项通过；类型、ESLint、编码、主线基线和差异格式检查通过。

单独扩展执行 `tests/ui/selection-retry.test.ts` 为 3 项通过、1 项失败（缺少 `cardNeedsTarget` 的旧 VM harness）。相同测试在本次 `base_sha` 上得到相同失败项，因此未在本任务修改旧断言；不能将该文件报告为全部通过。

## 空权威候选边界

真实 Chromium 首轮验证发现：没有伤害标记、或受伤敌人相邻格全部占用时，权威候选也为空，原候选实现仍进入可取消但无高亮的选择模式。新增两个回归场景在修复前均因 `pendingSkill` 非空而失败，修复后两项及原合法流程均通过（3/3）。现在只有公开投影为空时查询权威；权威技能候选为空则清除本地交互并提示“没有可用目标；请在满足技能条件后重试”。训练调用链避免后续操作栏渲染覆盖该提示。

最新补充检查：三个相关 UI 套件 25/25 通过，类型、定向 ESLint、编码检查通过。独立审查四个 UI 套件 37/37 通过；没有 HP、行动点或冷却写入。

浏览器验证使用真实 battle.html 页面处理器、trainingDoAction、GameEngine 和公开投影；以确定性的 DOM 棋盘替代 3D canvas 点击表面，不能视为完整 3D/Electron 视觉验收。首轮失败报告保留于 ignored `output/RED256-browser/result.json`，后续重验另行保存，不覆盖失败证据。

最终真实 Chromium 复验通过：无标记、全部相邻格占用时，实际 DOM 点击技能后的最终提示保持“没有可用目标；请在满足技能条件后重试”，`pendingSkill` / `targetSubmissionPending` 为 null，完整战局状态不变，再次点击仍可重试；合法标记敌人 → 落点流程只结算一次。独立 tester 在 `result.json` 保留 before 并追加 after；根代理另以真实训练调用链验证两种空候选并比较完整 `JSON.stringify(G)` 不变，记录在 ignored `root-no-mark-after.txt` 与 `root-blocked-after.txt`。
