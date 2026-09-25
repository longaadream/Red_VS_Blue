# RED-216 鬼舞辻无惨验收记录

状态：实现与自动验证完成，等待人工验收。

- 任务：[RED-216](https://linear.app/redvsblue/issue/RED-216)
- 基线：`origin/main` 的 `bc76ce78e9014f50e5ef1ea445895de8979b0ea1`。
- 依赖：RED-215 待人工验收候选 `642dfd6dba4a7e3b33254a024857d0e6e7699126`。
- 工作分支：`codex/RED-216-muzan`。
- 风险：Medium，涉及游戏规则、可暂停选择和濒死处理。

## 验收场景

1. 角色池出现暗方无惨，基础属性为 15/4/1/4，展示四个技能。
2. 四个正方向分别放置距离 1、3、4 的敌人，另放斜向敌人及友军；鞭击只命中正方向 3 格内的敌人，扣 AP 1 并进入 CD 1。
3. 冲刺实际路径内敌人受到 0.75 倍伤害，存活目标获得定身，自身获得 50% 减伤；墙体、占用地格、距离和方向非法时不得污染状态。
4. 减伤和定身在施加当回合不扣持续时间，只在持有者自己的后续回合结束扣减。
5. 在任一玩家回合结束检查再生：未满血且当回合无实际生命损失则恢复 2；满血、已受伤或禁疗时不消耗次数；成功恢复三次后不再触发。
6. 寄生可选择中心 5×5 内的友军、敌军及召唤物；范围外、死亡棋子及自身不可选。
7. 充能不足、没有宿主、没有相邻落点或取消选择时不误扣费；完成所有选择只扣一次 CP 2。
8. 注入血液后宿主转阵营并真正获得再生，无惨正常死亡；已有再生的宿主不刷新次数。
9. 寄生没有伤害免疫或容器选项；宿主保留原技能、属性和当前生命，无惨正常触发死亡效果并掉落符合规则的充能结晶。
10. 训练营直接动作入口与正式房间 runner 均能完成选择、恢复和结算；同初态、种子和命令得到相同结果。

## 验证记录

集成验证（2026-09-26）：

- 血肉再生 8/8、主动技能 11/11 通过；实际 JSON 经规则运行时执行。包含获得再生之前受伤的失败复现与修复、全额护盾，以及两个范围技能首目标反伤击杀施法者的回归。
- 独立审查复现了新宿主当回合受伤漏记和同 ID 独立攻击源快照的冻结检查问题；均已修复。攻击者即宿主测试的重复 ID 已修正。最终生产代码、7 项寄生测试及新增 9 项边界测试均经独立复核，没有未解决的实质性发现。
- `npx.cmd vitest run tests/game/summon-death-batch.test.ts tests/game/position-contact.test.ts tests/game/damage-pipeline.test.ts --maxWorkers=1`：3 文件，78/78 通过。日志 `dist/RED-216/core-first-pass.log`。
- `npm.cmd run build:game-engine` 成功生成主浏览器、训练 AI、冒险及 Android 引擎镜像。`npm.cmd run build:colyseus` 成功生成 `_client-colyseus/colyseus-server.mjs`。
- 生成后 `npx.cmd vitest run tests/game/muzan-browser-bundle.test.ts tests/game/muzan-active-skills.test.ts tests/game/muzan-regeneration.test.ts --maxWorkers=1`：3 文件，23/23 通过。浏览器测试使用真实 runtime、VFS manifests 和编译 bundle，验证两步寄生、扣费、宿主转换及无惨入墓。
- 16 文件相邻回归：317 通过、1 失败（日志 `dist/RED-216/core-final.log`）。覆盖伤害、死亡、位移、空间、效果链、批次、待选择、房间入口、RED-215 多段伤害、资源版本固定、角色池和冷却。
- 唯一失败：`pending-presentation-contract.test.ts:56`，选择方收到动画后 `activeRootId` 仍为 `a:0`。在干净的 RED-215 依赖工作树（HEAD `642dfd6dba4a7e3b33254a024857d0e6e7699126`）单独执行同一文件，得到相同的 1 失败/2 通过。该用例仅加载未修改的表现层脚本，属于既有失败；本任务未扩大范围修改它。
- 最终角色套件：`npx.cmd vitest run tests/game/muzan-active-skills.test.ts tests/game/muzan-regeneration.test.ts tests/game/muzan-parasitism.test.ts tests/game/muzan-parasitism-boundaries.test.ts tests/game/muzan-browser-bundle.test.ts --maxWorkers=1`，5 文件 **39/39 通过**（日志 `dist/RED-216/muzan-final.log`）。包含真实同批多无惨共享宿主、伪造/陈旧/重复选择不污染状态、取消第二步、无落点、位置反应后的阻止与充能重验、确定性重放。
- `npm.cmd run typecheck` 通过。4 个受影响引擎 TS 文件与 5 个角色测试文件执行 `npx.cmd eslint ... --max-warnings 0` 通过，没有修改抑制配置。
- `npm.cmd run check:main-baseline` 通过（behind 0）；`git diff --check` 通过。测试日志位于本地 `dist/RED-216/`，未作为生成噪声提交。

## 人工验证与限制

按以上 10 个场景验收，重点从训练营与联网对局分别触发濒死寄生，在对手回合完成宿主和落点选择，再观察原回合继续。已完成规则与生成引擎验证，尚未进行真人联网体验验收。

已根据用户提供的参考图生成专属头像并接入 `image: muzan.png`，匹配蓝染与乌尔奇奥拉的棕褐纸张、粗线条和块面阴影。`public/muzan.png`、`public/images/muzan.png`、`data/pages/images/muzan.png` 保持相同字节，分别覆盖旧头像路由、资源包命名空间和独立页面。

未重建完整 Windows 安装包或 Android APK，也未更新已安装客户端及远端服务器；验收本角色必须同时使用本分支生成的引擎和资源，不能只把新角色 JSON 放进旧引擎。

## 回退

回退本任务提交并重新生成资源与引擎包，保留 RED-215 依赖候选。未合并、未发布、未部署到服务器。
