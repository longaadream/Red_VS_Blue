# RED-251：客户端/服务端 0.1.14，资源包 1.0.13

用户明确授权发布 GitHub Release；COS 仅生成本地上传目录，用户自行上传。没有授权合并 PR 或部署生产服务器/官网。

- base_branch: main
- base_sha: 00df31f8bd35b34200d507fd83853bf5ac99ba94
- 分支：codex/RED-251-release
- 整合 PR236：9a59c46dc06f6b221cdc77b38ef21366e4c406e4
- 整合 PR238：b36de0651878e33f9fdfaf40bf37a94f4e4a1ad0
- 风险 High：沿用现有签名与同步发行流程，不修改 updater 安全门禁。

Windows/Android/服务器从同一干净提交重建。Android versionCode 33，沿用公开版本签名。Android delta 基底是公开 v0.1.13 APK，其 SHA256 为 e3105a3c2b48f7434236f5439324ef4e5f85b30c0dc7f65ffbe5fe73f7450427，不使用本机重建 APK。Windows 保持既有签名配置；实际签名状态写入产物验证报告。

资源 snapshot 使用当前 data，排除 data/pages 与 data/users.json，逐字节继承公开 1.0.12 包中的 23 张图片。资源版本 1.0.13，最低客户端 0.1.14，正式 index 仅包含 full snapshot。canonical build/sign/validate/resolve 与 seed 251 smoke PASS；历史保护 33/33 PASS。

- packageHash: cf7d0c22733a652b9e507638374adb28c87af835cb1c502320cf2d1c39117251
- resolvedProfileHash: bf542ef3feb532fc1037aa4658ca6f8731da37c788edc6e58ac331534cfe6773
- authorityContentHash: 0a8357e0753426270869c66047fcc8a3988291ff5c3fb1e85815bd995d7e3a2e

最新回归、实际打包、独立审查、匿名公开资产校验及发行状态将记录在 ignored output/RED251/release-report.json。尚未执行的检查不记作通过。新版本不代表人工产品体验已验收。

首次客户端构建在 Next 类型检查阶段因发行脚本固定 1024 MiB 堆触发 OOM。构建脚本改为默认 2048 MiB，并允许 RVB_RELEASE_HEAP_MB 在 1024–8192 的整数范围内设置；保留类型检查和所有签名/来源门禁。重新冻结源码后重建，失败候选不公开。

人工验证：安装新版、确认 0.1.14 / 1.0.13；训练局验证镜花水月非正方向改写、两种月牙一次选择、黑虚闪预演、圣光牌结算后圣铸两阶段与取消只取消位移；检查顶部按钮平铺、退出关闭程序、自己资料页退出登录；查看四张新图。服务器管理面板检查目录与排位池，新地图默认不自动加入池。

回退：保留旧公开 v0.1.13 和资源 1.0.12，旧 tag/资产不覆盖。COS 尚未上传时保持旧 feeds；出现发行异常停止推广新更新源，报告具体失败。禁止自动降级 Android、恢复数据库或直接编辑资源 active pointer。

官网与 updates 域名指向同一 COS 桶：上传官网 index/assets 时保留版本目录和 resource；版本目录先上传并核对，最后上传 resource/latest.json、android-latest.json、latest.yml。

Fixes RED-251。
