# RED-199 安卓兼容工作记录

日期：2026-09-09。分支：`codex/RED-199-android-compat`。
基线：`main@12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441`。

## 已修复的战斗表现

旧镜头强制手机每格至少 44px，导致大地图无法缩回全图。新增回归在修复前稳定失败：
三种视口的棋盘角落超出画面，双指平移也未跟随。
现在首次进入和“全图”按棋盘真实边界适配；放大、缩小和双指平移不改变规则状态。
全图状态随视口变化重新适配，手动移动后的镜头保留玩家视角。

横屏高度不超过 600px 时，棋盘使用独立的可见区域；顶部状态、底部手牌/渐进部署条、
镜头复位位于棋盘区域之外。保留纸张/墨线美术与字体；按用户最新反馈移除加减按钮，以双指缩放和平移操作。

## 证据与限制

- `dist/multiplayer-qa/android-camera-before.log`：新回归先失败，4 项失败、21 项通过。
- `android-camera-after.log`：渲染器、移动几何、真实 HTML 脚本检查共 57 项通过。
- `android-browser-layout.log`：隔离测试账号、数据库和真实 Colyseus 官方流程；
  检查 740×360、844×390、932×430 的真实战斗 DOM、镜头边界和 44px 按钮；
  实际点击部署候选并通过触屏事件落子，等待权威确认，再完成认输、Elo 和历史结算；退出码 0。
- `red199-battle-*.png`：上述浏览器尺寸截图，**不是 Android APK 或真机性能证据**。
- `android-lint.log`、`android-types.log`：静态检查记录。
- `android-baseline-build.log`：旧手机服务构建失败，当前尚未生成本轮可安装 APK。

独立 AI 审查发现历史临时重建未保存“全图/手动镜头”模式；已补充失败回归
`android-history-before.log` 并修复，相邻 57 项检查通过。后续仍需审查主机迁移实现。

已启动隔离只读模拟器 `Medium_Phone_API_36.1` / `emulator-5554`，未清除真机数据。
等待主机迁移方案确认前已关闭本轮模拟器，隔离浏览器与测试数据库也已停止。
仅启动模拟器不能视为功能通过。还需执行 APK 安装、手机主机、后台运行、官方账号及资源/证书验证。

## 主机迁移门槛

用户明确要求安卓本轮支持主机及短时后台/锁屏，并接受运行通知。
旧手机协议与当前 Colyseus 不兼容，不能通过改地址解决。
详见[手机主机方案](../decisions/ADR-RED-199-android-host-proposal.md)。
用户已接受手机 SQLite 作为 PostgreSQL 约束的例外；仍需先完成兼容运行时验证。
用户再次强调布局优先，当前补充手牌、角色/卡牌详情与触屏关闭验证。
Android 资源管线的旧 JS、缺失样式、远端 identity 自比、TLS 忽略和旧资源包覆盖也必须随迁移处理。

## 手机折叠与聚焦交互（2026-09-09 用户修正）

选中棋子直接打开底部技能小卡片，沿用原技能费用、可用状态和命令。
属性与长说明仅在点击详情时展开，进入目标选择时收起。
手牌默认折叠，点击手牌按钮展开，点击卡牌放大预览，明确点击“使用卡牌”才发出原出牌命令。
强制单选/多选自动展开，确认条位于卡牌下方；此时仍可长按阅读，预览不提供出牌按钮。
战斗动作/技能提示在手机上缩为顶部 40px 提示，保留图标、名称和原播放时序。
底部技能改用现有纸张素材和墨线边框，去掉整块底板；保留全图复位，移除加减缩放按钮。

浏览器检查覆盖 740×360、844×390、932×430、1043×480@2.5、869×400@3。
强制选牌布局使用临时展示夹具并同步恢复，不向权威提交命令；真实对局部分仍实际部署和结算。
独立审查指出关闭面板重入、确认条压住牌、权威选择到达时预览遮挡及强制选择时长按无法阅读，均已修正并补回归。
这部分证据仍是桌面 Chromium 的真实页面，尚不能声称小米真机或 APK 验证通过。

