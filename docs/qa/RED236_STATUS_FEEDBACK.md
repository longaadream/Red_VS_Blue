# RED-236 黄色操作提示与状态展示

## 合同与基线

- 角色：实现者；风险 Low，仅表现层。
- base_branch: main；base_sha: 9d1b0c30801cd733ec4cede37ce1ef0889a2313a；已 fetch origin --prune。
- 独立分支 codex/RED-236-status-display 从刷新 main 创建，再快进依赖 RED-234 的 291013a16dc9388a4c0c1ea68b4cdd10dd0573de。该依赖的 AI 空过未解决项不属于本任务。
- 创建后 main baseline 检查通过，behind=0。保留原玩家38677对局，不刷新或提交操作。

## 修改前证据

- 独立浏览器38679使用现有 localhost + tutorialPerf + qaReplay 受控入口，读取 output/RED236/status-fixture.json。基于 seed18707真实课程开局并执行合法部署，额外状态仅为展示测试数据，不声称来自一次真实技能结算。
- 维伦 training-red-8 (18,4) 的标签在棋盘摘要、展开列表及详情均显示 divine-shield、freeze、root、sage-mode、resurreccion。隐藏状态未展示。
- 中文注册表本来已有圣盾/冰冻等名称；投影和详情直接优先取 name，内部ID覆盖中文名称。
- 皮肤将操作提示字号覆盖为11–12px，并以手牌高度定位到屏幕中线以下。
- 修改前现有图标套件6通过/1失败：新内容 akaza-damaged、el-primo-meteor-belt、max-speed-shot-recast 未分类。需按可见性补齐；不可把内部记账状态公开。
- 修改前现有 motion-feedback 套件13通过/1失败：selectPiece 的 pendingActionFeedback 源码正则断言与依赖基线不符；不属于本任务，不修改该逻辑或断言。

## 验证

- 展示链统一通过 labelForStatus：棋盘/展开/详情/历史/状态获得浮字使用可读名称；有效中文自定义名保留，已知状态英文别名与内部ID回退中文词典，未知ID显示“未知状态”。
- 57个可见注册状态条目、28个新SVG；只有天照的状态/地格语义别名 amaterasu 与 amaterasu-burn 共享图标，其余按语义独立。隐藏标记不公开，棋盘常驻最多2项及溢出入口保持。
- 黄色提示字体24–36px，水平50%、高度42%；瞬时反馈显示时隐藏底层常驻提示避免重叠，保留3秒时长和瞄准模式现有提示行为。
- 最终六套直接相关测试89/89通过（battle-effect-icons、battle-piece-status-summary、battle-action-history、tabletop-battle-bundle、battle-renderer-3d-runtime、battle-floater-layout）；命令 npm.cmd test -- 对应上述文件 --maxWorkers=1。详情图标既有契约定向1通过/48未运行：npm.cmd test -- tests/game/battle-page-contract.test.ts -t 'renders registered status SVGs' --maxWorkers=1。合计90项通过，跳过项不计为通过。
- 独立审查四套37/37通过，typecheck、定向ESLint、git diff --check通过，无实质性阻塞发现。审查查看了原始状态详情、桌面/竖屏提示和非法操作截图，不代替人工体验验收。
- 额外边界套件20通过/1失败：_preferredInitialZoom 与 widthCoverageZoom 的旧源码正则。renderer及该测试均与依赖291完全一致（git diff --quiet返回0），未顺手修复。既有 motion-feedback 的 pendingActionFeedback 断言及探索记录的 target-overlay 旧断言失败保留。完整测试集没有报告为通过。
- 最终 npm.cmd run typecheck、影响JS/测试文件ESLint通过。check:encoding通过（1474文本文件），提交前main baseline检查通过（behind=0）；无需重建规则引擎，因为未改规则源或生成产物。
- 实际浏览器1280×720：操作提示36px，中心(640,302)；390×844：24px，中心(195,354)，宽344px；844×390实际非法移动瞬时提示25.32px，中心(422,164)，宽760px。手机横屏继续保留既有隐藏常驻提示的行为，但瞬时错误提示可读且不出界。
- 维伦展示夹具验证圣盾、冰冻、定身、仙人模式、归刃中文名，5张图片 complete/naturalWidth 检查通过；隐藏标签不出现。选择安度因点击远处非法移动格时显示“这条路被挡住了。”，只有一层黄色提示；页面warn/error日志为空。
- 证据 output/RED236/status-before.png、details-before.png、status-after.png、feedback-after.png、mobile-feedback.png、invalid-feedback-after.png、landscape-invalid-feedback.png。夹具仅用于显示验证，不证明所有技能规则结算；并未逐个真实施放全部57种状态。
- 正常候选入口 http://127.0.0.1:38679/battle.html?mode=tutorial&lesson=tactical-intuition&practice=1（不含qaReplay，不注入展示夹具）。原玩家38677页面未刷新，测试临时页已关闭，临时视口覆盖已恢复。

## 人工检查与回退

查看普通操作提示与非法操作提示的字号、横向居中及略高于中线；检查圣盾、冰冻、变身等状态名称和图标，以及隐藏状态不公开。手机横竖屏确认长提示不出界、不覆盖操作按钮。

仅撤销本任务的表现层提交即可，无存档迁移、数值或规则变更。不得合并或发布；人工体验验收由负责人完成。
