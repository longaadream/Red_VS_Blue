# RED-207：用户选择官方下载源

base_branch: main
base_sha: f73559fdcf8d0503a3ed089058e337c0b0dbcfd7（已 fetch，main-baseline 通过）。
风险 High（更新机制）。用户已明确批准 GitHub/COS 手动选源、记住设置、安卓限制提示；不合并或发布。

## 行为

Windows 官方更新弹窗增加 GitHub 官方源 / COS 香港源，默认 GitHub，旧设置继续兼容。
偏好写入既有 official-updates.json；资源与客户端检查共用选择。
正在检查/下载/应用或客户端已下载待安装时，拒绝切源；空闲切源清除待应用的下载缓存，重新检查所选源。
COS 使用固定受控桶，不接受任意 URL。资源元数据保留原官方资产身份，只有实际下载位置映射到 COS；哈希及原签名安装校验不变。
Windows 使用 GenericProvider + 单 Range 请求；根 latest.yml 引用版本目录，保留旧版 blockmap。

Android 原生偏好保存同一选择；原有游戏更新入口在 COS 下禁用并说明需手动切回 GitHub。
补上明确的官方资源检查下载按钮：按选定源读取清单、验证摘要，复用签名解析，再保存候选；启用仍由玩家操作。
官方资源清单的版本、发行者、ABI 必须与真实签名资源一致；已安装资源不因旧清单而降级。
手动资源 URL 导入保持其明确输入的地址，不静默改写到另一源。
APK 默认域名限制不绕过。正式自定义域名后续接入。本次不变更资源包架构、图片、游戏规则或发行版本号。

## 验证

- 36 项 Electron 更新/网络回归通过，覆盖设置兼容、固定源、COS 下载哈希、未知跳转、缺清单、切源锁定与候选清理。
- 11 项 COS 准备工具测试通过；坏资产/缺凭据在输出目录创建前失败。
- Android 原生编译与 testUiAcceptanceUnitTest 通过；TS 资源解析/身份和真实维护 bundle UI 定向测试通过（具体数量见 PR）。
- Electron 类型检查和全仓 ESLint 通过。
- 根 tsc 有既存错误：tests/ui/spectator-navigation.test.ts:27 TS2493。该文件与 origin/main 无差异，单独运行 tsc 同样复现；未修改该无关测试。
- 真实隐藏 Electron 渲染器 + sandbox preload、模拟 IPC 验证选源、保存/刷新、待安装锁定和按钮布局。
- Android 真实 HTML + 编译 TS、模拟原生桥，在 844×390 Chromium 验证 COS 禁用 APK、资源入口保留以及手动切回 GitHub。
- 实际 COS 无代理 HTTPS 差量下载：1,180,438 字节变化数据 + 233,878 字节新 blockmap，重建232,986,594字节的0.1.3安装器，SHA512完全一致。旧 blockmap 使用本地0.1.2正式产物，尚未验证远端旧 map 可用。
- 使用准备好的本地 COS 清单和真正远端下载的资源包，经原签名安装器在隔离资源库验证通过；不修改用户资源、不激活测试库。
- 独立 AI 审查完成，修复 Android 版本/ABI绑定、旧资源保护及版本数值边界后再次复核。

候选证据（本地，不作为游戏资源发布）：dist/red207-validation/{cos-differential.json,resource-candidate.json,ui/official-updates.png,android-cos.png,android-github.png}。
本次无安卓实体设备测试；UI 验证不等于实际系统安装。网络测试只代表本机直连，不代表全国网络。

## 部署及回退

COS 尚缺版本清单，不能称为已接通线上更新。完整准备目录 dist/red207-cos-upload；仅补上传四个文件目录 dist/red207-cos-extra。
先上传旧版本 blockmap、资源版本 content-update.json，再上传 resource/latest.json 和根 latest.yml，保持目录结构。
具体准备命令、校验和顺序见 RED-207-COS-mirror.md。工具只生成本地文件，本次没有上传权限凭据、没有自动上传或改写公开 Release。
现有0.1.3客户端仍走GitHub；合并后须另发新版才能出现选源设置。
回退可在客户端手动选 GitHub，或撤销本PR；保留已公开版本资产和原签名信任，不强制降级存档或Android版本码。
