# RED-21 开发/测试依赖审计记录

状态：实现候选，等待人工验收
日期：2026-08-14
环境：Windows x64、Node.js 24.19.0、npm 11.17.0

## 范围与约束

本记录只覆盖 RED-21 合同允许的开发/测试依赖非 major 更新。没有运行
`npm audit fix`、`npm audit fix --force`，没有修改游戏行为，也没有修改 Next、
ws、adm-zip、Electron、electron-builder 或 Capacitor 的直接版本。

生产口径仍发现 `adm-zip`，该项需要 0.5 → 0.6 的 semver major 升级，属于
RED-21 明确排除的生产依赖链，并已拆分为 RED-17。RED-17 当前状态为
`Canceled`，因此该生产风险没有活动中的修复任务；发布候选前需由人工决定恢复
RED-17 或建立替代任务。它没有在本分支中被修复或降级描述。

## npm audit --json 差异

两次正式对比均从对应 lockfile 的干净 `npm ci` 开始。`npm ci` 的人类可读
基线摘要曾报告 21 个漏洞；紧接着执行、并作为合同证据保存的显式
`npm audit --json` 返回下表中的 5 个聚合漏洞项。

| 口径 | 更新前 | 更新后 | 变化 | 退出码 |
| --- | --- | --- | --- | --- |
| 完整依赖树 | 5：1 moderate、4 high | 1：0 moderate、1 high | 删除 4 个开发/测试聚合项 | 1 → 1 |
| `--omit=dev` | 1 high（adm-zip） | 1 high（adm-zip） | 生产树没有被本任务改写 | 1 → 1 |

完整依赖树的 JSON 元数据由 `prod 189 / dev 853 / total 1079` 变为
`prod 189 / dev 845 / total 1071`。最终 audit 仍返回 1，是因为保留的
`adm-zip` high，而不是因为 RED-21 范围内仍有失败项。

### 已清除项

| audit 项 | 更新前上游与可达性 | 处理结果 |
| --- | --- | --- |
| `vite` | `vitest@4.1.5 → vite@8.0.11`；仅测试期可达 | Vitest/coverage 升至 4.1.10，嵌套 Vite 升至 8.2.1 |
| `brace-expansion` | 开发工具链的 `minimatch → brace-expansion@5.0.4` | 安全补丁 5.0.9；旧 1.x/2.x 节点不在本次 advisory 范围 |
| `serialize-javascript` | `null-loader → webpack@5.105.2 → terser-webpack-plugin@5.3.16 → serialize-javascript@6.0.2`；仅构建期可达 | webpack 升至 5.109.2；新最小化插件链不再依赖 serialize-javascript |
| `terser-webpack-plugin` | 同上；仅构建期可达 | 旧 5.3.16 节点被 webpack 5.109.2 的 `minimizer-webpack-plugin@5.6.1` 链替代 |

`fast-uri@3.1.5`、`js-yaml@4.3.1`、`lodash@4.18.1` 与 `tmp@0.2.7`
在更新前显式 JSON 中已无告警，因此没有为它们制造额外 lockfile 变更。

### 保留项

| audit 项 | 上游 | 可达性 | 保留原因 |
| --- | --- | --- | --- |
| `adm-zip@0.5.x` / GHSA-xcpc-8h2w-3j85 | 根 `dependencies` 直接依赖 | 生产可达；资源包 ZIP 处理 | npm 只提供 `adm-zip@0.6.0` semver major 修复。RED-21 明确排除该链；独立高风险合同 RED-17 定义了兼容性与恶意 ZIP 验证，但当前为 `Canceled`。因此完整和生产 audit 均保留 1 high，发布候选前仍需人工恢复或替代该任务。 |

## 实际版本变化

直接开发依赖：

- `vitest`：4.1.5 → 4.1.10
- `@vitest/coverage-v8`：4.1.5 → 4.1.10

关键传递依赖：

- `vite`：8.0.11 → 8.2.1
- `webpack`：5.105.2 → 5.109.2
- `brace-expansion`：5.0.4 → 5.0.9
- 旧 `terser-webpack-plugin@5.3.16` 与 `serialize-javascript@6.0.2` 节点被移除

所有目标直接依赖和关键上游均保持原 semver major。

## 验证记录

| 命令 | 结果 |
| --- | --- |
| 更新前 `npm.cmd ci` | 退出码 0，安装 949 个包 |
| 更新前 `npm.cmd test` | 退出码 0；7 个文件、59 个测试通过，Vitest 4.1.5 |
| 最终 `npm.cmd ci` | 退出码 0，安装 942 个包；摘要只剩 1 high |
| 最终 `npm.cmd test` | 退出码 0；7 个文件、59 个测试通过，Vitest 4.1.10 |
| `.\node_modules\.bin\tsc.cmd --noEmit` | 首次和构建后均被遗留 `.next/dev/types` 阻断；核对其受 Git 忽略并删除该可恢复缓存后退出码 0；最终干净安装后再次退出码 0 |
| `npm.cmd run lint` | 退出码 1；1005 个既有问题（657 errors、348 warnings），与仓库记录基线一致，未在本任务批量修复 |
| `npm.cmd run build` | 最终干净安装后退出码 0；Next 16.3.0 构建并复制 standalone 静态资源 |
| 最终 `npm.cmd audit --json` | 退出码 1；仅 `adm-zip` 1 high |
| 最终 `npm.cmd audit --omit=dev --json` | 退出码 1；仅 `adm-zip` 1 high |

Vitest 4.1.10/Vite 8.2.1 会提示 `vitest.config.ts` 在未来 major 的 native
config loader 下存在 CommonJS/ESM 兼容性警告；当前测试正常通过，本任务不提前进行
未来 major 配置迁移。构建仍输出既有 middleware 约定弃用警告，以及
`lib/resource-pack.ts` 动态文件系统访问导致扩大 tracing 的警告；两者均不由本次
依赖补丁引入。

## 回退

RED-21 使用独立提交。若测试或构建出现回归，直接 revert 该提交即可同时恢复
`package.json`、`package-lock.json` 与本记录；不要单独手改 lockfile，也不要运行
`npm audit fix`。
