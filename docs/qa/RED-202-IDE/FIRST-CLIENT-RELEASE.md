# 首个 Windows 客户端 Release

- 用户已手动完成短目录 0.1.3 → 0.1.4 QA 升级，本轮授权发布第一版。
- base_branch: main；base_sha: 53c2c9ca3eef73d2158645b93138e242c225c604（2026-09-11 fetch）。
- 正式版本 v0.1.0，身份 com.redvsblue.client / RED vs BLUE；GitHub longaadream/Red_VS_Blue，稳定更新流。QA 版不直接分发，正式首次安装单独进行。
- 范围：记录当前已验收候选源码提交，配置正式构建与快捷方式，构建/检查/草稿上传/发布 Release；不合并 main，不新增玩法，不自动安装。
- 允许路径：config/electron-builder.client.json、scripts/**、tests/**、docs/**；既有对话候选变更只纳入源码提交，不做无关重构。
- 验收：包内容、版本/身份/更新源、无 QA 发布地址；回归/类型/实际包 smoke；源提交与构建记录；独立审查；远端 exe/blockmap/latest.yml 完整并验证摘要，客户端 Release 为 Latest，资源保持 prerelease。
- 风险 High；回退：上传期间使用草稿；发布失败保留原资源 Release；不删除用户数据。后续客户端提高版本号，资源另走 content-test-*。
- 已知限制：NSIS 安装仍需解压/替换整个客户端；安装在深路径会触发 Windows 路径限制，推荐默认路径。首版没有前一正式客户端可做跨正式版本差量，已通过两版本 QA 验证。
