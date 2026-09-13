# RED-203：Android 差量与双平台同步发布

用户 2026-09-13 批准：只做更新链路，UI 由另一个 issue 负责；Windows/Android 同步发布。
base_branch: main；base_sha: 53c2c9ca3eef73d2158645b93138e242c225c604（已 fetch）。
分支从 main 创建后快进至已发布 v0.1.0 源码 ae76d09；Windows 更新器作为既有依赖。
风险 High。允许更新模块/构建发布脚本/测试文档；不改游戏、UI、数据、主机或另一个工作区。

## 更新

Windows 继续 electron-updater/NSIS/blockmap。Android 在现有原生维护插件的下载接口内，
选择 fromVersionCode 和实际已安装 base.apk SHA-256 同时匹配的补丁。
清单仍为 rvb-android-update/v1，可选 deltas；旧安卓忽略该字段并完整下载，兼容首次过渡。
目标版本、包名、签名者集合与 minSdk 仍经过现有校验，安装仍由系统确认。

补丁格式 rvb-apk-copy-gzip/v1：内容定义分块（4–64 KiB、平均约20 KiB），
复用相同块的原始 APK 字节，其余字节写入 ADD；gzip 仅压缩补丁流。
解压流依次为 ASCII RVBAPK01、uint32 BE 目标大小，COPY(0,u32偏移,u32长度)、
ADD(1,u32长度,字节)、END(255)。不解包/重新压缩/重新签名 APK，确保签名字节原样重建。
APK 及补丁上限256 MiB，单命令64 KiB，最多131072条命令，固定32 KiB传输缓冲，
逐步检查取消、范围、输出总长、gzip EOF/CRC及最终SHA256。发布补丁须至少节省10%。

基包不匹配/不可读、下载失败、补丁损坏或合成验证失败均改完整APK下载。
取消或页面销毁立即终止，不开始回退下载；中断保留现有安装和用户数据，清理候选/part。
没有可用补丁或跨多个版本时可完整下载；不是所有更新都保证省流量。
这不是完整APK的差量安装，Android最终仍安装完整、签名相同的新APK。

## 同步发布

`scripts/synchronized-release.mjs build <local-config.json>` 串行构建两端，避免内存竞争。
package.json 是共享版本来源；Android另有递增 versionCode。两个平台必须来自同一干净提交。
Windows 调用已验证正式构建脚本；Android固定调用 build-android-release.ps1，清除自身构建目录、
生成Capacitor接线并通过现有 stageDemo/assembleDemo --rerun-tasks 重建，随后用已有长期密钥签名。
通过独立 Gradle init 脚本在 stageDemo 后嵌入 commit 和实际打包资源哈希，打包后逐项复验。
本任务不修改另一个 issue 的 demo variant 或UI。它合入后该入口才能构建公开APK；
旧 release variant 不包含当前安卓宿主，不能冒用。

本地配置仅含 androidVersionCode、androidSignerSha256（公钥证书摘要）、androidSigningDirectory
（现有 .local-signing 的路径）、可选 previousApk、notes。密码不进入配置或日志。
设置 JAVA_HOME / ANDROID_HOME / RVB_RELEASE_ELECTRON_DIST；GitHub CLI 使用已有登录。
示例：

```json
{
  "androidVersionCode": 20,
  "androidSignerSha256": "62efaf54f0b2f02c7b4c69cf965747bdc5b6e63c78e70c7d55888cbbbfc8d3cc",
  "androidSigningDirectory": "../red181/.local-signing",
  "previousApk": "../previous-release/Android.apk",
  "notes": "本次更新说明"
}
```

首次发布省略 previousApk。versionCode 要高于实际已发布值，示例20不是自动版本策略。
输出 dist/client-releases/vX.Y.Z；存在的输出拒绝覆盖。
`verify <bundle-dir>`复核本地，`upload <bundle-dir>`仅创建/补齐草稿；
`upload <bundle-dir> --publish` 经校验后一次将双平台 Release 公开为 Latest。
源码须先推送，Git tag实际commit（含annotated tag）必须匹配；不移动已存在tag。
任一附件缺失/版本或摘要不符/不同签名/QA源/源码凭据不符均禁止公开。
网络上传中断后可重跑：相同附件跳过，不同附件拒绝覆盖。公开后不再改写此版本。

同一Release附件：Windows .exe/.blockmap/latest.yml，Android .apk/android-latest.json/
可选.rvbdelta，以及release-bundle.json（两端源码/版本/摘要）。
资源 content-test-* 保持独立 prerelease，不能抢占客户端 Latest。
同时发布只保证相同源版本，不代替双方玩法/资源兼容性和另一个UI issue的验收。

## 验证和回退

Node↔Java实际字节重建与事务故障注入、恶意补丁边界、清单和草稿发布顺序自动测试；
构建两个隔离deltaqa APK，测真实补丁率/签名及安装升级，记录实测范围。
原生权限和安装界面沿用原实现，不宣称无需用户确认或小米真机已通过。
双端未齐保持草稿；已公开故障发同签名更高版本修复，不强制降级/覆盖旧包。

参考：[Android 应用更新与签名要求](https://developer.android.google.cn/google/play/app-updates)。
