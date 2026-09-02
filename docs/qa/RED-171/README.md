# RED-171 主界面双栏布局验证

## 基线与范围

- 分支：`codex/red-171-main-menu-layout`
- `base_branch: main`
- `base_sha: 55037468e07dbeff9729d3cff790806cef5c7c35`
- 目标：将 `data/pages/index.html` 从纵向网页列表重组为游戏式双栏主菜单，不改动既有模式、联机、身份、资源包或战绩业务逻辑。

## 验收证据

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 桌面双栏与单屏布局 | 通过 | 1280×720、1440×900 的 `scrollWidth/scrollHeight` 均等于视口尺寸 |
| 四个一级入口 | 通过 | 浏览器实际切换“联机对战 / 开始冒险 / 训练营 / 棋子与地图”，对应 `tabpanel` 与选中状态同步 |
| 联机入口保留 | 通过 | 实际打开“我当主机”“连接主机”“连接游戏服务器”三个既有 Sheet；静态浏览器中主机模式正确显示环境不支持提示 |
| PVE 与训练营区分 | 通过 | PVE 一级入口命名为“开始冒险”，训练营保留独立入口；事件仍分别映射 `startPve()` 与 `goToTraining()` |
| 图鉴入口保留 | 通过 | “棋子与地图”面板保留 `pieces.html` 与 `maps.html` 两个既有目标 |
| 次级入口保留 | 通过 | 战绩、资源包、开发者中心置于底栏；账号置于右上角；实际打开战绩与账号 Sheet |
| 窄屏结构回流 | 通过 | 390×844、844×390 均无水平或垂直页面溢出，所有核心入口在单屏内可达 |
| 键盘与语义顺序 | 通过 | 一级模式使用 `tablist/tab/tabpanel`，方向键、Home、End 可切换并移动焦点；动作均使用原生 `button` |

## 截图

- [1280×720](./evidence/main-menu-1280x720.png)
- [1440×900](./evidence/main-menu-1440x900.png)
- [390×844](./evidence/main-menu-390x844.png)
- [844×390](./evidence/main-menu-844x390.png)

## 自动检查

### 通过

- `npm.cmd run check:main-baseline`
  - `HEAD` 与 `origin/main` 均为 `55037468e07dbeff9729d3cff790806cef5c7c35`。
- 修改前：`npx.cmd vitest run tests/ui/main-menu-layout.test.ts`
  - 4/4 失败，旧页面缺少 `game-shell`、四模式导航、双栏 CSS 和局部切换函数。
- 修改后：`npx.cmd vitest run tests/ui/main-menu-layout.test.ts`
  - 4/4 通过。
- `npx.cmd prisma generate`
  - Prisma Client 生成成功，仅写入未跟踪的依赖目录。
- `npm.cmd run typecheck`
  - `next typegen` 与 `tsc --noEmit` 通过。
- `git diff --check`
  - 无空白错误；仅显示仓库既有的 Windows 行尾转换提示。

### 有限制的检查

- `npm.cmd run lint -- data/pages/index.html tests/ui/main-menu-layout.test.ts`
  - 在加载 ESLint 配置时失败，原因是仓库配置引用了未安装的 `eslint-plugin-import`；未执行到目标文件规则。
- `npx.cmd --yes html-validate data/pages/index.html`
  - 主菜单新结构未产生错误；仍报告 97 个既有遗留问题：71 个旧 Overlay 内联样式、22 个旧 Overlay 按钮缺少显式 `type`、4 个既有 void 元素风格问题。它们位于 RED-171 未修改的 Overlay 或文档头部，按任务排除项未顺手重构。
- `node .../impeccable/scripts/detect.mjs --json --scope layout data/pages/index.html`
  - 正则降级模式返回 `[]`；检测器环境缺少 `htmlparser2`、`css-select`、`css-tree`、`domutils`，因此浏览器截图与尺寸测量作为主要布局证据。

## 浏览器冒烟说明

使用本地静态服务器与 Playwright CLI 验证。四种目标视口均无页面溢出。控制台存在两个静态托管环境噪音：缺失 `favicon.ico`，以及 Service Worker 脚本的静态响应错误；页面脚本、模式切换和所有被测 Sheet 正常工作。点击“连接主机”会按既有逻辑发起 LAN 探测请求，关闭 Sheet 后停止观察，不属于布局回归。

## 已知风险与回退

- Medium 风险集中在主界面导航层级变化；既有业务函数未重写。
- 示意图中的“设置”没有对应现有目标页，本任务没有制造死链。
- 回退本任务提交即可恢复旧纵向菜单；无存档、数据库或协议迁移。

## 人工验证建议

1. 在 Electron 客户端打开首页，确认默认显示“联机对战”。
2. 依次打开三种联机 Sheet，并在真实局域网环境确认主机启动与扫描行为。
3. 切换“开始冒险”“训练营”“棋子与地图”，确认入口名称符合产品预期。
4. 在 1280×720 窗口确认所有主要与次级入口无需滚动即可看到。
