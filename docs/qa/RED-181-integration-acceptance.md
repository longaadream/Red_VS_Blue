# PVE 集成验收

范围：当前 PVE 三幕探索、共享资源、Colyseus 联机及节点存档、棋盘可读性与编辑器模式/威力控件。风险 High，用户要求整理 PR 与人工验收；不合并、不发布。

主线基线：53c2c9ca3eef73d2158645b93138e242c225c604。现有未提交文件已逐类核对：data 是 PVE 配置、三幕地图、三种新怪及对应技能图片和公共 manifest；lib 是探索/合作存档和最小模式边界；页面是冒险入口、联机与共用棋盘；编辑器仅两个字段组及异步类型修正；tests/docs 是相应回归与记录。自动审批拒绝目录级暂存后改用精确文件清单。

验证：19文件178项探索/资源/联机等测试通过；资源字段新增坏配置拒绝测试通过（20项）；3文件43项联机/激活API/编辑器工作台通过；空房间租约自然释放SDK回归通过；类型检查、ESLint、浏览器引擎构建通过。

## 逐步人工验收
1. adventure.html 选择初始队伍，右键查看待部署棋子，返回主页再进入。
2. 种子145783：站到事件格后可以交互也可继续移动；手牌文字可读、成长威力随状态变化。
3. 进入战区：预告与免费部署、死亡提示跟随棋盘棋子，获胜后收队。
4. 编辑器导入 output/pve-roguelike/resources/base-with-exploration.rvbpack，检查三幕地图、八种敌人及技能图像、探索配置与卡牌威力；PVE专属不进入PVP选择。
5. 双客户端使用同一资源包进入正式Colyseus服务，从PVE列表组队、各选小队并准备；验证个人回合、牌与金币、预告同步。错误权威资源哈希应被拒绝。
6. 节点结算后房主保存，重新开房加载；检查地图、棋子、资源与成长；非房主保存被拒。

## 尚待验证
8876 是单人静态预览；SDK测试使用真实Colyseus传输与内存仓库。PostgreSQL重启恢复、双桌面人工联机与跨进程宿主切包流程尚未验收。活动房间租约保护当前同进程激活路径，空房间宽限期后释放。4张卡可用，56张仍为设计草案。

回退使用撤销本轮提交；不删除用户数据、不迁移旧存档。


## 主线同步复验
保留 PVE focusCell 与移动端 zoomBy，重新构建冲突的引擎产物。同步 main 53c2c9c 后，19 文件185项测试通过（探索、资源、Colyseus、棋盘与移动端）。GitHub CLI 检查器返回 blocked：未登录；使用连接器确认 PR 元数据，不宣称远端 CI 已通过。


## 桌面客户端启动修复
真实客户端首次启动健康检查错误地将 PVE 专属怪加入 createDebugDuel 的 PVP 自动阵容，导致 PROFILE_STARTUP_RECOVERY_HEALTH_MISMATCH。自动补位现按 availability 过滤，显式指定仍保留权威拒绝。debug-battle 13项测试、定向 ESLint 与客户端构建通过，独立审查无阻断项。使用独立 output/pve-client-acceptance 用户目录进行桌面验收。

## 客户端反馈：广播、动画与独立存档

用户批准每次手动保存保留独立记录，并从列表选择旧进度。范围限定 adventure 会话、Colyseus 存储/广播和对应页面；不改伤害、奖励或平衡。风险 High（新增存储表），checkpoint v1 不变。基线仍为 53c2c9ca3eef73d2158645b93138e242c225c604，2026-09-12 fetch 与 main-baseline 通过。

- 广播不再每次读回整份 PostgreSQL 存档；aggregate 和各玩家 snapshot 按 session 实例及 revision 缓存。每条命令仍等待持久提交后确认。尚未测得真实客户端帧率或操作延迟，不能据此宣称卡顿全部消除。
- 合作会话保存本次动作与表现事件，每个接收玩家分别过滤私有事件。事件不写入存档；页面忽略同 revision 的广播/RPC 重复结果，避免动画重复播放。
- 手动保存以单条 SQL 原子更新最近进度并追加 rvb_adventure_saves，重复点击生成不同 ID。自动保存继续保留每个 run 的最新进度；列表隐藏已被同版本手动记录包含的自动副本。旧 run ID 继续可读，加载历史后创建新的 run。列表只查询标量，不返回全部存档 JSON。
- 保存成功后按钮恢复可用，列表标明手动/自动、幕数、时间和进度版本。

