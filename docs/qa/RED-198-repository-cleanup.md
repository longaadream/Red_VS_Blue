# RED-198 · 仓库与过时图片清理

风险 Medium；AI 角色：实现者。清除已退役文件与过时视觉素材，减少 GitHub 根目录列表，并保持当前开发和打包入口可用。

- `base_branch: main`
- `base_sha: 0debcd34126803686719b9ce87a490fe4795d13d`
- 分支：`codex/RED-198-repository-cleanup`
- [Linear 合同](https://linear.app/redvsblue/issue/RED-198) · [PR #170](https://github.com/longaadream/Red_VS_Blue/pull/170)

## 清理结果

- GitHub 根目录受控条目从 48 减到 35（本次扩展前为 43）；根目录列表减少约 27%。
- 删除 120 张旧图片，共 15,976,354 字节：旧暗黑写实概念图与 RED-68 棋盘图 21 张、旧 Playwright 界面图 60 张、旧 QA 截图 38 张、不再使用的主页图鉴截图 1 张。
- 另删除 14 个退役脚本、演示页、模板占位资源等，共 50,676 字节，删除 3 个文件的 lint suppression。整个 PR 实际删除 134 个文件；迁移不计入删除数。
- 迁移 19 个文件：两份 Electron Builder 配置、Colyseus 配置和 Compose 文件归入 `config/`；5 个程序图标文件归入 `config/branding/`；两份根目录教程归入 `docs/technical/` 和 `docs/product/`；8 个输出记录/图标证据归入 `docs/qa/archive/`。
- 更新 npm、开发服务、程序图标、验证脚本和相关测试的路径；Compose 从根目录使用 `--project-directory .`，保持原项目名和数据库卷身份。
- README 增加配置目录入口，文档目录提供教程与归档导航；`output/` 作为临时输出同时纳入 Git 和 ESLint 忽略范围。

图片逐项大小、SHA-256、迁移映射见 [图片清理清单](RED-198-visual-cleanup-manifest.json)。旧图片的文字验收记录保留，图片引用改成固定提交 `a7849ce9eb3fc9e2fbc000afdd5f770b6f57e37a` 的普通链接，不再嵌入旧界面。清理当前文件树不会改写 Git 历史。

## 退役文件依据

检查 1,844 个受控文件，其中 1,293 个文本文件参与引用扫描；另核对目录引用、动态资源加载、package scripts、Next/桌面打包和 Android 构建。14 个退役文件的删除前哈希与引用位置见 [机器可读清单](RED-198-cleanup-audit.json)。

| 删除文件 | 依据及当前入口 |
| --- | --- |
| `scripts/stage-server-resources.js`、`scripts/cleanup-server-resources.js` | 为已删除的 Electron Server 打包器维护 `_standalone`，仅被自身注释、失效 lint suppression 和已取代 ADR-0003 的历史命令提及。现役客户端使用 `stage-client-resources.js` / `cleanup-client-resources.js` 与 `_client-stage`；package scripts 和两份当前 electron-builder 配置不调用旧脚本。 |
| `scripts/migrate-player-ids.js` | 对旧 JSON 房间的 players/hostId/battle 标识做递归小写改写；无调用入口。当前 Windows 对局存储为 PostgreSQL，切换合同明确不导入旧对局数据。此次只删除脚本，没有执行迁移。 |
| `scripts/unlock-build.ps1` | 未被脚本、配置或文档引用的旧手工打包辅助，会按宽泛进程名强制结束进程并清除 app.asar；现役打包流程不调用它。 |
| `ui-map-demo.html`、`resource-icon-demo.html` | 根目录自包含的早期示意页，使用内嵌假数据/固定技能文字，没有规则引擎接线或入口引用；实际界面位于 `data/pages/`。不进入 Next 路由或桌面包的页面目录。 |
| `docker-compose.yml` | 原 `game_postgres` / `gamedb` 配置，仓库无引用、当前连接流程不使用该数据库身份；保留现役 `config/docker-compose.colyseus.yml`，并在构建文档补充明确启动命令。没有停止容器或移除 volume。 |
| `styles/globals.css` | 未被导入的初始模板主题；`app/layout.tsx` 和 `scripts/build-tailwind.mjs` 均明确读取 `app/globals.css`。 |
| `public/placeholder-logo.png`、`placeholder-logo.svg`、`placeholder-user.jpg`、`placeholder.jpg`、`placeholder.svg` | 5 张模板占位图，没有代码、HTML、CSS、JSON 或文档引用；不是角色/卡牌资源，未被内容 ID 或动态回退规则使用。 |
| `fi/iki/elonen/NanoWSD$WebSocket.class` | 位于 Android source set 外的散落编译文件；无加载引用，Gradle 仅扫描 app/libs 中的 JAR。当前 `MobileHttpServer` 已使用项目自己的实现。已有 `*.class` 忽略规则避免再次纳入。 |
## 保留范围

当前主页的实机技能图、角色/卡牌/棋盘运行美术、游戏数据和正式测试保留；近期 RED-191、RED-192 技能编辑器证据保留。原始教程内容按用途迁移，旧版技能作者教程增加现役标准入口。ADR 和文字验收保留，只有迁移路径与历史图片链接更新。Android、mobile-server、relay-server 仍有代码和构建入口，未宣布退役。敏感配置、存档、数据库及其他工作区未修改。

图片扫描中的唯一非 Markdown 同名命中是 `tests/electron/windows-client-development-smoke.mjs` 的临时输出文件名；它在 smokeRoot 内生成图片，不读取被删除的 QA 图片。

## 验证与限制

- 本轮开始已成功 fetch、对齐远端任务分支，`check:main-baseline` 通过（main 为上述完整 SHA，behind 0）。提交前复检结果记录在 PR。
- `npm.cmd run build:colyseus` 与 `npm.cmd run build` 通过。Next 依既有设置跳过类型检查，不能视为 typecheck。
- 使用安装的 Electron Builder 读取两份新路径配置并通过 schema 校验；源码入口、beforeBuild 和图标路径存在。Colyseus 开发入口连同迁移后的配置经 esbuild 解析打包通过，没有连接真实数据库。
- `npm.cmd run lint` 通过；`npm.cmd run check:encoding` 通过（1,000 份文本）。临时审计脚本导致过一次 lint 失败，统一忽略已归档完毕的 `output/` 后复检通过，正式归档脚本仍参与 lint。
- 六个相关测试文件共 60 项，最终 59 项通过、1 项已有失败。覆盖客户端/编辑器打包、Colyseus 路径、安全边界、工作区和 ESLint 配置。并发时 ESLint 用例超过默认 5 秒；单独复跑及配置调整后再跑均在原阈值内 5/5 通过。
- 已有失败为 `tests/build/electron-editor-package.test.ts` 的 `accepts an archived app and byte-identical external resources`：样本缺少验证器要求的 7 个 skill-graph/source-flow 文件。首轮临时还原全部清理项和 suppression 后已复现同一失败；本轮迁移后缺失列表相同。没有放宽验证器或补改样本。
- 核对 369 处本地 Markdown 链接，无新增断链；117 处固定提交图片链接的目标均存在；120 张删除图片逐张历史哈希匹配。19 项迁移旧路径消失、新路径存在，根目录计数一致。运行资源没有新增删除。
- 独立 AI 审查完成：配置接线、运行资源边界及图片哈希无剩余阻断项；修正了图标证据断链、嵌套截图链接和归档脚本命令路径。
- 未制作或启动完整 Electron 发行包、未跑 Android 构建或真实 PostgreSQL 实例。配置静态校验不能替代这些环境的验收。

## 回退与人工验收

回退本任务提交可恢复删除文件与原路径，不涉及数据迁移。人工浏览 PR 分支根目录和 README，确认目录列表、实机技能图片与文档导航；使用既有 npm 入口验证需要的本地开发环境。PR 保持待审阅，不合并或发布。
