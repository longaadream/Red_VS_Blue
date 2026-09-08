# RED-197 · 项目主页整理

状态：实现与验证记录。风险：Low。AI 角色：实现者。

## 合同与基线

- 用户授权：整理 GitHub 项目主页，清理无用文件，编写开发者 README，并基于真实游戏界面制作介绍图；另明确授权同步 Linear。
- 任务：[RED-197](https://linear.app/redvsblue/issue/RED-197)。
- `base_branch: main`
- `base_sha: 012e595fe2affb29725c45df0c2cd819704768a0`
- 分支：`codex/RED-197-github-homepage`。独立 worktree，不修改其他开发目录。
- 范围：README、文档入口、媒体与截图复现脚本、废弃根目录调试文件、对应失效 ESLint suppression 和忽略规则。
- 不涉及：运行逻辑、角色数值、依赖/锁文件更新、正式测试删除、他人工作区清理、合并或发布。
- 验收：项目介绍清晰；开发入口与代码相符；本地链接有效；图片来自当前真实界面且标明艺术加工；清理有用途与引用证据；检查结果如实记录。

## 清理依据

删除前用 `rg` 扫描可见与隐藏受控文件，并检查 package scripts、构建配置、Vitest 配置与 ESLint suppression。以下文件没有运行入口引用；命中的 ESLint suppression 已精确删除。

| 删除项 | 原用途与退役依据 | 现役入口 |
| --- | --- | --- |
| `test-map-load.js`、`test-map-loading.js`、`test-map-path.js`、`test-map-path.mjs`、`test-map-repository.js`、`test-map-repository.mjs`、`test-map-repository.ts` | 一次性日志脚本，读取已不存在的 `arena-8x6.json`；其中 CommonJS 路径脚本重复声明 `__filename` / `__dirname` | `tests/game/map-catalog.test.ts`、`map-selection.test.ts` |
| `test-nilasec-fix.js` | 一次性检查已不存在的 `data/pieces/red-nilasec.json` | 正式角色与规则测试 |
| `test-status-json.js`、`test-status-system.js` | 调用已不存在的 `lib/game/status-effects` 模块 | `tests/game/` 内现役状态与规则测试 |
| `test-storage.js` | 在旧 `data/rooms` 目录写入再删除测试文件的手工诊断；当前对局持久化为 PostgreSQL | `tests/integration/postgres/` |
| `postcss.config.mjs.bak` | 无引用的备用配置，Next 不加载 `.bak`；当前 build 显式调用 `scripts/build-tailwind.mjs` | 现有构建脚本 |

合计删除 12 个文件。`tsconfig.json` 的 `test-map-*.ts` 通配排除保留，不改变类型检查配置。正式测试由 `vitest.config.ts` 限定到 `tests/**/*.test.{ts,js}`，没有删除该范围的文件。

保留现有 `output/playwright/`、`docs/qa/` 验收证据，以及 demo HTML、历史教程、Android 和运行资源。它们仍有追溯或开发用途。忽略规则新增备份、Java 编译文件、嵌套本地 worktree 和本次预览输出；不因此移除已有受控文件。

## 界面与图片

通过现有 `docs/qa/RED-186/serve.cjs` 与主线页面拍摄 1600 × 1000 的菜单、图鉴、战斗截图。战斗采用已有 QA 固定训练摆位和手牌；无在线对战或联机能力验证。

`capture-homepage.cjs` 复现完整原图，使用单独安装的 Playwright 和系统 Edge。最终宣传图以棋盘为主体，小比例标题条幅辅助，移除手牌与图鉴拼贴。`capture-homepage-combat.cjs` 通过规则引擎实际执行佐助「千鸟」，捕获位移与伤害阶段：佐助从 (12,6) 到 (12,11)，鸣人生命从 12 降至 8，并获得控制状态。原生伤害字放大并定格，`posters.html` 裁剪棋盘、添加粗线速度线。游戏插图与棋盘不经 AI 重绘，最终海报也未采用先前生成的 AI 背景。弃用版本及实验图层移入忽略的本地预览目录。事件证据与原图 SHA-256 见 [媒体说明](../media/README.md)。

## 验证

- 主线基线：通过，开始工作时 ahead 0 / behind 0。
- 安装：普通 `npm ci` 命中现有 Zod peer 冲突；`npm ci --legacy-peer-deps --ignore-scripts` 成功安装锁定依赖。为本次截图/构建跳过 Electron 下载脚本；README 面向完整客户端安装，不使用 `--ignore-scripts`。
- 浏览器引擎：`npm run build:game-engine` 通过；构建生成文件不计入本次文档变更。
- 实际页面：菜单、图鉴、训练场景截图完成，`pageErrors: []`。
- `npm run build`：通过，Next standalone 与静态资源复制完成（此命令按现有配置跳过类型检查，不等同于 typecheck）。
- `npm run lint`：通过；新增海报导出脚本随后单独 ESLint 检查通过。
- 正式地图回归：2 个文件、29 项测试通过。
- `npm run check:encoding`：998 份目标文本通过；新增 Markdown 另做 UTF-8 与链接检查。
- `git diff --check`：通过。
- 新增与更新文档的本地链接、UTF-8、README npm scripts、图片加载与 390px 页面横向溢出检查通过。
- 未运行 Electron 进程/发布包、在线对局、PostgreSQL 集成或全量游戏测试；此次只验证相关构建、原始静态页面和文档。

## 回退

通过 Git 回退本任务提交即可恢复文档与被删除的历史文件。本次不修改数据库、存档或游戏运行行为。
