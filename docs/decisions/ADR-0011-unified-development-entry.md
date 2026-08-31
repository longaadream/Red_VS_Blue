# ADR-0011：统一开发、验证与打包入口

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
- `build`、`validate`、`resolve`、`sign`、`smoke` 通过同一内容工具适配层执行资源
  Snapshot/Patch 的发布链；CLI 和 Editor 不得分别实现 manifest、hash、签名或合并规则。
- profile 与底层命令集中定义在 `config/validation-profiles.json`。
- 证据写入 `output/validation/<RED-ID>/`，不代替任务合同或人工体验验收。

现有 npm scripts 保持可直接调用且语义不变。统一入口是编排层，不成为新的游戏状态、规则或发布权限来源。

RED-118 补充以下边界：

- CLI 只接受结构化参数并直接调用内容工具模块，不拼接 shell 命令。
- Editor renderer 只提交 `rvb-content-operation/v1` 封闭操作；main process 校验 sender、字段集合、
  lexical path 与 realpath（含 symlink/junction）边界后，通过有界串行队列使用打包进应用的
  utility process worker 调用同一模块。renderer 不能提交 executable、script 或任意 argv，打包
  Editor 不依赖系统 Node 或源码 checkout。
- RED-118 candidate 的内容操作也必须经过相同 CLI argv 适配器，并从每个 CLI 落盘报告取得身份；
  不能直接调用核心后再把 caller 标成 CLI。Windows candidate 对 Portable 和隔离安装的 NSIS Editor
  分别执行完整五操作链。
- Local Dev 可以输出 unsigned/dev-only 内容。QA、Stable、Community 必须使用外部提供的私钥；
  validate/resolve/smoke 必须显式提供 trusted publisher key ID allow-list，签名有效本身不建立信任。
  Stable 还必须收到显式人工确认。仓库、报告和候选证据不得保存真实 Stable 私钥或密钥材料。
- `scripts/build-resource-pack.js` 仅保留为 deprecated 兼容包装器，并转发到 `rvb build`；它不再
  持有第二套 ZIP、manifest 或 hash 实现。

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
- 内容发布链报告会暴露包 hash、解析后 Profile hash、authority content hash、capabilities、
  signature/key ID、固定 seed 和安全拒绝码，但不得写入私钥内容或私钥路径。

## 验证方式

- 自动测试覆盖参数校验、dry-run、成功、失败中止和报告生成。
- `doctor`、`verify --dry-run` 与 `package --dry-run` 在 Windows 仓库中实际运行。
- RED-118 额外覆盖同一 Base/image Patch/PVE Patch fixture 在 CLI、Portable/NSIS 打包 Editor、Client、Server 的
  hash/ABI 一致性；两种 Editor 发行形态都执行 build/sign/validate/resolve/smoke 全链；另覆盖 QA/Community
  临时密钥、显式 publisher trust、篡改拒绝、密钥轮换、Stable 未确认拒绝、Client/Server Profile
  激活与 previous-stable/Bundled Base 回退，以及固定 seed PVE 正式终局。
- 通过独立审查确认现有 scripts 未被删除或改变语义。

## 回退方式

回退 RED-118 时先停止生成新候选并保留最近一个已验证 Profile，然后回退 RED-118 提交；
`active.json` 应切回 `previousStable`，不得删除已验证版本。若只回退最初统一入口，可回退
RED-93 提交；现有底层 npm scripts 仍可直接运行。

## 相关资料

- Linear：RED-93
- Linear：RED-118
- `docs/technical/BUILD_AND_RUN.md`
- `docs/qa/README.md`
