# RED-243 联机幻想桌游美术候选

任务：https://linear.app/redvsblue/issue/RED-243

## 范围与基线

用户选择了浅色冒险册、成员名册、木桌与手绘扁平图标的幻想桌游方案，并要求先实现体验。

- base_branch: main
- base_sha: `9d1b0c30801cd733ec4cede37ce1ef0889a2313a`
- 已执行 `git fetch origin --prune` 及显式 main 刷新。
- 新分支 `codex/RED-243-fantasy-online` 从该 main 创建，再 fast-forward 继承 `832506e314292567fd42281fdcf847f101d4db73`，保留 RED-240/241/242 所有候选修复。
- 风险 Medium：联机页面视觉与布局；不改鉴权、规则、持久化、业务请求和战斗页面。
- 允许修改：multiplayer/community/official HTML、独立 fantasy-online.css、fantasy-* 图片、直接 UI 测试及本 QA 文档。
- 验收：创建/加入/筛选/服务器选择/诊断/社区和排位入口可用；空和错误状态真实；键盘焦点与窄窗口不阻断操作；美术接近已选浅色纸册方案。
- 不包含新好友邀请通知、玩家档案、回放下载及统计后端。大厅继续使用真实房间码加入，好友仍在社区页，不以占位数据冒充线上功能。

## 美术来源

已选示意图：`C:/Users/lngsc/.codex/generated_images/01a0fe4a-5e2c-75a3-ad85-910286259f5a/exec-af444a42-aa41-4841-9acd-09ab66b2003e.png`。

使用内置 image_gen 生成独立无界面文字资源，没有把整张示意图贴成页面，也没有修改原有角色头像。

- `data/pages/images/tabletop/fantasy-lobby-table.png`：1920×1200；手绘幻想木桌与苔绿桌垫，地图、烛台和骰子局限于外围，中央留空承载真实 HTML。
- `data/pages/images/tabletop/fantasy-ledger-paper.png`：1536×1024；浅冷象牙纸纤维，右下角极淡山脉松树速写，中心低对比以保证正文可读。

生成提示词摘要：fantasy tabletop RPG, 2D storybook hand-painted matte wood and sage felt; perimeter-only props, clear center; pale cool ivory matte paper, subtle fibers, faint bottom-right mountains/pines; no text, UI, buttons, yellow/burned parchment or ornate golden borders.

## 验证记录

修改前运行 5 个直接测试文件：22 项通过，1 项既有失败。失败为 `multiplayer-entry.test.ts` 仍断言导航恰好两个链接，但 RED-242 的 official 页面已经增加社区入口。本任务将其改为验证房间、排位和社区的实际导航目标；不更新快照。

最终直接回归：7 文件 35 项通过（multiplayer-entry、mobile-online-layout、community、community-lifecycle、community-presence、official-session-persistence、battle-timer-refresh）。编码检查 1495 文本文件通过，diff 检查通过，main-baseline behind 0。业务 JavaScript 未修改，不涉及新增类型或服务端构建。

独立审查发现短窗口 footer、排位 dock 对比度与 781–900px 断点交接问题；已取消固定最小高度、明确设置浅色 dock 与深色 rank-message、将窄屏断点统一为 900px。独立执行 3 文件 16 项测试通过，最终文字颜色经浏览器读取为 rgb(109,89,67)，背景 rgb(241,226,199)。

浏览器使用本机候选 `http://127.0.0.1:38843`：

- 1280×800：创建弹窗、关闭、非官方服务器字段展开、无效邀请码报错、诊断弹窗入口可操作。
- 844×390：页面采用文档滚动，大厅全部控件可达；排位页底部服务器设置实际点击打开成功。
- 760×1000：社区真实好友搜索成功，document scrollWidth=760，无横向溢出。
- 1586×992：同源图比例进行整体视觉对照，最终截图 `RED243/lobby-final.png`。
- 1920×1200：大厅无横向溢出，真实空列表保留，未放入示例房间冒充线上数据。
- 最终大厅控制台 error 列表为空。