本轮结果：`android-focus-unit.log` 45 项通过；`android-focus-art.log` 完整官方联机流程成功，
`red199-panel-layout.json` 五组密度下技能栏、弹窗、折叠和强制选牌均无布局违例。
`android-focus-lint.log`、`android-focus-types.log`、`android-focus-encoding.log` 均通过。
基线检查通过，分支落后 main 为 0；未提交、推送或生成新的 APK。

## 地格信息条

用户确认地格栏采用相同的折叠交互。手机点击地格后显示一行地形名称和最多三个持续效果图标，
更多效果显示数量；点击信息条展开原始效果列表，关闭按钮始终至少 44px。
切换地格、进入移动或目标选择、打开手牌及角色/卡牌详情时收起地格详情。
角色详情打开期间隐藏地格条，避免覆盖角色关闭按钮。桌面保留原地格栏。
多效果展开内容可滚动，高度受限，不延伸到底部技能操作区。

`android-tile-tests.log`：52 项直接及相邻回归通过。
真实浏览器首次检查复现旧皮肤覆盖折叠状态/按钮尺寸，记录于 `android-tile-browser.log`；
修复以最终计算样式和触屏点击验证，不以 DOM 类名替代显示结果。
`android-tile-final.log`：五组视口的真实触屏展开/关闭、切换地格自动折叠及 12 效果展示夹具均通过；
完整官方联机流程成功。地格条实际高度 48px、关闭按钮 44px。

用户随后指出计时器不可见：原手机样式隐藏了整个 `.turn-summary-secondary`，导致回合及响应倒计时一起消失。
手机左上角回合牌现在常驻显示原有计时状态；响应阶段同时显示响应倒计时和冻结的回合剩余值。
未修改服务端计时或超时规则。浏览器用临时权威时间展示夹具验证普通、响应、烧绳三种状态后立即恢复真实计时。
计时专项还覆盖 568×320，修复该宽度下旧响应浮层定位的残留。`android-timer-tests.log` 17 项通过。
`android-timer-final.log` 的布局检查通过，但重入步骤超时；已定位脚本只等待按钮出现，未等待登录 busy 状态解除，
而 `official.js` 在刷新显示比赛后才解除按钮禁用。脚本现在等待“进入比赛”可用，避免点击被禁用的按钮。
修正后 `android-timer-verified.log` 完整流程成功，包括登录重入、真实行动、认输和 Elo/历史结算；
六组计时视口和五组地格/手牌/技能视口均无布局违例。新测试脚本 ESLint 通过。

## 独立 APK 界面验收（用户选择 APK 后补充）

已生成 `dist/android-ui-acceptance/RedVsBlue-RED199-UI-Acceptance.apk`（22,073,590 字节），
应用名“红蓝对决·界面验收”，包名 `com.redvsblue.client.uiqa`，启动 Activity 为
`com.redvsblue.client.UiAcceptanceActivity`，与旧安装隔离，不启用旧手机主机桥接。
SHA256：`69B80A95A91C3DDEBD223BBD90E809312ABC304F7206B35F619AD1889313CF90`。

构建：在 Windows PowerShell 运行 `./scripts/build-android-ui-acceptance.ps1`。
可通过 `-JavaPath` / `-SdkPath` 指定 JDK 和 SDK。Gradle 的 `preUiAcceptanceBuild` 强制执行资源 staging，
重新构建当前浏览器引擎与 AI，固定采用仓库内置 Profile 身份，不读取本机活动资源包。
不调用旧 `sync-android-assets.js`，不覆盖 Windows 候选。

`android-uiqa-final-build.log` 构建通过；已安装只读模拟器 `Medium_Phone_API_36.1` / Android API 36.1，
实际屏幕 2400×1080，WebView 逻辑视口 914×363。确认首页正常、离线训练设置可加载，点击“开始训练”
创建真实 `large-hole-arena` 战斗、两名初始棋子，加载遮罩关闭，Android 错误日志无本次运行异常。
真实 APK 截图：`dist/multiplayer-qa/android-uiqa-battle.png`。尚未完成小米真机人工验收。

