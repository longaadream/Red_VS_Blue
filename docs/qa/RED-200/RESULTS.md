# RED-200 验证记录

基线：`12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441`。
候选分支：`codex/RED-200-resource-workspace`。

最终验证：6 个相关测试文件共 74 项经回归通过；最初旧文案断言失败，随新的简化发布入口更新断言后相关 14 项复验通过。编辑器 TypeScript、变更文件 ESLint、界面脚本语法、diff 检查及 main-baseline 均通过。

2026-09-09 候选为 `dist/editor/RED vs BLUE Editor 0.1.0.exe`（便携版）和 `dist/editor/RED vs BLUE Editor Setup 0.1.0.exe`（安装版）。打包完整性验证通过，核对 676 个数据文件、47 个脚本文件及 165 个运行时文件。当前 checkout 没有 `public/images`，因此候选没有捆绑官方图片；导入包图片与测试图片正常工作。

最终实际界面 smoke 通过并截图。一次被遮挡窗口的自动刷新检查超时；测试添加 `Page.bringToFront` 后通过，产品仍保持仅可见工作台轮询。原生导入按钮及 preload API 存在且可见；未自动操作系统文件选择框。

## 已验证

- 真实资源管线：原包导入、完整性/签名/可执行内容拒绝、父版本不匹配拒绝、导入后原版撤销、仅地图包修改并接受。
- 工作台：自动差异的数据接口、文件级部分接受/撤销、全项目共同接受基准、未接受草稿隔离、依赖检查、并发冲突、图片扩展名。
- 真实构建/签名/解析：只打包已接受字节；连续 A→B→C 的完整基包＋两个补丁实际解析至 C；重复发布复用缓存；长更新说明；两个发布服务实例的仓库锁。
- GitHub API 模拟：草稿、资产摘要核对、上传结果不确定后的重试、远端不一致拒绝。未上传真实 GitHub Release。
- 实际 Electron 界面 smoke：外部修改自动展示、图片前后预览、只接受图片、撤销技能、高级发布表单默认折叠、首次发布设置。

自动化入口：

```powershell
npx vitest run tests/electron/content-import.test.ts tests/electron/resource-release.test.ts tests/electron/workbench.test.ts tests/electron/github-content-release.test.ts tests/electron/editor-content-pipeline.test.ts tests/electron/ipc-trust.test.ts --maxWorkers=1
npx tsc -p electron-editor/tsconfig.json
npm run build:content-pipeline:editor-bundle
node tests/electron/resource-workspace-smoke.mjs
node scripts/verify-electron-editor-package.js
```

界面证据见本目录 `resource-workspace-smoke.json` 与 PNG。测试保留自己的临时项目，不修改真实内容项目。原包导入的原生文件选择器需要人工选择文件；核心导入逻辑由真实档案集成测试覆盖。

## 独立审查

已修复并覆盖：跨任务隐式接受草稿、图片扩展名大小写、连续第三版补丁父身份错误、仅地图导入缺少集合清单、更新说明长度合同不一致，以及跨编辑器发布指针竞争。

## 未验证或未接通

真实发布凭据和国内下载速度、玩家自动发现资源更新、客户端训练营加载候选、旧式可执行内容兼容均不属于已通过结论。详细行为与边界见 `docs/technical/RESOURCE_WORKSPACE.md`。未合并、未正式发布、未修改游戏客户端主进程或引擎。