验收：真实 Colyseus SDK 与合作会话 11 项通过；真实内置 PostgreSQL 测试通过（连续保存、越权/过期拒绝、推进后旧快照不变、数据库重启后恢复）。最初沙箱内 PostgreSQL 无法启动，使用隔离临时实例在正常权限下验证通过，不接触用户当前数据库。独立 AI 审查未发现阻断问题。

最终复验：17 文件 146 项探索与 Colyseus 回归通过；全项目 tsc、定向 ESLint、浏览器引擎/Colyseus/Next 客户端构建和 Electron preflight 通过。日志位于 output/pve-roguelike/feedback-regression.log、save-history-postgres.log、save-history-types.log、save-history-lint.log 及 feedback-*-build.log。

人工步骤：结算后连续保存两次；推进后再保存；返回冒险准备的“继续存档”，选择最早记录，确认地图/资源回到对应进度。双客户端观察移动与攻击动画，并比较操作等待。当前正在运行的旧客户端不会自动加载新服务器代码，需用户保存并退出后再重启验收。

回退：撤销本轮代码提交即可恢复旧逻辑，保留新增表和历史记录，不删除或修改用户数据。旧版只能显示最近进度，重新升级后历史再次可见。新增表为启动时幂等创建，无 checkpoint 格式迁移。

## Windows / Android 候选包

用户要求提供两端可安装包并验证安卓界面。范围为冒险 CSS、触屏队伍详情及现有打包流程；风险 Medium，不修改玩法。Android 本轮作为 Windows PostgreSQL PVE 房主的客户端；手机本地 SQLite 主机尚未接入 PVE repository。验收不使用旧 build:android:apk 的手机服务脚本，使用现有 uiAcceptance 变体及锁定 ARM64/x86_64 运行时，应用 ID 为 com.redvsblue.client.uiqa。

短横屏的钱包收起次要按钮，队伍主动展开并横向滚动，部署后收起；待部署棋子提供明确的触屏“详情”按钮。冒险弹窗至少 44px 点击目标，存档历史可滚动。大厅保持原纸张/墨线样式并缩短横屏标题与肖像区域。待验证尺寸为 640×360、800×360、手机竖屏；检查保存/返回/关闭可达、十余名后备棋子的滚动与手牌不重叠。独立只读审查已指出并纳入上述三处适配问题。

实际 APK 验收发现并修复：大厅跳战斗页未先释放旧 socket，导致“该玩家已经连接”；展开菜单的 CSS 优先级导致按钮仍被隐藏；详情被 PVE 浮层覆盖。现在先等待大厅连接离开再跳转（活动 run 保留认证席位），详情打开时隐藏相关浮层。独立复核无阻断项；四人同时跳转及弱网超时仍待人工验证。

Android 16 / WebView 134.0.6998.135 / x86_64 只读模拟器实际安装启动通过。大厅 393×851、640×360、800×360 无横向溢出；实际 914×411 CSS 视口完成触屏队伍、详情、关闭、菜单、两次独立保存。真实 Windows 分发包启动 PostgreSQL 服务，APK 通过 ADB reverse 接入（不是远端公网网络证据）。WebView CDP 截图不包含 3D canvas 的最终画面，棋盘使用 ADB 系统截图另行核对。日志 android-native-ui-settled.log，截图 android-ui/。此前瞬时触摸和调试尺寸变化造成的测试误差保留在失败日志，不计为通过。

构建：Windows 使用本地 Electron 43.4.0 替代停滞的重复下载，资源一致性与 PostgreSQL 包校验通过；Android uiAcceptance 包包含锁定并通过 SHA256 校验的 ARM64/x86_64 运行时。移动端 22 项单测与定向 ESLint 通过。候选位于 dist/RED181-PVE-Candidate，未发布到 Releases；手机真机性能、不同厂商系统、完整四人对局仍需人工验收。