用户安装后先检查横屏全图、双指缩放/拖动和全图复位，再检查技能、手牌、地格。
离线训练没有联机倒计时；计时专项需连接测试服务器。
该包是本轮独立 UI 验收包，不能算手机房主/后台服务迁移或最终安卓分发版完成。

## APK v2：训练开局弹窗遮挡修复

用户真机截图显示训练设置标题和底部操作被裁掉。上一轮 APK 冒烟只通过脚本调用开始按钮，
没有检查按钮可视性，不能作为该弹窗触屏可用的证据。旧包在模拟器 914×363 视口下虽未重现
相同裁切，但回归检查发现开始按钮只有约 26.5px 高。

横屏训练弹窗现在限定于可用视口，标题、阵营选择及底部操作保留在屏幕内，两侧棋子列表独立滚动。
开始/返回按钮至少 44px 高，保留原纸张与墨线皮肤。未修改训练规则。

`tests/electron/android-training-setup.mjs` 连接真实 APK WebView，检查几何边界和命中结果，
以 CDP 触摸事件滑动列表、点击开始，并确认真实战斗初始化；不调用隐藏按钮的 DOM click。
v2 实测通过原生 914×363（密度 420）和 1200×492（密度 320）两个横屏视口，截图分别为
`android-training-914x363.png` 与 `android-training-1200x492.png`，日志为
`android-training-native-v2.log`、`android-training-density320.log`。测试后恢复模拟器原密度。

补充检查中，CDP 单独扩大逻辑视口未同步原生触摸边界，触摸检查失败，因此最终改用 Android 系统
显示密度产生实际视口。密度 280 会切入平板竖屏，触摸命中检查失败，该场景未通过，也不计入本轮
手机横屏验证。尚需用户小米真机复验，不能声称已通过其设备验收。

v2 构建日志 `android-uiqa2-build.log` 成功，安装成功；版本 `1.0-RED199-uiqa2`。
交付路径 `dist/android-ui-acceptance/RedVsBlue-RED199-UI-Acceptance-v2.apk`。
SHA256：`1EB5E407150CE2B9E819F0C8ECA1F8A38EC983EA0F3DEE3BFBEE879F99F59543`。

## APK v3：沉浸全屏与手牌/技能区折叠（2026-09-10）

用户已确认 v2 训练弹窗无遮挡。本轮继续修复系统留白与手机操作区：
- 验收 Activity 使用沉浸式系统栏，允许边缘滑动临时唤出；恢复窗口焦点时重新隐藏。
  使用 viewport-fit=cover 与 Capacitor 原有安全边距处理，窗口底色沿用深色。
- 手机地图外部点击、双指缩放和平移不再触发桌面式技能菜单 dismiss。
  显式“收起”折叠手牌及技能，不清除选中棋子；“手牌 / 技能”重新展开原技能。
- 收起时棋盘底部预留由 90px 减到 8px；强制选牌自动展示，渐进部署保留其操作空间。
- 独立审查发现角落按钮重叠及折叠按钮冒泡取消卡牌目标，均已修复并增加命中/目标回归。

当前基线 main / 895834297e3e49ebbf10b12074c08979931b6e01，快进保留本轮工作；基线检查通过。
构建及安装成功，APK 版本 1.0-RED199-uiqa3，交付：
`dist/android-ui-acceptance/RedVsBlue-RED199-UI-Acceptance-v3.apk`。
SHA256：`8CAD18D1E7466BC292B8322AB555474AF3774A36ADD4DAFA85A31ED298D23BA3`。

验证结果：
- `android-dock-tests.log`：手机交互与渲染器 37 项通过。
- `android-v3-tests.log`：57 项通过、1 项数据哈希失败；`android-v3-baseline-hash.log`
  使用未经本轮修改的 HEAD 测试副本同样失败，未更新快照。直接相关目标控制 5 项通过
  （`android-v3-target-controls.log`）。
