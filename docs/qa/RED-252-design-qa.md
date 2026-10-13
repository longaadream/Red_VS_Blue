# RED-252 句子编辑器视觉核对

final result: blocked

本记录遵守任务 allowed_paths，保存在 docs/qa；尚不构成最终界面验收。

## 证据

- 来源：`C:/Users/lngsc/AppData/Local/Temp/codex-clipboard-77a811ac-3e4c-48d4-9b85-6455f550d692.png`
- 实际 Electron：`docs/qa/RED-252-gameplay-module/sentence-editor-smoke.png`
- 视口/像素：1487 × 1058，桌面浅色，火球伤害参数弹层打开。两张图在同一工具输出共同查看，未缩放。
- 状态差别：实现图另有试用成功提示，参考图无该提示；不把提示引起的局部高度差当作静态布局缺陷。
- 实际交互：参数编辑、保存、关联 Cluster 草稿试用、重复点击阻止、失败反馈由 sentence-editor-smoke 验证。

## 本轮已改

- 技能列表中文名称由 12px 提高到 17px，默认隐藏英文 ID，悬停保留 ID。
- 试用成功提示由 jaina/good 内部值改为训练场可见的试用棋子名称。
- 试用按钮从卡牌画面内部移到预览卡片下方，恢复清晰的交互区；保存按钮统一圆角。
- 为中文显式添加 Microsoft YaHei/PingFang SC 无衬线后备。
- 修改后重新运行真实 Electron smoke 成功，并重新截图。

## 尚存发现

- [P2] 参数按钮缺少参考图的展开提示，导航仍使用 PC/SK/CD 等技术缩写。需使用项目可用图标资源改善可发现性，不能把交互完成当成视觉通过。
- [P2] 参考图的工具导航、卡牌美术边框与主效果区域留白仍存在明显差异。主框架已有左导航/中间句子/右预览结构，尚未达到逐项视觉验收标准。
- [P2] 尚需在窄桌面视口检查主操作和弹层是否可达，当前只验证 1487 × 1058。

## 五项核对

- 字体：中文列表已修正，导航与辅助文案相较参考仍偏小。
- 间距：三栏构成一致，主效果区和预览卡高度/留白仍需调整。
- 颜色：白底、浅蓝参数、高对比正文已具备；按钮圆角和浅蓝试用区已修正。
- 图片：使用实际火球图和纸张资源；参考卡框构图尚未复刻，不报告 1:1 一致。
- 文案：保留基线火球术实际费用/描述，不能按示例图任意改成费用 3。内部试用标识已隐藏。

下一步先处理以上 P2，再以同视口弹层状态重截图复核；本轮不宣称界面完成。


## 第二轮（图标与窄窗口）

- 使用项目已安装的 lucide-react 库生成导航与展开图标（`scripts/build-editor-icons.mjs`），替换技术缩写；不是手绘 SVG。
- 参数标签改为参考图中的圆角矩形并加入展开箭头、aria-expanded；真实 Electron 参数编辑/保存/试用回归通过。
- 760 × 900 单列预览截图：`docs/qa/RED-252-gameplay-module/sentence-editor-narrow.png`。新增保存/高级按钮边界检查通过。
- 加强弹层边界检查后发现伤害参数弹层左边落到 x=135，覆盖侧栏；已按可见编辑列边界限宽并平移，重跑边界断言和全部 sentence smoke 通过。
- 第一个 P2（图标/展开提示）已修复；第三个 P2（窄窗口操作可达）已补自动检查及截图。参考卡框与主区域留白差异仍待后续视觉调整，因此 final result 保持 blocked。

## 第三轮（阅读层级与效果区）

- 技能标题图由 54px 放大到 72px，步骤标号改为浅蓝底 46px 圆形。
- 桌面效果区最小高度 620px，新增效果/条件移至底部，参数弹层拥有独立空间；窄窗口恢复自然高度。
- 卡牌描述提升至 18px 并增加正文留白；保持实际基线费用与描述。
- `node tests/electron/sentence-editor-smoke.mjs` 通过，重新检查实际 1487×1058 弹层截图。主区域比例比第二轮接近参考图，卡框美术仍不同，保留 blocked，不宣称像素一致。

## 卡框美术资产

- 工具：内置 image_gen（imagegen skill）；非 CLI，未改变卡牌数值和说明。
- 工作区资产：`electron-editor/ui/assets/skill-card-frame-v1.png`。
- 原始输出：`C:/Users/lngsc/.codex/generated_images/01a11dfe-2a13-7980-b56f-7b44f35d1473/exec-5f76b439-e130-45ea-84cd-aba8c9c2d294.png`，保留原文件。
- PNG 类型 6（RGBA），窗口 (500,300) 与外侧 (0,0) 实测 alpha=0；只读取像素确认透明度，没有程序修改图像。
- 实现为装饰覆盖层，插图、技能名、描述、费用仍为 DOM/实时规则数据，不烘焙到图里。
- 最终生成提示词：

> Create a production-ready transparent PNG game card FRAME asset only, portrait aspect ratio 2:3, front view perfectly flat with no perspective. Elegant polished fantasy tabletop trading card frame, carved charcoal bronze outer rim with restrained warm gold bevels, softly aged ivory parchment text panel in bottom 35%, gently curved blank parchment title ribbon across the boundary at 61% height. The upper illustration window (from x 8% to 92%, y 5% to 59%) must be FULLY TRANSPARENT, and background outside the rounded outer border must also be fully transparent. No illustration in the window, no fire, no characters. No text, letters, digits, cost badges, icons, logos or watermarks anywhere. Card occupies 96% width and 98% height centered. Blank quiet parchment below title has ample uncluttered writing room. High craftsmanship with readable silhouettes and soft bevel lighting at small UI size, tasteful medium contrast material details, consistent border thickness. This is a reusable interface frame overlay, not a whole UI screen.

- 卡框接入后真实 Electron smoke 通过，已查看桌面截图；费用/说明仍取真实数据。
- 修复列表重绘重置滚动导致当前技能离开可视范围的问题：保留滚动位置，选择或保存后仅滚动必要距离展示当前条目；新增当前选择可见断言，通过真实 Electron smoke。更新后的图也保留窄窗口弹层边界检查。
- 当前视觉已接近参考的浅色三栏、句式参数、下方增添动作与右侧卡牌；仍需覆盖非简单技能的完整编辑旅程后才能给整个可视化框架通过结论。
