# Windows 客户端差量升级验收

- 用户授权：准备两个连续安装版本并测试，实际安装/重启由用户手动进行。
- base_branch: main；2026-09-10 fetch 后 base_sha: 53c2c9ca3eef73d2158645b93138e242c225c604。
- 范围：复用当前候选的 Next/PostgreSQL/Colyseus/runtime，串行构建 Windows NSIS 0.1.1、0.1.2；独立测试输出、安装标识和本机更新源。正式 GitHub 发布配置不变，不推送/发布 Release。
- 风险 High：安装包和更新链路；不修改玩法、主存档或签名密钥，不自动启动安装器。
- 验收：两版 exe/blockmap/latest.yml 完整；实际 NsisUpdater 检查新版本，HTTP Range 差量下载、重建 SHA-512 一致、实测传输量小于完整包；缺少旧安装包缓存时完整回退成功；无更新时不重新下载；用户手动完成首次安装与重启升级。
- 允许目录：scripts/、tests/electron/、docs/qa/RED-202-IDE/；构建缓存和 pr-tools/RED-202-IDE/binary-update-acceptance 产物。若打包暴露当前候选必需的缺陷，仅修复构建/客户端更新接口，不改引擎规则。
- 测试：实际打包校验、真实 updater 下载验收、相关单测、main-baseline、独立审查。自动验证不执行安装器。
- 回退：停止本机测试更新源；测试安装使用独立 appId 与专用目录/数据，保留已有客户端与资源。

## 安装耗时修复（2026-09-10）

- 问题：standalone/node_modules 是指向开发依赖的目录链接；旧 staging 递归复制了整个树，安装器展开 56,680 个文件。
- 在上述构建缺陷授权范围内修复 scripts 的依赖收集，按运行入口及 Next 输出跟踪补齐实际依赖；不修改游戏主进程或规则。
- 新增验收：目录链接回归测试；精简后的独立目录启动服务并访问页面；实际包文件数显著下降；新包真实差量下载校验。旧安装产物保留，新候选使用独立目录。
- 本次重新 fetch 后 main 仍为 53c2c9ca3eef73d2158645b93138e242c225c604。
