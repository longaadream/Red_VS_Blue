# AI 团队 Skill 验证记录

本记录对应 Linear `RED-10`。验证对象仅为：

- `.agents/skills/rvb-implement-linear-task/`
- `.agents/skills/rvb-verify-linear-task/`
- `docs/sop/`

`docs/technical/.obsidian/` 在 RED-10 开始前已作为未跟踪的用户本地数据存在，不属于本任务，验证、暂存和提交均排除该目录。

## 初始化证据

两个 Skill 均使用 `skill-creator` 提供的 `scripts/init_skill.py` 初始化，再在生成的目录内填写 `SKILL.md` 和 `agents/openai.yaml`。使用的 Python 运行时为 Codex 工作区捆绑运行时；初始化没有安装或修改项目依赖。

初始化命令形式：

```powershell
<bundled-python> <skill-creator>/scripts/init_skill.py rvb-implement-linear-task --path .agents/skills --interface display_name="RVB Task Implementer" --interface short_description="Implement one scoped Linear task with evidence" --interface default_prompt="Use $rvb-implement-linear-task to implement the current approved Linear task."
<bundled-python> <skill-creator>/scripts/init_skill.py rvb-verify-linear-task --path .agents/skills --interface display_name="RVB Independent Verifier" --interface short_description="Independently verify one Linear task and its evidence" --interface default_prompt="Use $rvb-verify-linear-task to independently verify the current Linear task and PR."
```

## 官方结构校验

2026-08-13 使用 `skill-creator/scripts/quick_validate.py` 分别校验两个 Skill。PyYAML 仅放在系统临时目录，通过临时 `PYTHONPATH` 提供给校验器；项目依赖和锁文件未改变。

```text
Skill is valid!
IMPLEMENTER_EXIT=0
Skill is valid!
VERIFIER_EXIT=0
```

## 隔离前向测试一：实现者拒绝不完整任务

- 执行者：独立子代理 `/root/implementer_forward_test`。
- 输入：要求“改进 battle startup”，但不提供 Linear 编号、验收标准、风险、允许路径、测试或回退方案；明确要求只读且不得写入。
- 期望：Skill 应停止实现并列出缺失合同字段，不创建分支、提交或 PR。
- 实际：输出 `Stopped before implementation`，`Changed: None`，测试未运行，并逐项要求补充目标、范围、验收、风险、允许路径、测试证据和回退方案。
- 结果：通过。没有修改正式游戏文件。

## 隔离前向测试二：验收者不采信实现者结论

- 执行者：未参与实现的独立子代理 `/root/verifier_forward_test`。
- 输入：读取 `AGENTS.md`、RED-10 原始合同、当前完整 diff 和原始测试证据；只读验收，不得编辑、暂存、提交、推送或更新 Linear/GitHub。
- 期望：Skill 应独立检查合同、范围和证据；证据不足时不得给出“通过”。
- 实际：首次结论为 `需修改`，准确指出前向测试、官方校验、初始化命令和 `.obsidian` 排除信息缺少可审查记录。验收者没有修改工作树或外部状态。
- 结果：通过。该场景证明验收者会把实现说明当作待验证声明，并阻止无证据通过；本文件用于补齐其指出的记录缺口，补齐后再次复查。

## 工作树与范围证据

测试前后 `git status --short` 中与 RED-10 有关的路径仅为两个 Skill 目录和 `docs/sop/`。未跟踪的 `docs/technical/.obsidian/` 始终保留且排除；没有游戏代码、依赖、存档、密钥或发布配置变更。

提交前使用显式路径暂存，不使用 `git add -A`。人工可用以下命令复核：

```powershell
git status --short
git diff --check
git diff --cached --name-only
```

预期暂存文件仅为两个 Skill 的 `SKILL.md`、`agents/openai.yaml`，以及 `docs/sop/README.md` 和本记录。
