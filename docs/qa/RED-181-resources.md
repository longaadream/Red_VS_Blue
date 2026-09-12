# RED-181：共享 PVE 资料与探索资源兼容性

## 2026-09-10 后续：处理剩余 10 项失败

用户在上一轮结果后明确要求继续处理，并询问是否先发布无 PVE 版本。本轮只修复三个测试文件及更新记录，没有修改生产页面、练习控制器、动能词条或卡牌规则，也没有创建/发布 release。下文“另有 10 项失败留存”是修复前历史结果。

修复前同一工作区定向运行三个文件，稳定复现 10 项失败、47 项通过（`release-regression-before.log`）。其中元数据 VM 和移动 VM 都遗漏了页面实际已声明的 `ADVENTURE_MODE`：元数据请求提前进入异常缓存，移动回执渲染抛错；后者又因测试缺少拒绝反馈函数而掩盖原异常。测试补齐默认 false，并记录/断言移动无拒绝反馈，保留连续点格、待选择、无合法移动、非己方回合等原行为断言。元数据本地读取新增练习、冒险两种模式覆盖，保留联网去重、错误缓存、销毁后的回包处理及显示数据不执行代码的检查。

动能用例原先要求旧版长说明的逐字短语，而词条早已简写。本轮按现有简述检查每格 1 点、标记技能获得、使用后通常消耗全部和传送不积累；不回填冗长文案。该文件其他实际动能获取、消费、保留与技能行为测试继续执行。

修复后上述三个文件共 59 项通过（`release-regression-after.log`），包括原来的 57 项和新增的两个模式覆盖。三个文件的 ESLint、全项目 `tsc --noEmit` 及本轮差异检查通过。此轮最终改动风险 Low（测试/文档），独立只读审查通过，未发现掩盖实战缺陷或不当削弱测试。审查另提示可补充高动能继续增长的直接断言，此项为已有覆盖缺口，不影响本轮结论。回退仅恢复这三个测试文件的本轮差异。

更宽回归已完成：`npx.cmd vitest run tests/content-pipeline tests/pve tests/practice tests/game/roster-contract.test.ts tests/game/red-189-roster.test.ts tests/game/battle-card-metadata-runtime.test.ts tests/game/sonic-roster.test.ts tests/electron/client-protocol-resource.test.ts tests/electron/piece-selection-resource-fallback.test.ts --maxWorkers=1`，38 个文件、588 项全部通过，耗时 120.72 秒，见 `release-regression-wide.log`。覆盖完整练习模块、旧/新 PVE 与资源管线；此结果与上面的定向测试有重叠，不累计。未运行整仓全部测试或 release 安装包验证。

发版建议：PVE 目前是同图探索战斗原型，构筑奖励、跨幕、多人/保存等仍待完成；无 PVE release 应独立从经验证的稳定主线整理。单人完整初版粗估 5–10 个开发日，联机、保存和社区配套另需数周，不作为完成日期承诺。本轮 fetch 与 main-baseline 仍因 GitHub 连接失败，未验证新的 release 基线或安装包。

2026-09-10，本地实现验证记录。风险 High；尚未提交 PR、合并或发布，也不代替人工体验验收。

## 授权与边界

用户要求新 PVE 角色/卡牌与 PVP 共用目录，标记为 PVE 专用，PVP 不可选用，并随资源包一起打包；随后要求核实旧节点 PVE 与当前同图探索模式的兼容性。当前合同见 `docs/technical/PVE_ROGUELIKE.md` 首节。保留本次开始前的其他 PVE 修改。

共享内容与打包管线兼容；旧 Flow 读取原节点文档，新探索读取独立的两个严格版本格式。旧读取器验证后跳过这两种已知探索文档，不跳过任意未知格式。未做旧存档转换，未实现通用敌人程序编辑器、完整三幕或社区分发 UI。

## 资源与加载

| 资料 | 源文件 | 当前状态 |
| --- | --- | --- |
| 五种 PVE 敌人 | `data/pieces/pve-*.json` | PVE 专用，ready |
| 四个敌人技能 | `data/skills/pve-*.json` | PVE 专用，ready |
| 六套体系、60 张卡 | `data/cards/pve-*.json` | PVE 专用，draft，无占位执行代码 |
| 地图、地点、战区、敌人配置 | `data/pve/roguelike/adventure.json` | `rvb-pve-roguelike-adventure/v1` |
| 体系、配套棋子、卡牌引用 | `data/pve/roguelike/builds.json` | `rvb-pve-roguelike-builds/v1` |
| 图片 | `public/images/adventure` | 包内为 `images/adventure` |

旧资料缺少 availability 时沿用原有可用性；存在标记时严格验证。draft 不进入任何实战，PVE ready 不进入 PVP。选择页、官方/练习候选、权威对局初始化、卡牌/技能执行和模板召唤均有约束；删除请求模板上的标记不能绕过共享原模板的权威检查。

探索运行时从当前 Profile/VFS 读取 JSON，而非将地图编译固化。完整资源树校验清单、ID、模式、图片、卡牌体系与技能召唤依赖。Patch 允许引用父包，但解析后的内容删除被引用资源会拒绝。

