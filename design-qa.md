# RED-101 Design QA

## Comparison target

- Source visual truth: docs/product/main-menu-screenprint-reference-v1.png
- Rendered implementation: output/playwright/13-post-rebase-final-1280x800.jpg
- Responsive evidence: output/playwright/14-post-rebase-final-960x640.jpg
- Mode chooser evidence: output/playwright/16-post-rebase-mode-chooser-1280x800.jpg
- Final side-by-side comparison: output/playwright/15-post-rebase-reference-vs-implementation.jpg
- State: local identity named “玩家”, default local rating ELO 1200, no local match records, main menu at rest.

## Normalization

- Source pixels: 1586 × 992 (16:10).
- Implementation pixels: 1280 × 800.
- CSS viewport: 1280 × 800; Playwright screenshot scale: CSS; device scale factor: 1.
- The source was downsampled to 1280 × 800 with high-quality bicubic interpolation before being placed beside the implementation. No browser chrome or device frame was included.
- Responsive verification used a 960 × 640 CSS viewport and produced a 960 × 640 screenshot. The measured document scroll size was exactly 960 × 640.

## Full-view comparison evidence

output/playwright/15-post-rebase-reference-vs-implementation.jpg places the normalized source and final implementation in the same image. The comparison confirms the same major composition: oversized distressed RED/VS/BLUE title, left red-and-black sword mass, central paper opening, red-versus-blue chess conflict with yellow impact color on the right, red primary action, four vertically grouped modes, lower secondary navigation, and an upper-right account stamp.

Focused crops were not required because the combined image keeps each side at a readable 1280 × 800. The account stamp, primary menu typography, footer labels, ink texture, and illustration edges remain legible at that size. The separate mode-chooser capture verifies the most important non-resting state.

## Required fidelity surfaces

- Fonts and typography: the static title is a real raster screenprint asset rather than a code approximation. Live Chinese labels use the existing system Chinese stack with heavy optical weights, compact line height, and the same hierarchy as the source. No actionable wrapping or truncation was found at either viewport.
- Spacing and layout rhythm: title, account stamp, main actions, footer navigation, and opposing illustration occupy the same visual zones as the source. The 960 × 640 capture has no overlap, clipping, horizontal scroll, or vertical scroll.
- Colors and visual tokens: cream paper, brick red, cobalt blue, deep navy/black, and sparse yellow impact rays match the selected direction. There are no gradients, glass surfaces, or dark web-dashboard containers on the main screen.
- Image quality and asset fidelity: the background and account avatar are real raster assets. Both preserve distressed silkscreen edges and paper texture without CSS art, inline SVG, emoji, placeholder shapes, visible seams, or stretch artifacts.
- Copy and content: “开始游戏 / 本地联机 / 单人练习 / 训练营 / 图鉴 / 战绩 / 更多” match the approved menu. The account stamp visibly includes player name, ELO 1200, and “账号设置”. Dynamic names and ratings remain connected to the existing identity and records logic.

## Interaction and browser evidence

- “开始游戏” opens a light screenprint mode chooser with local, server, and single-player choices.
- Keyboard sequence Tab → Enter selected local play and opened localPlayOverlay.
- Escape closed the chooser and returned focus to playMenuBtn; no menu overlay remained open.
- The account stamp opened the existing identity sheet and returned focus to userPill after close.
- “更多” exposed only server settings and resource-pack management; the forbidden PVP debugger entry was not restored.
- The browser reported one favicon/script 404 in both the pre-change baseline and final capture. No new console error or warning was introduced by RED-101.

## Comparison history

### Iteration 1 — blocked

- [P1][imagery] The first implementation used a softer chess-and-cards composition and omitted the source's black cut-paper masses and yellow impact rays.
- [P2][layout] Main navigation and the account stamp were positioned as a new composition instead of matching the source zones.
- Evidence: output/playwright/05-reference-vs-implementation-1280x800.jpg.
- Fixes: regenerated the background from the reference comparison, restored the black/red edge silhouettes and yellow conflict rays, moved the live menu and account stamp into the source-aligned paper openings, restored the solid red primary action, and added a real screenprint avatar asset.

