# PVE 测试包 2026-09-14

用户授权同步当前 main 并构建给测试玩家使用的客户端。base_branch: main；fetch 后 base_sha: `ebe47ee`（0.1.4）。保留 PVE 分支功能，使用 merge；不合并 PR、不公开 Release、不修改签名密钥。

合并风险 Medium，打包沿用现有发布入口和签名。Windows 输出通过可选 `RVB_CLIENT_BUILD_OUTPUT` 指向独立测试目录，已存在的指定目录拒绝覆盖，默认正式发布路径不变。

## 合并与验证

- 保留主线统一位移、路径接触与坐标写保护；保留 PVE 战区前后校验及敌方程序移动 AP 豁免，移动成功时才提交玩家费用。
- 肉钩原作者代码直接修改坐标，被新写保护拒绝；改为共享 flow.effects.move pull，保留遇障碍停止，产生完整路径接触。
- 角色详情同时保留阵亡预警与主线技能阅读 Tips；TypeScript 测试采用主线 readFile 返回类型。
- 三份浏览器引擎从合并源码重新生成。首轮 171 项中 170 通过，肉钩兼容失败已修复；针对性 38 项复测通过，新增拉拽路径与障碍案例继续复测。
- 原目录签名/编辑器未提交改动保持不变，构建在 red181-main-sync 隔离目录进行。

安装包用于当前分支测试，版本沿用 main 0.1.4，文件及说明明确标为 PVE 测试候选。禁止以旧包的检查代替新包；打包后需资源校验、签名与来源验证、实际客户端冒烟和摘要清单。

## 测试包交付结果

- 两个平台实际打包源码均为 `5cc6f272e5f072c1186a4575188d3fa0ed23f9cb`，包含 main `ebe47eee059d18b5282856759a1a04edbc553d67`。后续冒烟脚本和本记录修改不改变包内源码。
- Windows NSIS 构建和资源完整性检查通过；实际打包客户端教程、房间创建/加入、宿主恢复、退出进程清理冒烟通过。原冒烟脚本将 preload 就绪误认为后台宿主已就绪，现最多等待 90 秒，保留 ready 断言，遇人工恢复状态立即失败。
- Android 使用原有签名构建成功，验证非 debuggable、签名、源码及资源摘要、ARM64/x86_64 宿主内容；在模拟器安装并启动成功。版本号 23 / 0.1.4-demo。尚不代表多型号真机或四人联机完整验收。
- 肉钩普通拉拽和遇障碍回归通过；类型与静态检查通过；打包源码 GitHub Main baseline / ESLint 检查通过。
- 本地产物位于 `dist/test-player-20260914/`，提供 Windows.exe、Android.apk、测试说明及 SHA256SUMS.txt；未创建 Release、标签或更新公开下载源。
- 实际包日志和截图位于 `output/main-sync/`，Windows 最终结果为 `windows-player-smoke-final.log`，Android 构建为 `android-player-build.log`。
