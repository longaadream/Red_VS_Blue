# RED-198 · 退役文件清理

风险 Low；AI 角色：实现者。用户继续授权清理已过时、无用的仓库文件。本轮在 RED-197 已合并后独立进行。

- `base_branch: main`
- `base_sha: 0debcd34126803686719b9ce87a490fe4795d13d`
- 分支：`codex/RED-198-repository-cleanup`
- [Linear 合同](https://linear.app/redvsblue/issue/RED-198)

## 审计与删除依据

检查 1,844 个受控文件，其中 1,293 个文本文件参与精确路径/文件名引用扫描；排除待删文件间的相互引用与本地敏感配置。另用 `rg` 搜索目录引用、默认入口、动态资源加载，并核对 package scripts、Next/桌面打包、Android Gradle 与同步脚本。删除 14 个文件，共 50,676 字节；同步删除 3 个文件的 ESLint suppression（15 行）。删除前 SHA-256、大小和历史引用位置见 [机器可读清单](RED-198-cleanup-audit.json)。

| 删除文件 | 依据及当前入口 |
| --- | --- |
| `scripts/stage-server-resources.js`、`scripts/cleanup-server-resources.js` | 为已删除的 Electron Server 打包器维护 `_standalone`，仅被自身注释、失效 lint suppression 和已取代 ADR-0003 的历史命令提及。现役客户端使用 `stage-client-resources.js` / `cleanup-client-resources.js` 与 `_client-stage`；package scripts 和两份当前 electron-builder 配置不调用旧脚本。 |
| `scripts/migrate-player-ids.js` | 对旧 JSON 房间的 players/hostId/battle 标识做递归小写改写；无调用入口。当前 Windows 对局存储为 PostgreSQL，切换合同明确不导入旧对局数据。此次只删除脚本，没有执行迁移。 |
| `scripts/unlock-build.ps1` | 未被脚本、配置或文档引用的旧手工打包辅助，会按宽泛进程名强制结束进程并清除 app.asar；现役打包流程不调用它。 |
| `ui-map-demo.html`、`resource-icon-demo.html` | 根目录自包含的早期示意页，使用内嵌假数据/固定技能文字，没有规则引擎接线或入口引用；实际界面位于 `data/pages/`。不进入 Next 路由或桌面包的页面目录。 |
| `docker-compose.yml` | 原 `game_postgres` / `gamedb` 配置，仓库无引用、当前连接流程不使用该数据库身份；保留现役 `docker-compose.colyseus.yml`，并在构建文档补充明确启动命令。没有停止容器或移除 volume。 |
| `styles/globals.css` | 未被导入的初始模板主题；`app/layout.tsx` 和 `scripts/build-tailwind.mjs` 均明确读取 `app/globals.css`。 |
| `public/placeholder-logo.png`、`placeholder-logo.svg`、`placeholder-user.jpg`、`placeholder.jpg`、`placeholder.svg` | 5 张模板占位图，没有代码、HTML、CSS、JSON 或文档引用；不是角色/卡牌资源，未被内容 ID 或动态回退规则使用。 |
| `fi/iki/elonen/NanoWSD$WebSocket.class` | 位于 Android source set 外的散落编译文件；无加载引用，Gradle 仅扫描 app/libs 中的 JAR。当前 `MobileHttpServer` 已使用项目自己的实现。已有 `*.class` 忽略规则避免再次纳入。 |

## 保留项

- `tutorial.md` 与 `新手教程.md`：技能作者参考和现役教程设计，不能按文件名判断废弃。
- `docs/decisions/`、`docs/qa/`、`output/playwright/`：决策历史与验收证据；ADR-0003 保留原文，其中旧命令属于历史记录。
- Android、mobile-server、relay-server：Windows 切换没有宣布其他平台退役，仍有构建入口或对应代码。
- 游戏棋盘、技能、角色数据、原生预览页面、第三方库和版权文件：仍有运行、调试或授权用途。
- `.claude/worktrees/` 中已有受控的本地敏感配置：此次不读内容、不修改；此前新增忽略规则只防止新增，不等于已取消跟踪。

## 验证

- 最初本地 fetch 因连接重置/443 超时失败。先通过 GitHub 接口从实时 main 创建分支并验证文件树；网络恢复后成功 fetch、快进到上述 main，并通过 `npm run check:main-baseline`（ahead 0 / behind 0）。没有以过期缓存替代基线门禁。
- 提交前再次运行本地基线门禁时，网络又报 `REMOTE_UNREACHABLE`；GitHub 接口随后核对上述 base 与实时 main 仍为 identical、ahead/behind 0。该次本地复检失败如实保留，远端 PR 基线门禁仍须通过。
- 删除前引用审计：只命中旧脚本的 3 个 lint 条目和 ADR-0003 历史记录，无其他精确引用。
- `npm run build`：通过，Next 页面构建与静态资源复制成功；按既有配置跳过类型检查，不能视为 typecheck。
- `npm run lint`：通过；`npm run check:encoding`：995 份文本通过。
- 客户端打包、工作区环境、编辑器打包和 ESLint 配置测试共 34 项：最终 33 项通过，1 项已有失败。第一次并行构建时 ESLint 配置用例超过默认 5 秒；构建结束后独立复跑，保持原阈值，5 项全部通过。
- 已有失败：`tests/build/electron-editor-package.test.ts` 的 `accepts an archived app and byte-identical external resources`。测试样本只创建 main/preload/index，但验证器要求另有 7 个 skill-graph/source-flow 文件。临时还原本次全部删除项及 suppression 后，同一用例仍报相同的 7 个缺失文件；已恢复清理改动。未放宽验证器或改写测试样本，本次删除不涉及这些文件。
- `git diff --check`、新增文档本地链接与清单核对通过。构建生成的同内容文件已还原，不混入提交。
- 未启动 Electron 发布包、Android 构建或真实数据库；不把静态构建验证当作这些运行环境的验收。

## 回退与人工验收

回退本任务提交即可恢复全部删除文件及 lint 条目，不涉及存档或数据库迁移。人工检查 PR 删除清单、README 图片及当前开发入口；编辑器打包测试样本的已有缺口另行处理。