证据另见 `RED243/lobby-1280.png`、`lobby-short.png`、`ranked-short.png`、`community-760.png` 和 `design-qa.md`。

限制：本轮没有创建真实 Electron 主机并完成双人入房；不宣称整条联机链路验收通过。原生客户端打包未运行。排位旧测试 official-profile.test.ts 的既有 VM URLSearchParams 缺失问题未修改。图中好友邀请、玩家头像、地图缩略图等未来数据功能不属于本轮美术候选，当前实际入口和数据保持不变。材质资源约 7.3 MB，后续可独立压缩优化。

## 回退

撤销本任务 HTML 样式引用、独立 CSS、资源及对应导航测试变更；保留所有继承修复和原社交数据。不得整目录覆盖。尚未合并或发布。

## 第二轮：统一册体与操作触感（2026-10-08）

用户拒绝第一轮视觉候选；基础自动测试通过不等于美术验收通过。人工截图与同状态重现见 `RED243/ranked-v1-feedback.png`。

| 第一轮问题 | 本轮设计方向 | 验证依据 |
| --- | --- | --- |
| 页头、左栏、页脚黑色框架挡住桌面 | 透明壳层，局部文字标签保可读性 | 同尺寸排位页截图 |
| 标题、标签、竞技场、积分、底部操作各一张纸 | 一个连续的册体与纸边，资料成为册内边栏 | 排位准备/战绩/榜单切换 |
| 按钮孤立、只有颜色变化 | 册边书签、短促悬停抬起与按压下沉 | 点击/键盘操作与样式检查 |
| 统一皮肤可能遮住原控件 | 保留全部业务 ID 和隐藏/禁用语义 | 创建弹窗、社区、短窗口冒烟和既有测试 |

该轮仍在同一个分支和 PR #231 中推进，无规则、业务 JS、鉴权、依赖或保存格式改动。
### 第二轮验证结果

- 实际代码只改 `data/pages/css/tabletop/fantasy-online.css`；三个页面继续使用原 HTML 与业务 JS。
- 移除页头/左栏/页脚黑色框架；最大 1780×1080 的整体框架在大屏居中，背景露出；共享纸面与分层封皮，排位/社区/邀请面板改为册内分区。
- 140ms 悬停/按压反馈，键盘焦点不位移；减少动态效果偏好关闭动画。未增加音效或动画库。
- 直接回归：7 文件 35 项通过。编码检查1495文件通过；diff检查通过；main-baseline behind0。独立审查最终无剩余实质问题。
- 审查和实测修复：排位区被 flex 压缩导致席位裁切；低高度旧 sticky dock 遮挡规则；册边超出5px导致短屏导航横向滚动；滚动时装饰伪元素留下接缝。均由表现层修正。
- 2215×1404：最终完整截图 `RED243/ranked-v2-desktop.png`，背景与连续册体可见。
- 1280×800：最终 `RED243/ranked-v2-1280.png`，完整席位和匹配按钮可见；dock bottom727.31 < main bottom738，无重叠。准备/战绩/榜单切换成功。
- 1280×600：展开规则后 stage bottom482.30，dock top502.30，间隔20px；键盘可滚动到匹配按钮。`ranked-v2-short.png` 记录修复后短屏状态（之后进一步删除装饰接缝并调整紧凑间距）。
- 844×390：实际点击服务器设置弹窗，证据 `ranked-v2-844-dialog.png`。
- 大厅1280×800：创建弹窗打开、Escape关闭，证据 `lobby-v2-1280.png`。社区760×1000：真实搜索星灯同伴成功，证据 `community-v2-760.png`。
- 最终排位页控制台error为空，临时视口已恢复。未触发真实匹配、发布或合并；未重新打包Electron。
- 美术与触感仍等待用户体验判断，不宣称已通过人工验收。