- `android-v3-types.log`：类型检查失败于主线新增的 `electron-editor/content-pipeline-worker.ts:8`
  Promise 回调返回类型；本轮未修改编辑器。此失败不得写作全量类型检查通过。
- ESLint、编码检查通过；`android-v3-official.log` 完整真实官方流程成功，包含禁图、部署、
  对战认输与 Elo/历史，以及五组手机布局/六组计时视口。
- `android-dock-native-v3-recovered.log`：真实 API36.1 APK WebView 914×411（原914×363），
  物理2400×1080。真实格表面投影触摸选中、双指缩放平移后选中与技能保留、收起后棋盘增高超过50px、
  关键角落按钮命中、手牌展开/折叠、重新展开技能及全图复位通过。最后 renderCount=28、lastDrawCalls=31。
- `android-v3-fullscreen.png` 为返回前台后原生 adb 截图，棋盘与普通DOM正常；
  `android-v3-window.txt` 确认应用拥有焦点，statusBars/navigationBars 均 visible=false。

验收环境曾出现 system_server 丢失与截图异常，已保存错误日志并仅重启本任务只读模拟器。
恢复后首次全屏系统提示遮挡、测试使用浮层高度投影导致错点，以及延后派发点击导致的即时断言，
均分别通过系统UI树确认提示、真实格表面坐标及等待可观察状态处理；最终重新验证通过。
旧异常截图不作产品渲染通过证据。小米真机、反向横屏/缺口边距仍待用户复验；手机主机迁移未完成。

## APK v4：正式主菜单、手牌阅读与横屏排位（2026-09-10）

停止生成临时验收首页，直接打包项目正式 index.html；使用现有纸张美术和模式导航。
APK 内关闭旧 Service Worker 注册，避免旧页面缓存混入；未迁移的手机主机仍明确提示不可用。
安卓资源包按钮标注适配中并禁用：旧 ZIP/IDB 导入尚未接现行 Profile 校验、激活、回退，不宣称支持。
用户询问的 electron-updater 是 Electron 桌面更新库，未加入 Capacitor APK；安卓应用更新需单独方案。

战斗状态提示移至上方，手牌名称改为 12px 并换行。按住500ms打开现有完整卡牌详情；
允许10px内手指抖动，滑动和touchcancel取消计时。长按尾随click由触摸序列标记消费，
下一次touchstart清除，避免强制选牌误选；独立审查指出原2秒过期不足，已修复并验证持续5秒。
官方/房间/服务器页面增加 viewport-fit=cover 与手机横屏布局，去掉540px最低高度；
固定导航与服务器设置入口，内容/登录弹窗可滚动。原生APK不默认请求自己的https://localhost API，
未设置时明确提示配置真实服务器；非JSON响应报地址/端口错误，保持HTTPS策略。

`android-v4-tests.log`：13项手机交互/长按回归通过。`android-v4-native.log`：
真实APK914×411，手牌长按、提示不重叠、卡名字号、排位按钮/连接及账号弹窗可达通过。
手牌测试用临时展示夹具，恢复G后再导航，不提交出牌命令。
`android-v4-home.log`：正式主菜单可触达，实际点击训练营/自由训练进入战斗页通过。
截图 android-v4-home.png、android-v4-official.png、android-v4-card-preview.png。
`android-v4-official.log` 完整真实登录→禁图→部署→认输→Elo/历史通过；测试固定投影高度造成错点，
改用渲染器真实地格表面投影后通过。原生测试修正了详情display状态判断及等待列表惯性停止。
ESLint、编码、基线检查通过；上一版记录的全量主线类型/数据哈希失败未在本轮处理。

构建安装成功，版本1.0-RED199-uiqa4，文件 dist/android-ui-acceptance/RedVsBlue-RED199-UI-Acceptance-v4.apk。
SHA256：B2519A7AEAF24E45A53773A8DCC2C438634823F4409F7C88AD392530BDEB6205。
仍为独立UI验收包，未宣称安卓手机主机、资源包导入或应用更新完成；待用户小米真机复验。