### 撤回首轮界面结论并补做可操作性验收

用户指出截图不可玩：64×64 全图缩得太小，面板堆叠。首轮“按钮可点”不能代表可玩，旧 ZIP 已移到 output/pve-roguelike/superseded-packages，不再作为交付候选。

最终镜头支持按相邻格屏幕距离聚焦，手机初入探索/战区目标 44px；focusCell 退出 overview 模式，resize 不再回到全图。进入战区或主动回中时聚焦战区，后续行动保持玩家平移；普通探索移动只跟随队长，不重置用户缩放。大地图提高允许缩放上限，常规 PVP 镜头流程不变。资源/AP/队伍入口放到缩短回合条后的顶部空位，底部保留技能和手牌；详情打开时隐藏 PVE 浮层。

新回归先复现格子过小，再修复；最终 53 项镜头/移动端测试通过，包含战斗连续 revision 不强制居中。tsc 与定向 ESLint 通过。最终实际 APK 在 914×411 CSS 视口测得相邻格最短距离 42.46px，真实触屏选中并移动队长、14名后备的滚动布局、详情打开关闭、菜单和两次独立保存全部通过。日志 android-playable-final.log，ADB 原生截图 android-ui/tactical-native.png；该截图包含实际 3D 棋盘。仍不将模拟器结果代替 ARM64 真机和完整四人长局验收。

## 2026-09-12 安卓本机 PVE 宿主

本轮撤销“安卓必须连接 Windows 才能进行 PVE”的候选限制。安卓注入 SQLite AdventureRepository，复用同一 AdventureRoom、资源身份验证、四人准备、权威命令与 checkpoint v1。冒险入口通过 RvBHost 启动原生服务并使用返回的本机地址；本机未运行时，房间列表显示启动指引。

验证：Android SQLite 与 Colyseus 三文件四项测试通过，覆盖真实 SQLite worker 重启后历史、连续独立保存、错误房主/版本、重复回执事务回滚、PVP 存储隔离。全项目 tsc 通过。真实 APK（Android 16 / WebView 134）从独自出发启动手机本机服务，触屏移动、详情及两次保存通过；通过 ADB 将手机 2567 端口映射到电脑，三个桌面 SDK 以真实签名身份加入，与 APK 共四席准备并开始，版本一致，非房主保存拒绝。停止原生服务后由“继续存档”自动启动，读取先前历史成功。

脚本：tests/electron/adventure-mobile.mjs（RVB_ADVENTURE_QA_LOCAL=1）、tests/electron/adventure-android-host.mjs。日志：output/pve-roguelike/android-local-host-ui.log、android-native-coop-restart.log、android-host-tests.log。这些是模拟器本机权威和真实 SDK 证据，不代替 ARM64 真机、物理局域网、全四人长局或所有厂商后台策略验收。独立审查未发现阻断项。

使用：安卓直接选择队伍后独自出发，或创建组队房间；不需电脑服务器。局域网队友填手机地址 http://手机IP:2567 并输入房间号。公网沿用现有主机发布/relay。存档保存在房主设备，多次保存保留历史；停止服务或强杀后从“继续存档”恢复。不会自动把电脑存档搬到手机。

最终 APK 再验：四席场景下将应用退到后台 15 秒，电脑 SDK 仍能读取同版本快照；返回应用后连续保存，停止并重启原生服务，再读旧档成功。该短时窗口不代表所有手机的长期后台保活。最终包 SHA256：CA2AFDA88484CCAB7952315A5820DE0E9FE9670E563EAACE6B1634DF0E5B801B。

提交前基线检查遇到 GitHub Git 传输连接重置，check:main-baseline 返回 REMOTE_UNREACHABLE，未绕过或标为通过。GitHub 连接器核对 PR #175 base SHA 仍为 53c2c9ca3eef73d2158645b93138e242c225c604；远端 CI/正式合并门禁保持待验证。
