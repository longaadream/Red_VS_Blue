# RED-209 后续：位移边界与技能语言规范

用户于2026-09-14要求在刚合并的位移变更上明确框架约束，并更新语言标准、创建新PR。

- base_branch: main
- base_sha: 0744ae91ae3cacc8b03d22c6969de84044e225e3
- 关联：RED-209 / 已合并PR #189；本次为新的后续文档PR，不重新关闭原任务。
- 风险：Low，仅文档。
- 允许路径：AGENTS.md、docs/technical/ARCHITECTURE.md、ENGINE_CORE.md、SKILLCODE_AUTHORING_STANDARD.md、docs/product/SKILL_DESCRIPTION_STANDARD.md、本文。
- 目标：禁止绕过统一位移入口，准确说明生命周期内部写入边界；落地最新简短语言规范并保留RED-209语义。
- 不包含：旧资源源码覆盖、游戏规则或生成引擎改动、界面实现、发布和合并。
- 验收：接口与最新源码一致；禁止坐标直写及替换对象绕过；描述格式覆盖距离/时长/层数/倍率/关键字；不把未实现的UI和批量内容迁移写成完成。
- 验证：main-baseline、git diff --check、项目编码检查及本次文档UTF-8/相对链接检查。纯文档不运行游戏全量测试。
- 回退：撤销本次文档提交。

新Linear任务写入被自动审批拒绝，因此合同保存在仓库中；未通过其他渠道绕过写入。用户已授权的PR工作继续执行。

验证结果：main-baseline通过（behind=0）；项目编码检查1132个文件通过；本次6份文档UTF-8与38个本地链接通过；git diff --check通过。核对位置提交、flow适配和兼容teleport源码后，修正作者手册中过时的“传送不收集充能结晶”和“飞行预留阻挡”表述。没有执行游戏全量测试或宣称UI已实现。