## 后续候选：三维训练、手机主机和紧凑资料页（2026-09-10）

本节替代上文“手机主机未完成”的历史状态。环境为本任务隔离 AVD API36.1、
x86_64、WebView134、2400×1080（CSS约914×411）；不是应用宝或小米真机。

- APK 原生 Node24/Colyseus/SQLite 已启动，客户端与主机 Profile 双身份一致。
  `android-host-1v1.log`：2人SDK加入、选择、渐进部署、认输终局，authority/durable均2。
  `android-host-2v2.log`：4人、24×20地图、队友认输同意、终局，authority/durable均3。
  两者终局房间均从大厅移除。测试首轮使用错误地图ID，修正为真实目录 twin-fronts 后通过。
- `android-host-relay-background.log`：Android锁屏、手机权威、电脑客户端经真实relay加入，2v2终局通过。
  relay只允许加入/重连，创建在本机完成；第一次尝试从relay create被按设计拒绝，未放宽白名单。
- build13 原生验证：停止成功后立即开房成功；启动150ms后请求停止，启动未成功且最终state=stopped。
  独立审查发现并修复旧reader晚到状态、旧进程退出前重开、Service销毁窗口和升级bundle残留。
- `android-training-final.log`：APK自由训练正常进入三维战场；真实触控缩放和平移、选中棋子不消失、
  技能/手牌收起展开通过。渲染统计含320个地格实例和实际draw calls。
  保留完整三维棋盘；无二维故障替代。构建新增所有页面内联脚本语法检查。
- `android-library.log`：吉安娜基本资料和3个技能在一屏展示，技能/手牌/关键词分类可切换，
  关闭详情不留控件；棋组栏移至左侧，列表区297px高，底部确认不覆盖；6个教程分章显示，不需要纵向滚动。
  截图需先关闭Android首次全屏提示；系统提示覆盖期间CDP截图曾出现侧栏合成比例异常，
  用ADB实际屏幕核对并关闭提示后重验，未修改真实布局去迎合异常截图。
- `android-3d-regression.log`：三维渲染、WebGL低开销重试、完全失败显式抛错、触控/手牌共41项通过。
  `android-sqlite-unit.log`：真实SQLite worker下中途插入失败整批回滚、精确重复、冲突重复、校验损坏、
  schema拒绝、worker退出拒绝写入、旧会话不恢复通过。`android-native-unit.log`：原生文件边界5项通过。
- 新增主机及紧凑页面ESLint通过；编码和最新main基线检查通过。
  全量类型检查仍有原有 `electron-editor/content-pipeline-worker.ts:8` 错误，未修改编辑器范围。

应用更新/资源包为前序已批准候选能力：HTTPS完整APK下载、校验并交系统安装器，
资源包使用共同Content Pipeline v1验签、预检、启用和回退。GitHub Release尚未上传，默认更新源
没有新资产时不能认为“已上线更新”。手机开房期间禁止启用资源或安装APK。

交付为调试签名候选，未自动发布/合并。待用户小米17PM或应用宝复验三维驱动、
ARM64启动、局域网实际互连、系统通知授权及更长后台/锁屏；不能称正式发行验收通过。

### v16 手机参赛闭环

`android-host-live-ui.log`：实际APK主菜单开房→进入大厅→创建房间→选阵营→电脑SDK加入并准备→
手机连续点选8枚棋子→确认→手机进入三维联机战场→电脑认输→手机收到终局，通过。
roomId `d4fqcchf7`，三维canvas存在，320地格实例、21 draw calls，两名参赛者。
测试修正了首次排版等待与误引用局部变量，未绕过真实开房/选棋点击。
`android-host-live-3d.png` 的CDP截图遗漏WebGL合成层，不能作为三维视觉证据。
最终以ADB系统截图 `android-three-d-device.png` 核实v16 APK的完整三维棋盘、棋子和常驻技能栏实际显示。