## 自动验证

在仓库根运行，完整输出保存在 `output/pve-roguelike/`。

1. `npx.cmd vitest run tests/content-pipeline tests/pve tests/game/roster-contract.test.ts tests/game/red-189-roster.test.ts tests/electron/client-protocol-resource.test.ts tests/electron/piece-selection-resource-fallback.test.ts tests/practice/session.test.ts --maxWorkers=1`：31 文件、508 项通过，见 `resource-final-tests.log`。包含原节点 PVE 的 snapshot、Flow、battle adapter/service 与新探索测试。
2. 最后浏览器资源白名单与召唤绑定修复后，运行 `tests/pve/roguelike/resources.test.ts`、`tests/pve/roguelike/plans.test.ts`、`tests/pve/prototype-fixtures.test.ts`、`tests/electron/client-protocol-resource.test.ts`：4 文件、44 项通过，见 `resource-last-tests.log`。与上一批有重叠，不累计为独立测试总数。
3. `npx.cmd tsc --noEmit`、`npm.cmd run build:practice-ai`（含 adventure）、最后的 `npm.cmd run build:adventure` 通过；页面/手册脚本语法通过。
4. 收尾类型修正后，七个新增/迁移 TypeScript 文件的定向 ESLint 与 `tsc --noEmit` 通过，资源回归 1 文件、15 项通过；结果分别存于 `resource-lint-final.log`、`resource-types-final.log`、`resource-reference-final.log`。`git diff --check` 通过，只有仓库原有 CRLF 提示。

新增关键场景：PVP 随机种子候选排除专用内容；伪造模板入场拒绝；专用卡与草案执行拒绝；旧包缺少探索配置仍能加载 PVP；两个浏览器配置入口均可预加载且路径穿越拒绝；完整包写入/读取哈希一致；地图数据补丁改变实际读取地块；删除被引用卡牌/召唤模板或写入非法模式标记拒绝；队伍人数与战区数量不再依赖硬编码；召唤食尸鬼数值跟随共享模板。

测试生成 `output/pve-roguelike/resources/base-with-exploration.rvbpack`，走原有 rvb-pack/v1 写入、读取和完整树验证。这是内部 bundled-base 验证产物，包含既有可信技能代码；未作为外部可安装包发布，也未放宽不可信可执行内容策略。

## 实际页面验证

- `http://127.0.0.1:8876/battle.html?mode=adventure`：原生棋盘、猎空队长与乌瑟尔待部署、敌人和图像正常显示；探索行动点为 3。点击结束回合后恢复玩家行动、仍为 3 点，无页面 warn/error。
- 此过程中复现并修复页面报错“GameEngine 资源路径无效: data/pve/roguelike/adventure.json”。原因是主页面 JSON 预加载白名单未包含新配置；改为只新增这两个精确路径，已有 VM 回归。
- `http://127.0.0.1:8875/practice.html`：普通玩家候选与 AI 自动棋组正常，未出现五种 PVE 专用敌人。本轮未在浏览器完成整场 PVP；练习会话由自动测试覆盖。
- 讨论手册从共享 JSON 重新生成，保留六套体系、每套十张卡与原有美术、笔记存储键，不激活草案卡的游戏效果。实际刷新原浏览器页后显示十张卡，图像正常；导出弹窗中的 Markdown 实际含 60 条卡牌记录，无物理/魔法伤害旧分类，关闭正常，warn/error 为空。未修改用户笔记或标记。

## 审查与已知限制

按 AGENTS.md 完成独立只读 AI 审查。已修复审查发现的队伍核心数硬编码、战区顺序硬编码、技能可用模式遗漏、共享召唤模板数值及其引用闭包遗漏。最后新增浏览器白名单回归并复核；审查者确认本任务范围内未发现尚存的兼容性或 PVP 隔离阻断问题，未重复运行测试。

较宽回归 `resource-regression.log` 曾报告 585 项中 11 项失败。其中本次新增两个探索 JSON 引起旧固定目录清单不匹配，已按新的文件合同更新并通过。另有 10 项失败留存：卡牌元数据页面 VM 5 项、练习移动 VM 缺少 rejectPendingActionFeedback 4 项、动能说明旧文案断言 1 项。这些对应本次未改动的页面集成/测试片段或词条，不在本次资源迁移中修复；不能据此声称整个工作区测试全部通过。

fresh fetch 多次因 GitHub 连接重置/不可达失败。当前 HEAD 为 `12a0937c3f39ca43e5cbb2f1d9a6f1e8c11ac441`，最后已知 origin/main 为 `895834297e3e49ebbf10b12074c08979931b6e01`（落后 2 个提交）；没有把旧基线结果当作最新主线候选验证。保留既有外部写入限制，合同与证据只保存在本地。

## 人工复核与回退

打开讨论手册查看六套卡牌；进入冒险检查探索回合、敌情和召唤；进入 PVP 练习确认没有 PVE 专用角色可选。完整旧存档迁移与旧客户端识别新资源包不属于承诺范围。

回退只撤销本次共享资源、可用性拦截、探索加载和打包校验改动，保留之前的 PVE/UI 工作；没有新增存档转换或外部发布需要回退。
