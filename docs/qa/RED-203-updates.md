# RED-203 验证记录（2026-09-13）

目标：安卓APK差量更新；Windows/Android同版本、同源码、同Release。UI与玩法不在范围。
基线main=53c2c9ca3eef73d2158645b93138e242c225c604，衔接已发布ae76d09源码。

## 已验证

- `npm run test:client-updates`：37/37。Node生成补丁→真实Java流式解码字节一致；
  基包不符、损坏、截断、越界、尾部载荷、目标哈希错误、网络错误、取消、签名拒绝回退；
  旧Windows清单、Android版本/签名/SDK错误、缺平台/补丁、文件篡改、错误和annotated tag、
  上传中断/远端摘要不符均拒发；源码凭据和ABI/QA信任检查。
- `npm run lint`：完整仓库通过，退出0；`git diff --check`通过。
- 隔离 Gradle assembleUiAcceptance 成功。测试包名 `com.redvsblue.client.deltaqa`，
  不覆盖其他issue的uiqa或公开包；SDK/JDK使用本机已安装版本，串行/单worker/640MiB Gradle。
- 真实 APK20301→20302（仅版本变化样本）：目标96,968,761 bytes，gzip补丁100,185 bytes，
  约节省99.897%。此比例不代表任意业务更新，改变压缩资源/运行时可能明显变大。
- 原生Android WebView维护接口，经短期QA证书HTTPS：checkUpdate后downloadUpdate返回
  `{ready:true,mode:"delta"}`；服务器记录只请求清单和100185bytes补丁，没有完整APK请求。
- 将清单的补丁SHA256故意改错：客户端重试返回mode=full，并下载96,968,761bytes完整APK。
  两条路径都经过Android PackageManager的包名/版本/签名比较；目标摘要：
  `c8953555b9f8dfa4a824aa7b176c2551f2baa9477e89e0361a3ad4989b0f9307`。
- 再次实际合成候选后，从设备私有cache中取回candidate.apk，验证摘要等于上述目标，
  通过ADB安装此候选到20302；重启维护接口确认版本20302、localStorage标记保留、
  再检查available=false。没有清除应用数据。
- 独立AI复核提出真实tag指向、上传阶段元数据复验、旧staging来源、ABI环境污染问题，
  均修复并补测试；最终只读复核无新增实质阻断。

证据在本地ignored `dist/android-delta-qa/`：base.apk/target.apk/update.rvbdelta、
build-*-https.log、traffic.json、native-results.json、installed-results.json、reconstructed.apk。
证书仅QA两天有效，未进Git/公开包。测试服务19444、设备CDP转发19245用于本次验收。

## 如实记录的失败与边界

首次Capacitor初始化缺少web入口，按既有构建要求补生成入口后成功。
一个新增测试表达式触发ESLint，改为明确if/else后全仓通过。
重复原生测试一度把上一轮完整下载计入本轮流量而失败；夹具改为记录本轮起始计数，
首次完整原生验证本身已通过。失败重跑在流量断言前已完成真实delta合成，
该设备候选经摘要确认后用于上述实际安装，不将失败断言冒称整轮通过。

没有在用户小米真机测试，也没有操作/验收系统安装确认按钮；安装环节由ADB完成，
播放器正常安装仍需要系统确认。数据保留验证为localStorage标记，不等于穷尽所有存档格式。
Windows updater沿用已发布/已验收实现，本轮没有重新进行完整Windows升级。

**尚未发布新的双平台Release。** 本分支刻意不引入另一个工作区未提交的UI/demo改动。
公开构建入口要求RED-181的stageDemo/长期签名配置先合入同一源码，缺少时会在构建前拒绝。
完整双平台重构建、签名APK生产凭据验证、GitHub实际草稿上传/公开的端到端验证仍待该依赖。
发布逻辑目前使用可注入GitHub响应的离线失败测试，不把它当成一次真实公开发布。

Android当前旧stage脚本会重建tracked game-engine.js；若生成内容与提交不一致，
发布脚本拒绝dirty源码，需在集成分支确认生成结果并提交后再重建，不能绕过干净源码门禁。

## 接入与人工验收

先把本更新模块与UI issue的公开demo variant纳入共同源码并审核生成资源；
递增package.json版本与Android versionCode，保留同一Android签名密钥。
运行构建/verify/upload（默认draft），核对两端版本与签名/来源后再使用--publish。
详见ADR-RED-203-synchronized-updates.md。
实体手机验证：旧公开APK检查更新→下载→系统确认安装→检查存档/账号和当前版本；
两端检查各自清单，不应下载另一平台附件；资源包Release保持独立。

回退：未齐保持draft；补丁失败走完整包；取消保留旧应用和数据；
已公开故障用同签名更高versionCode修复包，不覆盖v0.1.0或擅自降级用户安装。