此闭环发现并修复：横屏开房确认按钮裁切；选人每次重绘重复绑定长按监听，使第二次普通点击留下
无法取消的600ms计时器、误开详情。新增长按单次绑定、短点击/移动/取消清理及尾随click消费，
`android-selection-touch.log` 8次普通点击+长按+取消回归通过。加此前47项共48项相关测试通过。
独立复核最后无新阻断；不等于人工体验验收通过。

交付文件：`dist/android-ui-acceptance/RedVsBlue-Android-candidate-v16.apk`，versionCode16，约92.4MiB。
SHA256 `BD184CF4CB064D81B938DCBA34FD93E5360220492FDDF1699DFE56AB29736820`。
包内含arm64-v8a/x86_64原生Node、运行文件清单哈希和许可证，默认正式GitHub源，未包含QA根证书、
测试发行者密钥或二维替代。APK尚未上传Release。v15仅内部调试，用户应使用v16。

### Windows / Android 配套 v17（2026-09-10）

用户请求 Windows 互联包。首次完整 Windows 构建和隔离成品 network-client 冒烟通过：
内置 PostgreSQL、Colyseus 开房/加入、观战公开视图、终局清理和退出无残留。
打包检查发现历史 `data/users.json` 仍随 native app/data 复制；账号文件不应分发。
排除后真实 APK / Electron 双端校验发现旧 Bundled Base 也把该文件纳入身份，导致与 v16 不兼容。
失败的 Windows v16 ZIP 移至内部 QA 目录，未交付，不能使用其中旧身份说明作为通过证据。

共同 Bundled Base 现明确排除本地账号 JSON；Windows 与 Android staging 同时排除实体文件，
源账号文件保持原样。测试覆盖账号不存在、存在与内容变化均不改变两个 hash，且打包 entries/
manifest 不含账号；修改真实棋子生命值作为正对照仍改变两个 hash。17 项打包/身份测试通过。
首次回归因夹具假设可选 public/images 目录存在失败，已按真实可选资源行为修正。

配套版本升级至 Windows RED199-v17 / APK versionCode17；需两端一起更新，不能与 v16 混用。
本轮是用户授权的本地未签名 Windows ZIP、调试签名 APK 候选，不是正式 Release；保留源码
base commit 和 dirty snapshot hash，不把未提交源码冒称为 clean-commit 发布产物。

最终 `windows-v17-cross.log`：真实 Electron 成品与已安装 API36.1 APK 双向持续 Colyseus 连接通过，
手机房主/电脑加入 room `u9fkzkbxq`，电脑房主/手机加入 room `wm9we80px`，均2人在线，
测试后删除自建房间、停止手机服务。使用 ADB TCP 转发，不代表实体 Wi-Fi 或小米真机验收。
首次脚本等待冷启动ready超时，后续使用已有 ensureLocalAuthority 入口成功；连接脚本只写旧
rvb_server_url 导致持久连接仍走本机，已改实际 saveServerConfig 接口后通过，未改产品连接协议。
Windows/安卓指纹均为 resolved `e46dae3c1bf77d4dc5cdc3b48537416ae623ddccf5baa408b35a20e8e9cc0e2b`，
authority `82f8e5227055fb07ee0e7dc703e2a05c095d4b0f6f0875fd324be87f1569306a`。
APK v17 SHA256 `E9EAED630A60F8B600811C7AFE78777C475EF0E7D6566A4C911EB315B03F8780`，
ZIP条目检查所有路径均无users.json。两端构建、17项测试、相关lint/编码/基线与独立审查通过。

### v18 局域网发现与真实地址连接（2026-09-10）

用户反馈 v17 电脑与手机热点互相发现、手动加入均失败。复现 APK 对非 loopback HTTP 地址的
请求被 WebView mixed content 拦截；v17 的 ADB loopback 测试遗漏了这个条件。手机当时已关闭
主机，探测热点 2567 无响应不能作为 Android 服务未监听的证据。

