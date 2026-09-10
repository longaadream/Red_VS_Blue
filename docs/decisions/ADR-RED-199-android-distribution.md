# RED-199：安卓应用更新与资源包适配

状态：2026-09-10 用户明确批准方案；实现候选待用户验收。风险 High。

## 边界

Android 使用原生 HTTPS 下载和系统安装器，不能运行 electron-updater。主菜单“更新与资源”管理应用检查、下载、安装和 Content Pipeline v1 ZIP 导入。桌面更新器不在本次范围。当前 uiAcceptance 包仍是独立调试候选；现已集成手机 Colyseus 主机与前台服务，验证边界见 Android host ADR，不等同正式发行版。

应用更新为完整 APK：下载后检查大小、SHA-256、包名、递增 versionCode、minSdk 和与已安装包一致的签名者，再交系统安装器确认。每一跳重定向必须保持 HTTPS，不修改系统证书验证。失败和取消保留原应用。安装完成后的软件故障通过同签名、更高版本的修复包处理，不承诺直接降级。Native 文件提供器只共享 updates 缓存。

资源格式继续使用公共 v1 schema、签名、validator、resolver 和内容双身份；没有定义另一套安卓资源包。纯核心模块打包到内置维护页面，Android 适配 ZIP、文件存储、原子活动指针和 WebView 资源读取。导入文件不允许替换维护页或其他应用 HTML/JS/CSS；外部执行字段仍由公共验证器拒绝。来源不受信时先验证真实签名和完整内容，再由原生对话框展示完整发行者指纹，玩家明确批准后才保存本机信任；不能把包内自报身份作为授权。

包安装为完整不可变候选目录。原生层再次检查输出路径、文件大小和哈希，全部成功才保存候选指针；启用前重新解析签名链。Stable、Previous 和 Candidate 独立保留，支持上一版和内置资源回退。压缩体32MiB、文件16MiB、总解压128MiB、2048 entries；ZIP目录先做路径、重复、类型、加密和预算预检，再受限解压并核对CRC。清理操作保留被使用版本，并清除中断遗留的 staging。

原生维护权限绑定当前 Activity 的维护页面，页面跳转/销毁撤权；入口 singleTask，工作提交与销毁竞态失败时释放锁。维护操作使用进程级互斥，所有 AtomicFile 读/写使用同一锁。对局保留重连记录时要求先返回对局；玩家也可明确确认放弃本机重连记录，处理已失效房间或损坏资源的恢复。该操作不伪造服务器结算。

首次提供启用资源时检查完整性、当前 ABI 以及依赖的 bundled Base 身份；不兼容则阻断游戏资源，维护页仍可恢复内置。公开游戏身份动态使用当前 APK 的 runnerRevision。大厅、排位、普通准入和旧 token 重连均使用手机实际启用的身份；旧 token 另保存原对局的身份以防绕过正常准入。美术变化允许同权威身份的重连，游戏内容不匹配则拒绝。

## 发布与回退

默认源为 `https://github.com/longaadream/Red_VS_Blue/releases/latest/download/android-latest.json`。清单中的 APK 地址固定具体 tag，避免 latest 移动造成文件和哈希错配。用户选择 GitHub Releases，不代表授权本次自动发布。

构建可设置 RVB_ANDROID_DISTRIBUTION_CONFIG（只含公开 updateUrl 和 trustedPublisherKeyIds），以及 RVB_ANDROID_VERSION_CODE / RVB_ANDROID_VERSION_NAME。不得在该配置中放私钥、密码或访问令牌。正式发行需另准备并妥善保管长期 Android 签名密钥；当前包签名是隔离候选的调试签名。

`node scripts/package-android-update.mjs <apk> <tag> [notes.txt]` 从实际 APK 读取版本、包名、SDK 和哈希，输出 APK 与 android-latest.json；工具不签名、不上传、不发布。发布时两者须属于同一 Release。测试源/测试密钥/证书只生成于忽略的 dist/android-update-qa。RVB_ANDROID_QA_CERT 仅为 uiAcceptance 调试验证注入短期根；交付前必须检查未携带该根及测试源。

代码回退可整组回退安卓分发适配；运行时资源可恢复上一稳定目录或 Base，保留账号和设置。旧 MainActivity 的资源桥和旧手机主机协议没有重新启用。