### Iteration 2 — passed

- Post-fix evidence: output/playwright/15-post-rebase-reference-vs-implementation.jpg.
- The earlier P1/P2 findings are resolved. No actionable P0/P1/P2 mismatch remains.

## Findings

- No actionable P0, P1, or P2 finding remains.
- [P3][polish] The live account stamp omits the source's decorative dashed divider and chevron so that dynamic account content remains simpler and more robust.
- [P3][polish] Footer separators are represented by spacing rather than printed dots. This does not change hierarchy, meaning, or interaction.

## Open questions

- Final product taste remains a human acceptance decision; the implementation intentionally preserves dynamic identity content instead of baking the reference player's name into the raster.

## Implementation checklist

- [x] Reference and implementation normalized and compared in one image.
- [x] 1280 × 800 main state captured.
- [x] 960 × 640 no-scroll state captured.
- [x] Primary chooser and keyboard path verified.
- [x] Account settings visibility and focus return verified.
- [x] Five required fidelity surfaces reviewed.
- [x] Earlier P1/P2 findings fixed and re-compared.

final result: passed

---

## 2026-08-22 棋子图鉴增量 Design QA

### Comparison target

- Source visual truth: `output/playwright/18-pieces-reference-option-2.png`（项目负责人选择的第 2 版纸偶剧场图鉴）。
- Rendered implementation: `output/playwright/19-pieces-final-1280x800.png`。
- Responsive evidence: `output/playwright/21-pieces-final-960x640.png`。
- Neutral empty-state evidence: `output/playwright/20-pieces-neutral-empty-1280x800.png`。
- Final full-view comparison: `output/playwright/22-pieces-reference-comparison.png`。
- Focused detail/skills comparison: `output/playwright/23-pieces-detail-comparison.png`。
- State: “全部”筛选，26 个棋子，默认选中安娜，右侧展示 3 项完整技能；中立筛选单独验证当前 0 个棋子的预留空状态。

### Normalization

- Source pixels: 1586 × 992。
- Implementation pixels: 1280 × 800。
- CSS viewport: 1280 × 800；Playwright screenshot scale: CSS；device scale factor: 1。
- 源图和实现图的宽高比均约为 16:10；全视图对照使用高质量 Lanczos 等比归一到每侧 700 × 438，未包含浏览器边框或设备外框。
- 聚焦对照裁取两图右侧详情/技能区域并分别归一到 820 × 620；该裁切用于检查棋子信息、属性与技能密度，不用于评判顶栏位置。
- 960 × 640 实测 document scroll size 正好为 960 × 640；名单与技能区保留各自内部滚动。

### Full-view comparison evidence

`output/playwright/22-pieces-reference-comparison.png` 将来源与最终实现放在同一张图中。两者采用相同的主要构图：左侧窄纸票名册、右侧固定棋子舞台与技能卷轴、暖白纸面、红蓝帷幕和星形版画装饰、顶部返回/标题/阵营筛选。最终实现将标题和筛选从早期居中布局左移到参考图对应区域，解决了主要区域位置漂移。

`output/playwright/23-pieces-detail-comparison.png` 聚焦核对右侧：实现保留真实棋子头像和动态属性数据，同时把技能名称、类型、完整说明、行动点、冷却、目标、充能与关键词装进可独立滚动的纸张技能卡。重要文字在聚焦输入中可读，因此需要并已完成该聚焦检查。

### Required fidelity surfaces

