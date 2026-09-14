# RED-208：正式域名与 Android COS 更新

base_branch: main
base_sha: be664e65cfb47b46019c0f045d9784c7dcd65b51
风险 High；用户明确要求安卓同步补齐。用户决定先完成代码和本地验证，发布时再上传；不修改发行版本、不合并、不发布。

## 行为

Windows、Android 和资源更新的 COS 根地址统一为 https://updates.redvsblue.top。
Android 选择 COS 后可检查、下载和安装 APK。根 android-latest.json 保留正式发行的 GitHub URL 和摘要；客户端严格校验版本目录及文件名后映射到正式域名。COS 拒绝重定向、非 HTTPS、端口、用户信息和查询参数。GitHub 保留原配置兼容性。
更新事务继续使用已安装 APK 作为差量基包，校验基包/补丁/目标摘要；补丁失败回退所选源完整 APK，取消不触发回退。安装前仍验证包名、版本和与当前应用相同的签名。源切换由原互斥锁保护并清理待安装候选。

镜像工具先 verifyBundle，再输出版本目录安装器、blockmap、APK 和清单引用的全部 rvbdelta；资源保持原签名字节。三份可变清单最后上传：resource/latest.json、android-latest.json、latest.yml，建议 no-cache。0.1.4 发布时保留 0.1.3 blockmap，支持 0.1.3 升级；不要求继续支持 0.1.2。

## 验证

- 39 项 TS 更新与选源页面测试通过。
- 14 项镜像测试通过，包括 APK/补丁篡改在创建输出前失败、清单原字节保留。
- 12 项真实 Java 差量事务测试通过，包括网络/坏补丁回退、取消、错误签名拒绝。
- Android 11 项原生单元测试及 compileDemoJavaWithJavac 通过，Gradle 重新生成维护页面资产。
- Electron tsc、全仓 lint 和 main-baseline 通过。
- 已正式发行的 0.1.2 APK + 593755 字节补丁经原 Java 实现重建 0.1.3，SHA256 为 3df70735ff60c02c442db67a2c586a2b120cca9037a1c21dd95189b8065be21e，与正式 APK 一致。仅作本地算法验证，不代表继续支持旧版本。
- 本地经过校验的双端镜像目录 dist/red208-cos-upload，重建文件 dist/red208-validation/reconstructed.apk。

## 发布时验收与回退

当前域名下 android-latest.json、0.1.3 APK、0.1.3 补丁均返回 404；用户明确留到发布时上传。本次没有声称真实 COS 安卓下载或真机安装通过。0.1.4 发布前须上传产物并验证 0.1.3→0.1.4 差量、完整 APK 和真机安装/数据保留。旧 0.1.3 首次升级仍走 GitHub 或手动安装。
回退：用户选择 GitHub，或撤销本 PR。保留签名验证、资源存档，不强制降级。
