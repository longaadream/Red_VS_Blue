# 0.1.15 / 1.0.14 发行合同（RED-251 后续）

用户明确授权继续构建和发布客户端/服务端 0.1.15、资源包1.0.14；沿用配套管理面板、官网主页及COS目录交付。COS由用户自行上传。本轮不合并任何PR，不部署生产服务器，不上传COS。

base_branch: main
base_sha: 00df31f8bd35b34200d507fd83853bf5ac99ba94
branch: codex/RED-251-release-015
Linear读取/写入两次因连接传输失败，合同先本地记录，恢复后同步。

目标及范围：整合PR239既有发行源码（含236/238）与已审查PR241–247；重新生成引擎并从同一冻结提交构建Windows、Android、Linux/Windows服务端、管理面板、资源snapshot和官网。排除PR237/240开发功能、依赖升级、密钥修改、存档/经济/随机规则变化和无关重构。

allowed_paths: 上述已审查PR的原始路径；package.json/package-lock.json、android/app/build.gradle、生成的data/pages/js引擎、config/resource-history.json、docs/releases与docs/qa。构建辅助脚本与证据写入ignored output/RED251-015。

风险High：只沿用既有签名、来源校验和同步发行机制。用户已明确批准本次构建及Release发布；不改变更新机制设计。保留全部旧tag/公开资产，不覆盖旧资源。

验收：所有已授权修复均包含于冻结提交；客户端/服务端版本0.1.15、Android递增versionCode、资源1.0.14最低客户端0.1.15。签名与更新清单一致；Windows/Android、服务端/管理面板候选验证通过；GitHub三套Release资产完整且可匿名下载。官网/COS引用新版本，保留更新基底；不把COS准备写成已上传。

测试：check:main-baseline；近期修复与整合冲突相关回归；typecheck/lint/encoding；canonical资源build/sign/validate/resolve/smoke和历史保护；同步客户端verify、APK签名/差量重建校验、Windows客户端候选、服务端health/catalog/数据库隔离启动、管理面板包验证；最终独立AI审查。既有基线失败必须逐项注明，不能报告为通过。

回退：保留v0.1.14、资源1.0.13和管理面板0.1.14；发布出错停止推广新feed。COS切换前核对全部版本路径，最后更新feed。生产服务未改动，不涉及数据库回退或自动降级Android。

## 保护资源的授权变更

- data/skills/itachi-amaterasu.json: 67bc7575c7bc85c44d1d8c39cb0d692b8816bee429de4d76a5a21d96326d7518 → cb193f77a85dc7c13c91fc0a9a2ea1fee87fc4679d17d8fbd46ca3befb8dba7d
- data/skills/shadow-ride-sweep.json: 57f6fa0c7ca08f8f027bf32d387e4a809c248390bd3dd337b8e7a345cc81cef3 → e9c502abdb35a283e087e4eb981e2425235728322ad8ea08bd38d1a9d434174d

仅同步RED-254玩家伤害归属与RED-257实际路径动能；其余31个历史资源保持原保护值。

官网同步范围另包括 website/release.json、website/index.html、scripts/build-official-site.mjs；必要的整合测试期望同步包括 tests/build/official-site.test.mjs 和上一版圣铸回归测试，均不改变功能设计。

## 候选验证记录

- 资源build/sign/validate/resolve/seed251 smoke：全部PASS；签名包历史33/33。
- packageHash: 7d39c4b75b448278eae84e1c53bb0741b2d2b3bd75052caefb699b758e619459
- resolvedProfileHash: dce7c924b46d0b012c2bd7edc838f3fedb5514f5be5a66466ca612568cae6d88
- authorityContentHash: dbffd6db449bab23ed66bf0461ecd464c91320f8137da693198af19c7353cfba
- archiveSha256: e796898132763c092285d8f9ab601f95a3f09c0ed5e8b26e102695cfbeab7184
- 官方服整合冲突验证12/12，保留注销boolean与旧token隔离及兼容失败入口。
- 官网/同步发行/COS/Android元数据测试53/53（测试期望由旧版本同步为本版，失败前证据保留）。
- typecheck、全量ESLint、encoding1549：PASS。
- 重建合并后的浏览器引擎与练习AI；不要复用任何单独修复分支的旧bundle。
- 发布冻结后平台打包、隔离候选冒烟与最终独立审查结果写入ignored output/RED251-015/release-report.json，尚未执行的项目不记作PASS。

整合测试补齐 tests/ui/red256-akaza-step-selection.test.ts 的隔离VM取消辅助函数（真实页面已有该函数）；失败前70PASS/1FAIL，补齐后猗窝座3/3PASS。没有修改真实取消流程。兼容入口/官方服/注销76/76PASS。移动/圣光邻近108PASS/5FAIL，五项索尼克旧断言与既有RED257基线一致，待独立测试者最终核对；不擅自修复范围外玩法。