- Fonts and typography: 标题使用楷体/系统中文回退形成参考图的手写印刷感；筛选实测 19px，棋子名 21px，技能名 19px，正文 15–16px。层级、字重、行高清楚；长棋子名在左侧名单单行截断，右侧显示完整名称。
- Spacing and layout rhythm: 1280 × 800 使用左窄右宽双栏；名单、人物档案和技能卷轴分区与参考一致。最终标题与筛选位置已按参考图左移。960 × 640 无页面级横向或纵向滚动、控件裁切或遮罩。
- Colors and visual tokens: 暖白/羊皮纸、朱红、群青、炭黑与少量金黄映射参考图；激活项为朱红底，hover 边框实测为 `rgb(201, 67, 45)`。没有暗色控制台、玻璃拟态或亮面 3D。
- Image quality and asset fidelity: 使用真实背景位图与棋子图片，保持原始清晰度和裁切；加载失败使用同画风的真实透明纸偶位图，不使用 Emoji、内联 SVG、CSS 插画或占位盒。实现保留动态角色真实头像，而非把参考图中的单个示意纸偶误用于全部棋子。
- Copy and content: “全部 / 光方 / 暗方 / 中立”与内容阵营定义一致；页面不再显示红方/蓝方。中立空状态明确说明未来 `faction: neutral` 数据会自动出现。技能文案直接读取现有技能数据，没有复制或改写规则。
- States and accessibility: 原生链接/按钮、明确 `:focus-visible`、`aria-pressed` 与 live region；Tab 第三个焦点为“光方”，Enter 后得到 13 个光方棋子；中立状态为 0 个并给出双栏空状态。支持 reduced motion。
- Icons: 最终版移除了早期的文本箭头/尖括号装饰，避免用字符伪造图标；当前控件靠文字、边框、位置和选中状态表达。
- AI shortcut artifacts: 未使用通用圆角后台卡片、Emoji、手写 SVG 或 CSS 绘制角色。纸面和帷幕均来自真实位图资产。

### Browser and interaction evidence

- 全部 / 光方 / 暗方 / 中立实测数量为 26 / 13 / 13 / 0；光方列表只含“光方”，暗方列表只含“暗方”。
- 默认安娜详情实测 3 项技能；阿尔萨斯切换后也显示 3 项技能及其完整元数据。
- 筛选 hover 实测字号 19px、边框 `rgb(201, 67, 45)`。
- 1280 × 800 document scroll size 为 1280 × 800；960 × 640 为 960 × 640。
- 960 × 640 下名单 client/scroll 为 441/1090，技能区为 193/502，证明长内容在预期内部区域滚动。
- 最终重载后 Playwright console error 级别为 0 条；favicon 使用空 data URL，未残留资源 404。

### Comparison history

#### Iteration 1 — blocked

- [P2][layout] 早期实现把图鉴标题放在整页中心、筛选靠右，参考图则将标题放在左侧名册上方、筛选紧随其右，改变了顶栏视觉重心。
- Evidence: `output/playwright/25-pieces-reference-vs-pre-alignment.png`。
- Fix: 将 1280 基准顶栏改为 110px / 280–420px / 剩余空间的三列结构，并把筛选改为靠起始边对齐；同时移除早期文本箭头，消除 favicon 控制台噪声。

#### Iteration 2 — passed

- Post-fix evidence: `output/playwright/22-pieces-reference-comparison.png` 与 `output/playwright/23-pieces-detail-comparison.png`。
- 先前 P2 顶栏漂移已解决；没有剩余可执行的 P0/P1/P2 问题。

### Findings

- 没有剩余的 P0、P1 或 P2 问题。
- [P3][imagery] 参考图右侧使用单个全身纸偶示意，实现改用每个棋子的真实头像，以避免所有角色共用错误人物图并保留数据身份。若未来补齐全角色同画风全身纸偶资产，可在不改 UI 的情况下替换图片。
- [P3][polish] 为满足大字号与完整技能说明，1280 × 800 首屏通常显示约两张技能卡，其余技能在右侧独立滚动区内；技能总数始终可见。

### Implementation checklist

- [x] 来源与最终实现同屏归一比较。
- [x] 详情/技能区域聚焦比较。
- [x] 修复早期 P2 顶栏位置漂移并重新截图比较。
- [x] 1280 × 800 和 960 × 640 验证。
- [x] 四个阵营筛选、hover、键盘、棋子切换和中立空状态验证。
- [x] 字体、布局、颜色、图像质量、文案、图标、状态和可访问性检查。
- [x] 最终控制台 error 级别为 0。

final result: passed
