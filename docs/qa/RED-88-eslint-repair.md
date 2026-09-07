# ESLint 全仓修复合同与证据

## 授权与基线

- 2026-09-07 用户明确选择「彻底修到全仓 lint 通过，包括类型和测试整理」。
- 用户允许本次只在本地记录合同并继续修复；不向 Linear 发送数据。
- 关联既有 RED-88 零新增门禁，独立分支 `codex/RED-88-eslint-repair`。
- base_branch: main
- base_sha: e9b6918080010f30f5b2fe5f535548f80c90a257
- 已刷新 origin；原 RED-184 工作区及其未提交改动保持原样。

## 范围与验收

目标为恢复全仓 `npm run lint` 的退出码 0、零错误、零警告。
允许修改 ESLint 配置/历史清单、相关工具文档、CI lint 检查，以及 lint 报告涉及的源码、类型和测试辅助构造器。
修复第三方产物与独立 HTML 脚本规则误报，清理无用声明，为源码及测试补充有意义的类型。
不升级依赖，不改变玩法、数值、随机算法或存档协议，不扩大 suppression，不通过全局关闭规则或宽泛类型别名隐藏违规。
既有 suppression 仅可减少；这次验收不表示已消除全部被既有基线豁免的技术债。

## 风险与验证

Medium：涉及核心模块类型和测试构造器，保持运行行为并进行独立代码审查。
修改前记录完整 lint、类型检查及相关测试基线；修改后运行聚焦测试、完整 lint、类型检查对比、受影响游戏测试、编码与 diff 检查。
必要时运行完整测试和构建；记录现存失败，不修改快照掩盖问题。
完成后本地交付可审查差异，不自动合并发布。回退为撤销本分支变更。

## 验证结果

- `npm run lint:prune`、`npm run lint`：退出码 0，零错误、零警告。suppression 从 740 项减到 615 项；逐桶对照无新增、无扩大。
- `npm run typecheck`：通过根项目的 Next 类型生成和 TypeScript 检查。根配置排除 Relay；Relay 独立依赖未安装，未声称验证其独立类型检查。其数据库 JSON 断言经独立审查，相关存储测试通过。
- 完整 Vitest：修复前 2060 项，2040 通过、18 失败、2 跳过；修复后 2065 项，2045 通过、18 失败、2 跳过。失败测试名称完全一致，无新增失败；新增 5 项 ESLint 配置测试全部通过。
- 最后一次聚焦回归（配置、重连、replay 页面、Relay 存储）：21/21 通过。
- `npm run check:encoding`、`git diff --check`：通过；`npm run check:main-baseline` 已验证 base 与刷新的 origin/main 一致。
- Medium 独立审查通过：核对类型边界、核心运行行为、错误处理和 suppression 差异，未发现尚未处理的新增回归。

完整测试保留的失败包括：旧页面/文案断言、内容与 admission 清单及哈希不一致、旧 VM 测试缺少 tutorial 全局、未准备的 Android 引擎/PostgreSQL 产物、AI 测试错误，以及沙箱中 esbuild 目录访问失败。这些均在未修改基线复现，本次没有更新快照或改变内容数据使其消失。

默认 `npm run build` 未通过：独立工作区使用 node_modules 目录链接，Turbopack 拒绝指向其文件系统根之外的依赖路径（`Symlink [project]/node_modules is invalid`）。该失败发生于打包阶段，不能据此声称生产构建已验证通过，也不是 ESLint 失败。

补充执行 `node node_modules/next/dist/bin/next build --webpack`：退出码 0，编译及页面生成成功。该命令只验证 Next webpack 构建，未执行 npm build 的末尾静态资源复制，也未验证桌面/Android 打包。未更改项目默认构建方式；类型验证来自单独通过的 `npm run typecheck`。

完整日志保存在本工作区 `output/eslint-repair/`：`tests-full-before.json`、`tests-full-after.json`、`tests-review-fixes.json`、`lint-final.txt`、`typecheck-final.txt`、`build.txt`、`build-webpack.txt`。原工作区仍在 RED-184 分支，不会自动获得本独立分支上的修复。

用户随后明确要求创建 PR 并合并；据此继续提交、推送及合并流程，任务合同仍仅本地记录，不创建 Linear 工单。最终 PR 检查与合并结果以 GitHub 记录为准。

PR 阶段无冲突同步主线 `4095cf289103eb3f1895d95fa74434aea30adbc0`，同步后 lint、根项目类型检查和编码检查再次通过。首次 CI 在安装依赖时触发现有 Colyseus/Zod 可选 peer 冲突；lint 工作流改用 RED-161 与 RED-186 记录的 `npm ci --ignore-scripts --legacy-peer-deps` 安装方式，保留锁文件和检查要求，不升级依赖。
