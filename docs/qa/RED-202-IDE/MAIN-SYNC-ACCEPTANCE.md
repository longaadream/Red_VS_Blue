# main 同步与人工验收准备（2026-09-10）

- 当前任务分支：`codex/RED-202-inline-code-ide`。
- 已合入 `origin/main`：`53c2c9ca3eef73d2158645b93138e242c225c604`；合并提交 `916d101068a689a346bc5ba89c6e54516a33ad86`，无冲突。未推送或合并功能到 main。
- 原有候选修改已全部恢复；备份保留在 `pr-tools/RED-202-IDE/main-sync-20260910-203356`，原 stash 保留。
- 同步后 10 个测试文件、68 项测试通过，涵盖官方更新、真实签名完整包与补丁、Colyseus、Windows 打包约束及新增 Android/LAN 回归。结果：`pr-tools/RED-202-IDE/main-sync-tests.json`。
- 客户端和编辑器 TypeScript 编译、刷新后的 main-baseline 通过。独立复核未发现新增阻断。
- 使用显式 `RVB_BUILD_LOW_MEMORY=1` 构建实际 Next standalone 成功；仅此环境变量启用单 worker 和 webpack 内存优化，默认构建行为保持原样。Colyseus 与 updater bundle 已构建，复用的 PostgreSQL 16.15-2 runtime 已通过包校验。

## 已准备的人工客户端

入口：`pr-tools/RED-202-IDE/auto-update-acceptance/open-client.cmd`。

该客户端使用同目录下独立 `user-data`，自动检查关闭，启动于 bundled-base。实际主菜单已就绪、服务器健康、官方更新按钮存在，客户端版本为 `0.1.0`。只读状态证据为同目录 `readiness.json`。未代替用户点击检查或应用资源。

人工操作：主菜单「官方更新」→「立即检查」。这一步会检查、下载，并在主菜单条件满足后应用资源，没有额外的资源“应用”按钮。观察资源状态后进入训练营核对数值；退出并重开同一入口，确认版本保留且再次检查不重复安装。

此入口运行开发客户端，客户端稳定频道提示不支持自动安装属预期。真实 NSIS 安装、二进制差量下载和重启安装仍未验收；不能以本次资源测试替代。

兼容边界：历史上直接基于包含 `users.json` 的旧 bundled-base 制作的补丁，与同步后基底可能不同；本次发布采用外部签名完整包及其补丁链，不依赖该旧 bundled-base。
