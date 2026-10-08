# RED-242 任务合同

本地合同副本用于独立审查；原始批准与合同位于 Linear RED-242。
目标：将在线社区作为首页显眼入口，降低玩家主动联机的决策成本；交付官方账号好友及小型公告板。
角色：实现者；High 方案待人工批准后实现。
base_branch: main
base_sha: 9d1b0c30801cd733ec4cede37ce1ef0889a2313a（2026-10-08 git fetch origin --prune并显式刷新main，后续实现前再次刷新确认）。
方案：复用官方账号/会话与官方服务器，好友和社区数据独立于战斗规则与journal，以新增表持久化，不更改原账号表含义。好友昵称/UID搜索，申请/接受/拒绝/撤回/删除/屏蔽；只向好友展示有限在线状态。第一版公告板提供官方置顶公告、玩家约桌/交流纯文本帖、分页回复、自删与管理员隐藏，长度/频率/权限服务端验证。邀请第一版复制现有房间码/入口，不新建自动入房权限。
首页突出进入在线社区；有有效官方会话自动连接社区，无会话每次客户端启动首次进首页弹出可关闭登录提示，明确继续离线，本次不重复弹出。断网/认证失效可重试，不循环弹窗，不因网络可用就强行跳出对局。在线状态通过受认证心跳并在失联后过期，不将本机网卡联网当服务端成功。登录弹窗方案待人工确认。
allowed_paths: lib/server/official/\*\*必要新增community模块及http/server集成；data/pages/index.html、official.html、新community页面及相关js/css，复用home-account/utils/lobby-entry仅必要接入；直接tests/ui、tests/colyseus、tests/integration/postgres社交用例；docs/technical与docs/decisions及任务QA；必要桌面入口生命周期最小接口须事前说明。不处理PVE/AI/教程/战斗数值、私聊/群组/图片上传、自动匹配、推送或第三方平台、部署发布。
验收：双账号申请可接受且重启保留；重复/交叉申请与非收件人接受不破坏关系；屏蔽阻止申请；昵称显示与搜索不暴露邮箱；心跳过期离线；已登录首页能进入社区，未登录首访提示可关闭且本次不重弹；断网保留离线入口；帖子回复分页、有界纯文本、非作者删除拒绝、管理员隐藏、限频；邀请码不绕过原房间校验；原官方登录/排位与离线练习不回归。
测试：直接行为与UI回归、TS/ESLint/encoding、真实PostgreSQL持久化、双客户端候选冒烟及截图、独立AI审查。风险High：账号鉴权/持久化/跨模块；回退关闭社区入口与接口，新增表保留不删除，旧账号与战斗继续工作。独立分支从刷新main创建，既有PR228UI若需依赖逐项记录保留，禁止覆盖历史修复；不自行合并发布。
2026-10-08 用户明确批准全部方案，包括每次启动首次到首页的一次可关闭登录提示。开始实现；保留既有RED241候选修复，分支从刷新main创建后整合已授权候选，记录依赖。
实际开发分支 codex/<issue id="111113ce-c772-471a-88c5-10592c1b6d53" href="https://linear.app/redvsblue/issue/RED-242/%E6%B8%B8%E6%88%8F%E5%86%85%E5%A5%BD%E5%8F%8B%E7%A4%BE%E5%8C%BA%E5%85%AC%E5%91%8A%E6%9D%BF%E4%B8%8E%E6%98%BE%E7%9C%BC%E7%9A%84%E5%9C%A8%E7%BA%BF%E7%99%BB%E5%BD%95%E5%85%A5%E5%8F%A3">RED-242</issue>-community：从刷新origin/main 9d1b0c30801cd733ec4cede37ce1ef0889a2313a创建，随后ff继承RED241 ce6310ba882e06502bb9abe98d65af48b85491c9以保留已授权UI/手牌预演/移动修复；check:main-baseline通过ahead31 behind0。PR review_base使用RED241候选分支，明确依赖PR228，不把旧修复重复当本次修改。
启动生命周期最小接口：electron-client/main.ts为游戏窗口传入本进程随机公开launchId additionalArgument，preload.ts仅暴露只读getCommunityLaunchId；首页以该标记抑制同次启动重复提示，重启标记更新。不增加可写IPC/文件/账号凭据，不影响admin/editor。allowed_paths补充上述两个文件与直接tests/electron启动提示边界。
验收补充：在线状态必须跨首页/大厅/对局页面继续维护，不能进入对局90秒后误显示离线。复用已允许的data/pages/js/server-utils.js接入官方账号心跳生命周期，不改BattleState或战斗页面；禁止凭据降级到HTTP，401只清理匹配会话，旧服务不可用不影响离线。账号窗口提供显式重新连接社区入口以恢复临时网络失败。直接VM跨页/过期会话回归与独立审查。
