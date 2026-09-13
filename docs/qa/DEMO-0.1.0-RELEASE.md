# 0.1.0 公开试玩候选

> 最新基线复查：主线已推进至 `23eb55067fb221d8b4ff3cd457d5465446b57bd7`（含 0.1.1 发布流程），当前分支落后 17 个提交。下述包是 UI 验收候选，尚未整合新主线，不能作为最新发布候选。共享分支的同步方式待分支负责人确认；保留另一任务的未提交签名文件。

## 范围

面向公开试玩，保留 PVP、新手教程与实验 PVE。本轮不扩充卡牌、平衡或地图系统。2026-09-13 用户指定 Android 签名交给另一 issue，相关未提交构建改动与密钥原样留本机交接；本 PR 不提交 Android 签名实现，最终 Android 发布包以该 issue 为准。尚未批准合并或公开发布。

基线：2026-09-13 fetch 后 origin/main 为 `53c2c9ca3eef73d2158645b93138e242c225c604`，分支无落后。风险 High（Android 发布签名和宿主打包）。独立审查确认本轮打包、密钥隔离、晚加入遗物修复未发现阻断项。

## 本轮修正

- PVE 晚加入玩家继承自己流派的初始遗物，不再统一获得校准弹匣；增加自残、圣光、游击回归案例。
- 首页及冒险入口明确标注实验内容。
- 本机 Android demo 打包已做过验证，签名工作现转交另一 issue，本轮提交不包含其 Gradle、manifest、staging 与签名脚本改动。
- 横屏触屏教程把操作按钮置于说明之前，避免长文本遮住继续操作。
- 测试适配真实课程选择入口、PVE 模式全局和当前角色详情结构，不修改旧 targeting 快照。

## 验证记录

- 相关测试：6 个文件、147 项通过，`output/demo-release/final-regression.log`。
- `tsc --noEmit` 与 `npm run lint` 通过，日志 `final-types.log`、`final-lint.log`。
- Windows 页面/离线数据/图片完整性检查与内嵌 PostgreSQL 检查通过。
- Windows 最终包独立目录冒烟通过：安全边界、离线第一课、宿主故障与手动恢复、SDK 创建/加入房间、资源读取、退出后无残留子进程。日志 `windows-final-smoke.log`。
- Android `assembleDemo` 通过，APK 签名验证通过，versionCode 19；包内包含 arm64-v8a/x86_64 的 `librvb_node.so`、server.mjs 和 sqlite-worker.mjs；没有 QA CA、密钥或密码文件。
- 已实际安装公开签名 APK；旧调试签名无法覆盖的行为已复现并写入备份说明。
- 上一候选的 Android 本机宿主、三名 SDK 队友、四席状态同步、房主存档权限、独立存档、原生服务重启恢复记录见 `output/pve-roguelike/android-native-coop-restart.log`。这不等于最终 APK 四台真机验收。

## 仍需完善

发布前：与另一 issue 对齐最终 Android 包、用户真机验收、PR/CI、明确批准发布。构建成功不等于这些已完成。

后续内容：PVE 卡牌设计稿多于可执行内容（当前 4 张可执行、56 张草案），流派供牌与成长仍需补齐；敌人、奖励、三幕节奏继续迭代。教程前五局开放，第六局未开放。

全量测试首轮并非全绿：23 文件失败、225 通过、1 跳过，29 测试失败、2466 通过、2 跳过。本轮仅复测受影响测试，不宣称剩余全部已解决。余项含过期 UI/内容数量断言、AI 运行超时、官方服务未构建夹具、架构与 AI 语义审计，以及已有状态图标覆盖和 targeting hash 基线失败。后两项在既有 RED-199 QA 中有基线复现记录；独立审查也确认 current/main targeting 同场景结果一致。不得把这些失败隐藏或改快照当作通过。

## 回退与发布

代码可以回退本轮提交；不要删除用户存档或换签名。Android 密钥及备份说明留本机交给另一 issue，不在本轮 PR 上传。Release 附件仅包括客户端、说明与校验清单；不上传本机密钥、测试用户数据或测试备份。
# 2026-09-13 教程与移动 HUD 补充验收

- Windows 与 Android 共用精简教程文案和收起按钮；收起保留当前目标，不改变教学进度。
- Android 横屏顶部改为独立纸片标签，容器透明且不拦截输入；棋盘延伸到顶部空隙。
- 教程相关 3 个测试文件共 39 项通过；修改的 JavaScript 通过 ESLint。
- 新安装 uiAcceptance APK 验证 640×360、800×360、914×411 教程正文、44px 按钮、收起/展开及棋子触控。顶部间隙命中棋盘检查通过。
- Android PVE 实测移动、部署详情及两次独立存档通过；移动表现入口调用一次。证据位于 `output/demo-release/android-floating-*.log` 与 `output/pve-roguelike/android-ui/`。
- Android 本轮只构建 UI 验收包，发布签名继续由另一任务处理。
- Windows 分发 ZIP 已同步 `03ca6e9` 界面修复；358 页面资源、424 离线数据和 44 图片校验通过，内嵌 PostgreSQL 校验通过。更新后独立副本的离线教程、房间创建/加入、宿主恢复与退出清理冒烟通过，日志 `output/demo-release/windows-floating-smoke.log`。
- Windows ZIP SHA-256：`596a7b7f0b829c30fbe480319594f3951dc4919eeac55afa118c11e57b2dc48b`。
- `03ca6e9` 的 GitHub Main baseline 与 ESLint 均通过。PR 仍为 Draft，尚未合并或发布。