本轮修复：快速扫描同时探测 2567/38621 及当前 IPv4 子网全部主机地址；全量补充 Windows
动态备用端口；从原生桥获取 Android 网卡地址，过滤 loopback/link-local，优先 Wi-Fi/热点网卡。
主菜单修复连续括号表达式导致的 ASI 调用异常、扫描进度、取消后的迟到结果；搜索弹窗直接
输入房主地址，健康检查与 Profile 准入失败时保留可读错误。纯外观资源 hash 差异允许通过，
权威内容、ABI、runner/schema 不一致仍拒绝。

仅可信打包游戏页允许 HTTP/WS LAN transport，同时为 HTML 设置 CSP 阻止远端脚本、iframe、
object、表单导航；Android 明确限制已打包页面导航，保持证书验证，Electron 保留 sandbox、
webSecurity、contextIsolation。未启用全局忽略证书或关闭 Web 安全。

证据位于 `dist/multiplayer-qa/`：
- `lan-v18-tests.log`：9 项发现/取消/菜单/资源准入回归通过；保留修复前失败日志。
- `lan-discovery-native-v18.log`：实际 APK 自动扫描发现 NAT 网关上的 Windows 主机，
  触控点击发现结果进入大厅通过；不是只向界面注入模拟结果。
- `lan-v18-types.log`、`lan-v18-lint.log`：受影响 Electron 类型与源文件 lint 通过。
- `android-v18-native-tests.log`：Android 本地页面边界单元测试构建通过。
- `lan-v18-native.log`：真实成品 Windows 与 APK 双向使用主菜单地址输入进入大厅、持续
  Colyseus 连接和 2 人加入通过。两端非 loopback HTTP/WS 放行；远程脚本、frame、外部导航
  被阻止，无效 TLS 被拒绝。Windows 连 Android 经测试 TCP 桥；Android 连 Windows 经模拟器 NAT。
- `windows-v18-package.log`、`android-v18-build.log`：成品构建与内置 PG/页面资产校验通过。
  首次 Windows 打包下载 Electron 网络超时，使用开发环境代理后重新打包成功；代理未内置进产品。

独立 AI 审查的外观兼容性问题已修正，最终窄范围复核无阻断。交付前最新 main 基线与编码检查
通过。全量类型检查仍受前述既有编辑器错误限制；本轮没有改动该范围。
配套 Windows RED199-v18 / APK versionCode18，资源身份与 v17 一致；需更新两端以覆盖各自
传输限制修复。APK SHA256 `06B4525968DDE0F1A8938DFA0A8A0526D0EEB4F36FF1A860600EC18BB162C7AA`。
Windows ZIP 位于 `dist/multiplayer/RED-199-v18/`，含源码 dirty snapshot、文件校验清单及复测说明。
真实小米热点、实体 Wi-Fi、防火墙和后台行为仍待用户复测，不把模拟器 NAT 当作真机验收通过。

### 用户验收与 PR 收尾（2026-09-10）

用户在 v18 交付后明确确认“验收通过了”，要求创建 PR 并由其自行合并。本轮客户端及互联
验收据此记为人工通过；排位尚未进行人工验收，用户明确接受后续发现具体问题再另建 issue。
不将既有自动化排位测试写成人工排位验收通过，也不在本次提前创建未知故障任务。
正式签名与 GitHub Release 发布仍是独立步骤，本 PR 不执行发布。

提交前 `pr-red199-tests-final.log`：25 个文件共 204 项，203 通过；唯一剩余失败是既有
`battle-effect-icons.test.ts` 状态图标注册覆盖。通过 git archive 将 HEAD 的原始 data、测试和
配置导出到独立目录，`pr-baseline-icons.log` 复现相同失败（6 通过 / 1 失败），未改其注册表。
首轮额外包含 targeting：既有准备 hash 不一致仍失败，与前述 HEAD 复现一致；未更新 hash。
本轮相关菜单/训练夹具已适配已批准的真实入口与跨端桥；LAN 测试补足类型后仓库完整 lint
通过，ESLint 配置测试通过。既有编辑器 typecheck 失败仍明确保留，不宣称全库测试全绿。
