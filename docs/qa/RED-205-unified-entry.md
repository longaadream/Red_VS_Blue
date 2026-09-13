# 双端更新入口统一

用户在安卓验收包构建期间要求统一入口。延续 RED-205 验收任务，新的 Linear 任务记录被自动审批拒绝，仅保留本地合同。

base_branch: main；base_sha: 53c2c9ca3eef73d2158645b93138e242c225c604（2026-09-13 已刷新）。独立分支从 main 创建后整合既有 RED-205 双端候选 d84c80e。

范围仅 data/pages/index.html、js/official-updates.js、android-maintenance.html、相关测试及本文档。风险 Medium。不变更原生下载、签名、补丁、安装或玩法，不触碰其他 UI 工作区。

验收：Windows/Android 同一右上角玩家旁 36px 更新图标；Windows 立即打开原弹窗、Android 跳转现有维护页更新区域；底部都保留资源包名称，Android 跳转资源区域；普通浏览器不暴露原生更新入口。

回归：真实 Edge 浏览器加载原入口脚本，修复前 Android 图标不存在而失败；修复后覆盖两端点击、布局尺寸、Windows 状态请求延迟也先弹窗、普通浏览器隐藏、资源导航锚点。原生接口由测试夹具提供，不冒称手机原生安装验证。

审查指出原生维护页按完整 URL 精确授权，带 hash 会失效。已保持无 hash 的原地址，使用 sessionStorage 一次性传递区域选择，页面内滚动后清除；测试从真实 Activity 读取受信地址，核对实际导航目标匹配，不改变原生授权规则。

执行方式：设置 RVB_PLAYWRIGHT_MODULE 指向已有 Playwright，再运行 node tests/electron/update-entry-smoke.cjs。默认浏览器 msedge，可通过 RVB_BROWSER_CHANNEL 指定本机已安装通道。

交付两端重新打包，检查共同菜单资源、APK 包名/递增版本/签名一致以及内置更新类。安装和真机体验由用户验收；不合并 main、不公开发布。回退本独立入口提交即可。
