# RED-255 兼容失败更新入口 QA

## 范围

联机页面只对已识别的版本/资源兼容失败提供更新入口，并复用首页官方更新对话框、资源包管理页或 Android 维护页。服务器固定资源不可用时保留服务器问题提示，不展示客户端修复按钮；普通网络、认证和房间错误继续只展示原有失败原因。

## 验证

- `npx vitest run tests/ui/compatibility-presentation.test.ts tests/ui/multiplayer-entry.test.ts tests/ui/official-profile.test.ts tests/ui/lan-entry.test.ts`：4 个文件、33 tests passed。
- `npx tsc --noEmit --pretty false`：通过。
- `node --check`：共享兼容 presenter、多人页脚本、排位页脚本、官方更新脚本和 Chromium smoke 脚本均通过。
- `npm.cmd run lint` 及定向 ESLint：通过。
- `npm.cmd run check:encoding`：1516 个文本文件通过。
- `npm.cmd run check:main-baseline`：通过；`origin/main` 与任务基线均为 `00df31f8bd35b34200d507fd83853bf5ac99ba94`。
- `node tests/electron/update-entry-smoke.cjs`：当前工作树未安装 `playwright`，因此未能本地执行；脚本已包含真实 index/lobby DOM 覆盖层打开、兼容失败、入口可见和点击导航回归，需由具备浏览器依赖的 QA 环境执行。
- Chromium 浏览器检查：ABI 兼容失败展示“前往客户端更新”并打开首页官方更新对话框；关闭后紧跟状态刷新不重开；请求标志消费后为 `null`；资源失败打开 `pack.html`。证据：`output/RED255-browser/check.js`（由父任务工具执行）。
- 最终父任务扩展验证：40 个测试中 38 个通过，2 个为既有菜单断言失败；结果见 `output/RED255-browser/final-expanded.json`，
  RED-254 对照工作树的基线证据见 `output/RED254/red255-baseline.json`，两项失败名称逐项相同。
- 真实 Chromium 弹层检查通过：实际打开 LAN sheet，再由 `connectLanServer` 的 ABI 失败路径渲染恢复入口；实际创建弹层的地图请求兼容失败路径同样渲染入口。
  两个入口均通过 `elementFromPoint` 检查未被覆盖，并实际点击完成更新请求/资源页导航。
  证据 `output/RED255-browser/overlay.js`、`overlay-result.json`。使用确定性的 Colyseus/Profile 边界替身，不代表在线服务器或完整客户端安装验收。
- 独立 Astra 复审通过；独立 33 个定向测试通过。

## 已知风险

多人联机原有 `resolvedProfileHash` 比较键和顺序未改变；它仍会把该字段冲突归入资源更新入口。此任务只增加表现层入口，没有修改版本比较算法、服务器协议或更新安装机制。

Electron `rvb-client://app` 在 Chromium 可能报告 `origin === 'null'`，导航和标志存储仅接受该已知 scheme/host（或当前同源 HTTPS/file 页面）以及硬编码页面名。

## 手动回归

1. 从多人房间或排位页触发已知 ABI/Runner/资源兼容失败，确认失败原因仍可见并只有一个对应入口按钮。
2. 点击按钮，确认客户端类进入首页官方更新对话框，资源类进入资源包管理；返回大厅后刷新房间/地图列表，确认失败入口不会被后台成功响应抹掉。
3. 触发普通网络、认证或房间错误，确认不出现更新入口。
4. 在首页打开 LAN 连接覆盖层并触发 ABI/资源兼容失败，确认 `lanOverlay` 内的入口无需先关闭覆盖层即可点击；在大厅打开创建房间面板并触发同类失败，确认创建面板内的入口可见可点击。

## 回退

风险 Medium（连接失败后的界面导航）。回退本任务表现层提交即可，不涉及服务器门禁、更新安装器或用户数据迁移。
实现候选尚未合并、发布或部署，完整客户端体验等待人工验收。
