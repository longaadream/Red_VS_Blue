# ADR-0001：统一开发、验证与打包入口

## 状态

已接受。

## 日期

2026-08-18

## 背景

项目已有 Next、Electron、Android、测试和资源同步脚本，但入口分散在多个 npm scripts 与文档中。每次开发、调研和验收都需要人工或 AI 重新组合命令，失败结果也没有统一的日志、Git 状态和报告格式。这增加了重复操作，并让不同验收者难以复用前一次证据。

## 决策

使用 `npm run rvb -- …` 作为推荐的项目工程入口，并由无第三方依赖的 Node CLI 编排现有 npm scripts。

- `dev` 启动默认开发服务。
- `doctor` 检查本地前置条件和仓库状态。
- `verify` 按 `quick`、`standard` 或 `candidate` profile 执行检查并生成证据。
- `package` 复用现有 Electron client 打包脚本并生成证据。
- profile 与底层命令集中定义在 `config/validation-profiles.json`。
- 证据写入 `output/validation/<RED-ID>/`，不代替任务合同或人工体验验收。

现有 npm scripts 保持可直接调用且语义不变。统一入口是编排层，不成为新的游戏状态、规则或发布权限来源。

## 备选方案

### 继续维护命令清单

不采用。静态清单不能执行、停止失败步骤或生成标准证据，仍需要人工复制命令。

### 立即建立完整云端 CI/CD

暂不采用。当前运行基线仍在恢复阶段，先稳定本地与 CI 共用的入口，可以避免把未验证流程直接固化到云端。

### 让每个 AI Skill 自行执行命令

不采用。Skill 适合解释任务合同和判断结果，不适合成为唯一的构建实现；确定性检查应由仓库脚本执行。

## 影响

收益：

- 日常使用者只需记忆少量稳定命令。
- 失败步骤、退出码、日志和 Git 上下文自动留存。
- 人工、AI 与未来 CI 可以复用同一编排逻辑。

成本与风险：

- CLI 与 profile 配置需要随底层构建脚本同步维护。
- 自动报告只能证明命令执行结果，不能判断 UI、玩法体验或发布质量。
- `candidate` profile 可能运行耗时较长的打包流程，仍需人工明确选择。

## 验证方式

- 自动测试覆盖参数校验、dry-run、成功、失败中止和报告生成。
- `doctor`、`verify --dry-run` 与 `package --dry-run` 在 Windows 仓库中实际运行。
- 通过独立审查确认现有 scripts 未被删除或改变语义。

## 回退方式

回退 RED-93 的提交即可删除统一入口。由于现有 scripts 保持不变，回退后仍可继续直接运行原命令。

## 相关资料

- Linear：RED-93
- `docs/technical/BUILD_AND_RUN.md`
- `docs/qa/README.md`
