# 构建与运行

状态：RED-93 统一入口基线
适用环境：Windows 本地开发；后续 CI 复用同一 Node CLI

## 推荐入口

在仓库根目录安装锁定依赖后，只使用以下入口完成日常工作：

```powershell
npm ci
npm run rvb -- doctor
npm run rvb -- dev
npm run rvb -- verify RED-123
```

常用命令：

| 目的 | 命令 |
| --- | --- |
| 启动默认 Next 开发服务 | `npm run rvb -- dev` |
| 检查 Node、npm、Git、依赖和工作树 | `npm run rvb -- doctor` |
| 运行标准验收并留证 | `npm run rvb -- verify RED-123` |
| 预览快速检查但不执行 | `npm run rvb -- verify RED-123 --profile quick --dry-run` |
| 运行候选版本检查 | `npm run rvb -- verify RED-123 --profile candidate` |
| 构建 Electron client 并留证 | `npm run rvb -- package RED-123` |
| 预览打包命令但不构建 | `npm run rvb -- package RED-123 --dry-run` |

任务编号必须使用真实的 `RED-<数字>`。默认 verify profile 为 `standard`。

## 验证等级

profile 由 `config/validation-profiles.json` 集中定义：

- `quick`：编码检查和 Vitest，适合开发中的快速回归。
- `standard`：编码、TypeScript、ESLint、Vitest 和 Next build，适合普通 PR 验收。
- `candidate`：标准静态与测试检查，加 Electron client 打包，适合内部候选版本。

TypeScript 检查遵循当前安装的 Next 16 指南，先运行 `next typegen` 刷新路由类型，再运行 `tsc --noEmit`。不要改回只读取现有 `.next` 缓存的裸 `tsc` 命令。

修改 profile 时应在同一个 PR 中说明原因。不要在 AI 提示词或临时文档中复制另一套命令清单。

## 验证证据

verify 与 package 会写入：

```text
output/validation/<RED-ID>/<run-id>/
├── manifest.json
├── report.md
└── logs/
```

`report.md` 包含 Git commit、分支、工作树状态、Node/npm 版本、实际命令、退出码和耗时。失败时流程停在第一个失败步骤，但仍会写出报告和已执行步骤的日志。

`--dry-run` 会生成 `DRY-RUN` 报告，不执行底层命令。它只能检查编排内容，不能作为测试通过证据。

## 失败处理

1. 打开终端输出所指向的 `report.md`。
2. 查看第一个 `FAIL` 步骤及其日志。
3. 不要反复重跑来掩盖不稳定失败。
4. 如果失败属于当前 Linear 合同，在修复后重新验证。
5. 如果失败超出允许路径，保留报告并建立独立任务。

## 原始 scripts

原有 npm scripts 仍然保留，可用于定位单个底层步骤。团队日常流程、AI 验收和未来 CI 应优先调用 `rvb` 入口，以保证命令顺序与证据格式一致。

## 人工验收边界

PASS 报告不代表产品已经通过人工验收。以下内容仍需项目负责人实际运行和判断：

- UI 是否易懂、反馈是否清晰。
- 核心游戏流程能否完成。
- Electron 安装包能否在目标设备启动和退出。
- 存档、局域网、Android 互通等任务特定场景。
- 候选版本是否可以合并、分发或发布。

统一入口不得自动合并、自动发布或绕过 Medium/High 风险所需的独立审查与人工批准。
