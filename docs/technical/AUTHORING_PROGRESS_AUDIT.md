# 初始技能作者进度逐项审计

统计日期：2026-10-12。基线：`origin/main`，完整SHA：`082166c6b803b2e838bce5f0f6824c5bbc714dd6`。范围为45个非PVE棋子的140个去重初始Skill定义；审计作者规范讨论和草案，不审计生产模块迁移率。

| 分类 | 个数 | 占140项 | 含义 |
| --- | --- | --- | --- |
| A：完整主体草案 | 140 | 100.0% | 已有端到端的作者主体及相关Rule代码；并非规范冻结、全部接口无缺口或运行验收通过 |
| B：部分／历史讨论 | 0 | 0.0% | 有讨论、片段或未完草案，需补完整新格式正文／接口 |
| C：尚未涉及本轮作者规范 | 0 | 0.0% | 当前作者文档中没有对应逐技能正文 |

合计140项。已涉及140项（100%）；尚无完整主体0项（B+C）。A中的格式/接口细化问题逐项记录，不能把140报告成140个无阻塞可实施技能。

核验：按skillId去重，共享征讨号令和圣光盾均计一次；排除pve-*棋子与其技能。逐项映射证据文件，检查每项唯一分类、无遗漏、来源文件存在。基线JSON和作者正文只读；未运行游戏测试。

本次更新：[批次01](AUTHORING_BATCH_01.md)核验11个初始技能及1个派生技能，新增8份完整主体；麦克斯3项保持部分。派生蝙蝠增援不增加初始技能分母。

最新追加：[批次02](AUTHORING_BATCH_02.md)核验10个初始技能，经前事件字段权限确认后为6份完整主体和4项部分草案；内部暗影步传送不增加分母。

最新追加：[批次03](AUTHORING_BATCH_03.md)核验10个初始技能，新增2份完整主体和8项部分草案；共享依赖分组登记。批次02流星腰带也已补齐主体。

最新追加：[批次04](AUTHORING_BATCH_04.md)核验9个初始技能，新增4份完整主体和5项部分草案；飞段共同目标语义与濒死差异不擅自定稿。

最新追加：[批次05](AUTHORING_BATCH_05.md)核验最后11个尚未涉及的初始技能，经整数分半、显示模板、手牌复制与顶上化佛范围确认后为11份完整主体。初始技能均已有审计记录；初始主体已补齐，后续集中核查公共接口和实施缺口。

最新追加：[批次06](AUTHORING_BATCH_06.md)补齐九项历史草案；飞雷神被动也补齐。本轮新增10项完整主体，该次更新后为A91/B49/C0。

最新追加：[莉亚德琳两项](LIADRIN_LIGHT_AND_ECHO_AUTHORING_DRAFT.md)补齐圣光汲取和血色回响，该次更新后为A93/B47/C0。飞段仅修正职责，不虚增完成计数。

最新追加：[圣盾与圣骑士五项](PALADIN_SHIELD_AUTHORING_DRAFT.md)补齐共享规则及五个初始Skill，该次更新后为A98/B42/C0。

最新追加：[飞段血誓与献祭](HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md)按全部匹配目标补齐两项，该次更新后为A100/B40/C0；不死神体的消灭击杀归属随后已确认。

最新追加：不死神体归属确认后补齐；[圣光范围技能](HOLY_AREA_SKILLS_AUTHORING_DRAFT.md)补齐圣光降临、穆鲁的挽歌。该次更新后为A103/B37/C0。

最新追加：[共生拖行](VENOM_DRAG_AUTHORING_DRAFT.md)沿用户确认通行参数补齐，该次更新后为A104/B36/C0。

最新追加：[宿主转移](VENOM_HOST_TRANSFER_AUTHORING_DRAFT.md)按传送层占用约束补齐，该次更新后为A105/B35/C0。

最新追加：初始化声明区确认后，[铁甲坦克与飞身肘击](AUTHORING_BATCH_02.md)主体补齐，该次更新后为A107/B33/C0。

最新追加：[全速出击](MAX_AUTHORING_DRAFT.md)按普通移动提交时消费迅捷补齐，该次更新后为A108/B32/C0。

最新追加：[相位偏移器](MAX_PHASE_AUTHORING_DRAFT.md)按默认冷却先提交确认补齐，该次更新后为A109/B31/C0。

最新追加：[速射能量炮](MAX_SPEED_SHOT_AUTHORING_DRAFT.md)保留冷却1及全局回合重置，该次更新后为A110/B30/C0。

最新追加：大远征逐项成功圣盾与恶魔变形Cluster次数主体补齐，该次更新后为A112/B28/C0。

最新追加：[暴风雪](BLIZZARD_AUTHORING_DRAFT.md)独立冰冻确认后补齐，该次更新后为A113/B27/C0。

最新追加：[暗影步](SHADOW_STEP_AUTHORING_DRAFT.md)补齐，该次更新后为A114/B26/C0。

最新追加：[共享动能与索尼克两项主动](SONIC_MOMENTUM_AUTHORING_DRAFT.md)补齐，该次更新后为A116/B24/C0。

最新追加：实际碰撞接口确认后补齐[两种冲刺](COLLISION_DASH_AUTHORING_DRAFT.md)及[音速](SONIC_FREE_MOVE_AUTHORING_DRAFT.md)，该次更新后为A119/B21/C0。

最新追加：满手转弃牌确认，[护甲组装](TAILS_ARMOR_AUTHORING_DRAFT.md)转A；该次更新后为A120/B20/C0。

最新追加：状态选择确认，[机械支援](TAILS_MECHANICAL_SUPPORT_AUTHORING_DRAFT.md)转A；该次更新后为A121/B19/C0。

最新追加：[骑射横扫](SHADOW_RIDE_SWEEP_AUTHORING_DRAFT.md)复用相对坐标与地格选择补齐，该次更新后A122/B18/C0。

最新追加：状态移除后只读快照已确认；[双尾飞行](TAILS_TWIN_FLIGHT_AUTHORING_DRAFT.md)与[寒冰坚忍](ARTHAS_ICEBOUND_AUTHORING_DRAFT.md)补齐完整主体，该次更新后A124/B16/C0。[霜之哀伤](ARTHAS_FROSTMOURNE_AUTHORING_DRAFT.md)保留召唤物额外奖励待定项，仍为B。仅作者规范，未实施运行引擎。

## 按棋子查看

以下按棋子列技能引用数；共享技能重复出现在棋子行，不能把此表的列合计当作140。

| 棋子 | 完整主体A | 部分B | 未涉及C |
| --- | --- | --- | --- |
| 阿方 | 3 | 0 | 0 |
| 安娜 | 3 | 0 | 0 |
| 安度因 | 3 | 0 | 0 |
| 阿尔萨斯 | 3 | 0 | 0 |
| 黑崎一护 | 3 | 0 | 0 |
| 绯村剑心 | 4 | 0 | 0 |
| 波风水门 | 4 | 0 | 0 |
| 漩涡鸣人 | 4 | 0 | 0 |
| 提里奥弗丁 | 3 | 0 | 0 |
| 观者 | 2 | 0 | 0 |
| 柯尔特 | 4 | 0 | 0 |
| 蓝染 | 3 | 0 | 0 |
| 猗窝座 | 4 | 0 | 0 |
| 格里姆乔 | 3 | 0 | 0 |
| 鬼舞辻无惨 | 4 | 0 | 0 |
| 乌尔奇奥拉 | 3 | 0 | 0 |
| 艾德加 | 2 | 0 | 0 |
| 艾尔·普里莫 | 4 | 0 | 0 |
| 古尔丹 | 3 | 0 | 0 |
| 秽土转生·千手柱间 | 4 | 0 | 0 |
| 吉安娜 | 3 | 0 | 0 |
| 基尔加丹 | 3 | 0 | 0 |
| 莉亚德琳 | 3 | 0 | 0 |
| 麦克斯 | 3 | 0 | 0 |
| 莫提斯 | 2 | 0 | 0 |
| 死神 | 4 | 0 | 0 |
| 黑百合 | 3 | 0 | 0 |
| 末日铁拳 | 2 | 0 | 0 |
| 飞段 | 3 | 0 | 0 |
| 伊利丹怒风 | 3 | 0 | 0 |
| 宇智波鼬 | 3 | 0 | 0 |
| 宇智波带土 | 2 | 0 | 0 |
| 拉法姆 | 3 | 0 | 0 |
| 宇智波佐助 | 3 | 0 | 0 |
| 志志雄真实 | 3 | 0 | 0 |
| 毒液 | 3 | 0 | 0 |
| 夏特 | 3 | 0 | 0 |
| 雪莉 | 4 | 0 | 0 |
| 索尼克 | 4 | 0 | 0 |
| 塔尔斯 | 3 | 0 | 0 |
| 猎空 | 3 | 0 | 0 |
| 图拉扬 | 3 | 0 | 0 |
| 泰兰德 | 3 | 0 | 0 |
| 乌瑟尔 | 3 | 0 | 0 |
| 维伦 | 4 | 0 | 0 |

## 140个初始Skill逐项清单

| Skill ID | 名称 | 初始持有棋子 | 状态 | 作者证据 | 后续说明 |
| --- | --- | --- | --- | --- | --- |
| `aizen-black-coffin` | 黑棺 | 蓝染 | A：完整主体草案 | [AIZEN_BLACK_COFFIN_AUTHORING_DRAFT.md](AIZEN_BLACK_COFFIN_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `aizen-kyoka-suiguetsu` | 镜花水月 | 蓝染 | A：完整主体草案 | [AIZEN_KYOKA_AUTHORING_DRAFT.md](AIZEN_KYOKA_AUTHORING_DRAFT.md) | 秘密选择、实例记录、可取消改写及到期清理完整正文已补；待运行验证 |
| `aizen-shunpo` | 瞬步 | 蓝染 | A：完整主体草案 | [AIZEN_SHUNPO_AUTHORING_DRAFT.md](AIZEN_SHUNPO_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `akaza-annihilation` | 破坏杀·灭式 | 猗窝座 | A：完整主体草案 | [AKAZA_ANNIHILATION_AUTHORING_DRAFT.md](AKAZA_ANNIHILATION_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `akaza-disorder` | 破坏杀·乱式 | 猗窝座 | A：完整主体草案 | [AKAZA_DAMAGE_HISTORY_AUTHORING_DRAFT.md](AKAZA_DAMAGE_HISTORY_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `akaza-fighting-spirit` | 先手斗气 | 猗窝座 | A：完整主体草案 | [AKAZA_FIGHTING_SPIRIT_AUTHORING_DRAFT.md](AKAZA_FIGHTING_SPIRIT_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `akaza-flash-step` | 瞬步 | 猗窝座 | A：完整主体草案 | [AKAZA_DAMAGE_HISTORY_AUTHORING_DRAFT.md](AKAZA_DAMAGE_HISTORY_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `alfonso-freeze` | 威震八方 | 阿方 | A：完整主体草案 | [ALFONSO_SIMPLE_AUTHORING_DRAFT.md](ALFONSO_SIMPLE_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `alfonso-kick` | 龙骧虎步 | 阿方 | A：完整主体草案 | [ALFONSO_SIMPLE_AUTHORING_DRAFT.md](ALFONSO_SIMPLE_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `alfonso-water-dash` | 惊鸿掠水 | 阿方 | A：完整主体草案 | [ALFONSO_WATER_DASH_AUTHORING_DRAFT.md](ALFONSO_WATER_DASH_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `arthas-frostmourne` | 霜之哀伤 | 阿尔萨斯 | A：完整主体草案 | [ARTHAS_FROSTMOURNE_AUTHORING_DRAFT.md](ARTHAS_FROSTMOURNE_AUTHORING_DRAFT.md) | 击杀召唤物额外1充能已确认，完整主体已补；待运行验证 |
| `arthas-icebound-fortitude` | 寒冰坚忍 | 阿尔萨斯 | A：完整主体草案 | [ARTHAS_ICEBOUND_AUTHORING_DRAFT.md](ARTHAS_ICEBOUND_AUTHORING_DRAFT.md) | 重复激活拒绝、减伤和实际棋子来源反冻完整主体已补；待运行验证 |
| `arthas-lich-covenant` | 巫妖誓约 | 阿尔萨斯 | A：完整主体草案 | [ARTHAS_LICH_COVENANT_AUTHORING_DRAFT.md](ARTHAS_LICH_COVENANT_AUTHORING_DRAFT.md) | 初始定义恢复、历史次数继承及死亡后召唤完整主体已补；待运行验证 |
| `ashbringer` | 灰烬使者 | 提里奥弗丁 | A：完整主体草案 | [PALADIN_SHIELD_AUTHORING_DRAFT.md](PALADIN_SHIELD_AUTHORING_DRAFT.md) | 五项及共享圣盾/强化Rule主体已补；保留整份状态消费，待运行验证 |
| `biotic-grenade` | 生物手雷 | 安娜 | A：完整主体草案 | [ANA_BIOTIC_GRENADE_AUTHORING_DRAFT.md](ANA_BIOTIC_GRENADE_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `blackwidow-deadly-gaze` | 致命视线 | 黑百合 | A：完整主体草案 | [BLACKWIDOW_RANGED_AUTHORING_DRAFT.md](BLACKWIDOW_RANGED_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `blackwidow-lethal-strike` | 致命打击 | 黑百合 | A：完整主体草案 | [BLACKWIDOW_RANGED_AUTHORING_DRAFT.md](BLACKWIDOW_RANGED_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `blackwidow-lethal-toxin` | 致命毒素 | 黑百合 | A：完整主体草案 | [BLACKWIDOW_TOXIN_AUTHORING_DRAFT.md](BLACKWIDOW_TOXIN_AUTHORING_DRAFT.md) | 主体已写；旧玩家状态展示、安装标记与最新Rule去重文字需统一，重入消费需验证 |
| `blessed-hammer` | 祝福之锤 | 乌瑟尔 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `blink` | 闪现 | 猎空 | A：完整主体草案 | [TRACER_SIMPLE_AUTHORING_DRAFT.md](TRACER_SIMPLE_AUTHORING_DRAFT.md) | 完整主体已有；类型/来源命名、种子随机输入与被动结构需统一 |
| `blizzard` | 暴风雪 | 吉安娜 | A：完整主体草案 | [BLIZZARD_AUTHORING_DRAFT.md](BLIZZARD_AUTHORING_DRAFT.md) | 玩家延迟任务、快照及独立冰冻完整主体已补；待运行验证 |
| `blood-echo` | 血色回响 | 莉亚德琳 | A：完整主体草案 | [LIADRIN_LIGHT_AND_ECHO_AUTHORING_DRAFT.md](LIADRIN_LIGHT_AND_ECHO_AUTHORING_DRAFT.md) | 具体圣盾移除/正常事件/来源玩家发牌正文已补；运行与满手待验证 |
| `colt-big-stride` | 大步流星 | 柯尔特 | A：完整主体草案 | [COLT_AUTHORING_DRAFT.md](COLT_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `colt-bullet-storm` | 子弹风暴 | 柯尔特 | A：完整主体草案 | [COLT_SHOOTING_ZONES_AUTHORING_DRAFT.md](COLT_SHOOTING_ZONES_AUTHORING_DRAFT.md) | 共享棋子级离场清理已确认；反应中换模式/离场/重入及区域投影需验证 |
| `colt-piercing` | 穿甲银弹 | 柯尔特 | A：完整主体草案 | [COLT_PIERCING_AUTHORING_DRAFT.md](COLT_PIERCING_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `colt-revolver` | 左轮手枪 | 柯尔特 | A：完整主体草案 | [COLT_SHOOTING_ZONES_AUTHORING_DRAFT.md](COLT_SHOOTING_ZONES_AUTHORING_DRAFT.md) | 共享棋子级离场清理已确认；反应中换模式/离场/重入及区域投影需验证 |
| `death-blossom` | 死亡绽放 | 死神 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 批次02主体已补；阶段实现与表现/运行验证待后续 |
| `divine-blessing` | 赐福 | 乌瑟尔 | A：完整主体草案 | [PALADIN_SHIELD_AUTHORING_DRAFT.md](PALADIN_SHIELD_AUTHORING_DRAFT.md) | 五项及共享圣盾/强化Rule主体已补；保留整份状态消费，待运行验证 |
| `earthshatter` | 毁天灭地 | 末日铁拳 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 批次02主体已补；阶段实现与表现/运行验证待后续 |
| `edgar-fisticuffs` | 近身搏击 | 艾德加 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 批次01完整主体；公共接口细化和运行验证尚未完成 |
| `edgar-pogo-jump` | 撑“杆”跳跃 | 艾德加 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 批次01完整主体；公共接口细化和运行验证尚未完成 |
| `el-primo-elbow` | 飞身肘击 | 艾尔·普里莫 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 初始化声明区及获得时Rule部署已补；共用玩家减免，待运行验证 |
| `el-primo-meteor-belt` | 流星腰带 | 艾尔·普里莫 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 完整主体已补；事件/字段映射、生命周期和运行验证待实施 |
| `el-primo-punch` | 愤怒铁拳 | 艾尔·普里莫 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 批次02主体已补；阶段实现与表现/运行验证待后续 |
| `elune-blessing` | 月神赐福 | 泰兰德 | A：完整主体草案 | [ELUNE_GUIDANCE_BLESSING_AUTHORING_DRAFT.md](ELUNE_GUIDANCE_BLESSING_AUTHORING_DRAFT.md) | 独立Rule、状态查询与完整主体已补；待运行验证 |
| `elune-guidance` | 艾露恩的指引 | 泰兰德 | A：完整主体草案 | [ELUNE_GUIDANCE_BLESSING_AUTHORING_DRAFT.md](ELUNE_GUIDANCE_BLESSING_AUTHORING_DRAFT.md) | 独立Rule、状态查询与完整主体已补；待运行验证 |
| `elune-protection` | 艾露恩的守护 | 泰兰德 | A：完整主体草案 | [ELUNE_PROTECTION_AUTHORING_DRAFT.md](ELUNE_PROTECTION_AUTHORING_DRAFT.md) | 独立Rule、状态查询与完整主体已补；待运行验证 |
| `fel-blessing` | 邪能赐福 | 古尔丹 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `fireball` | 火球术 | 吉安娜 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `frostbolt` | 冰霜箭 | 吉安娜 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `grimmjow-destruction-instinct` | 破坏本能 | 格里姆乔 | A：完整主体草案 | [GRIMMJOW_DESTRUCTION_AUTHORING_DRAFT.md](GRIMMJOW_DESTRUCTION_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `grimmjow-hunting-instinct` | 狩猎本能 | 格里姆乔 | A：完整主体草案 | [GRIMMJOW_HUNTING_AUTHORING_DRAFT.md](GRIMMJOW_HUNTING_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `grimmjow-resurreccion` | 归刃·豹王 | 格里姆乔 | A：完整主体草案 | [GRIMMJOW_RESURRECCION_AUTHORING_DRAFT.md](GRIMMJOW_RESURRECCION_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `hashirama-edo-regen` | 秽土转生·自愈 | 秽土转生·千手柱间 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 主体已补；新规范差异和运行表现待验证 |
| `hashirama-edo-sage-buddha` | 仙术·顶上化佛 | 秽土转生·千手柱间 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 默认最小距离1、传送/清冷却/逐牌绑定主体齐备；派生牌死亡绑定可用、范围依赖按实际输入判断已确认，满手与运行准备流程待验证 |
| `hashirama-edo-wood-dragon` | 木遁·木龙之术 | 秽土转生·千手柱间 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 整数分半已按用户约定处理，受伤前快照与同量增减主体已补；待运行验证 |
| `hashirama-edo-wood-spike` | 木遁·扦插之术 | 秽土转生·千手柱间 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 主体已补；新规范差异和运行表现待验证 |
| `hellfire-shotgun` | 地狱火霰弹枪 | 死神 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 批次02主体已补；阶段实现与表现/运行验证待后续 |
| `hidan-blood-oath` | 血誓仪式 | 飞段 | A：完整主体草案 | [HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md](HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md) | 全部匹配目标各一份伤害；献祭自伤后重查，待运行验证 |
| `hidan-sacrifice` | 狂信者献祭 | 飞段 | A：完整主体草案 | [HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md](HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md) | 全部匹配目标各一份伤害；献祭自伤后重查，待运行验证 |
| `hidan-undying` | 不死神体 | 飞段 | A：完整主体草案 | [HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md](HIDAN_BLOOD_OATH_AUTHORING_DRAFT.md) | 主体已补；按最新消灭/基线数值/实例规范，待运行验证 |
| `holy-light-descend` | 圣光降临 | 安度因 | A：完整主体草案 | [HOLY_AREA_SKILLS_AUTHORING_DRAFT.md](HOLY_AREA_SKILLS_AUTHORING_DRAFT.md) | 主体已补；按最新消灭/基线数值/实例规范，待运行验证 |
| `ichigo-bankai-tensa-zangetsu` | 卍解·天锁斩月 | 黑崎一护 | A：完整主体草案 | [ICHIGO_BANKAI_AUTHORING_DRAFT.md](ICHIGO_BANKAI_AUTHORING_DRAFT.md) | 完整主体已有；失败返回格式、获得Cluster返回及正在执行入口卸载需统一，不能当作已定稿 |
| `ichigo-getsuga-tensho` | 月牙天冲 | 黑崎一护 | A：完整主体草案 | [ICHIGO_GETSUGA_AUTHORING_DRAFT.md](ICHIGO_GETSUGA_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `ichigo-zangetsu` | 斩月 | 黑崎一护 | A：完整主体草案 | [ICHIGO_ZANGETSU_AUTHORING_DRAFT.md](ICHIGO_ZANGETSU_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `illidan-blade-dash` | 战刃挥刺 | 伊利丹怒风 | A：完整主体草案 | [ILLIDAN_BLADE_DASH_AUTHORING_DRAFT.md](ILLIDAN_BLADE_DASH_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `illidan-eye-beam` | 眼棱 | 伊利丹怒风 | A：完整主体草案 | [ILLIDAN_EYE_BEAM_AUTHORING_DRAFT.md](ILLIDAN_EYE_BEAM_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `illidan-metamorphosis` | 恶魔变形 | 伊利丹怒风 | A：完整主体草案 | [ILLIDAN_METAMORPHOSIS_AUTHORING_DRAFT.md](ILLIDAN_METAMORPHOSIS_AUTHORING_DRAFT.md) | 逐项成功圣盾/Cluster次数刷新完整主体已补；待运行验证 |
| `itachi-amaterasu` | 天照之缚 | 宇智波鼬 | A：完整主体草案 | [AUTHORING_BATCH_04.md](AUTHORING_BATCH_04.md) | 主体已补；共享调度、实例与表现适配待运行验证 |
| `itachi-totsuka-blade` | 须佐能乎·十拳剑 | 宇智波鼬 | A：完整主体草案 | [AUTHORING_BATCH_04.md](AUTHORING_BATCH_04.md) | 主体已补；共享调度、实例与表现适配待运行验证 |
| `itachi-tsukuyomi` | 月读 | 宇智波鼬 | A：完整主体草案 | [AUTHORING_BATCH_04.md](AUTHORING_BATCH_04.md) | 主体已补；共享调度、实例与表现适配待运行验证 |
| `kenshin-amakakeru` | 天翔龙闪 | 绯村剑心 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 原地落点已确认，主体已补；准备阶段及运行验证待实施 |
| `kenshin-ryusosen` | 龙巢闪 | 绯村剑心 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 批次01完整主体；公共接口细化和运行验证尚未完成 |
| `kenshin-ryutsuisen` | 龙槌闪 | 绯村剑心 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 原地落点已确认，主体已补；准备阶段及运行验证待实施 |
| `kenshin-tenken-passive` | 飞天御剑流·剑速 | 绯村剑心 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 批次01完整主体；公共接口细化和运行验证尚未完成 |
| `kiljaedan-demonic-pact` | 恶魔仪式 | 基尔加丹 | A：完整主体草案 | [DEMONIC_RITUAL_AUTHORING_DRAFT.md](DEMONIC_RITUAL_AUTHORING_DRAFT.md) | 绑定原实例与满血入场初始化已确认，五牌链完整主体已补；待运行验证 |
| `kiljaedan-fel-fire` | 恒星之火 | 基尔加丹 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `kiljaedan-soul-drain` | 灵魂汲取 | 基尔加丹 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `light-extraction` | 圣光汲取 | 莉亚德琳 | A：完整主体草案 | [LIADRIN_LIGHT_AND_ECHO_AUTHORING_DRAFT.md](LIADRIN_LIGHT_AND_ECHO_AUTHORING_DRAFT.md) | 具体圣盾移除/正常事件/来源玩家发牌正文已补；运行与满手待验证 |
| `light-of-the-light` | 圣光闪耀 | 安度因 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `max-full-speed` | 全速出击 | 麦克斯 | A：完整主体草案 | [MAX_AUTHORING_DRAFT.md](MAX_AUTHORING_DRAFT.md) | 普通移动提交时消费迅捷已确认，费用/清理主体完整；待运行验证 |
| `max-phase-shifter` | 相位偏移器 | 麦克斯 | A：完整主体草案 | [MAX_PHASE_AUTHORING_DRAFT.md](MAX_PHASE_AUTHORING_DRAFT.md) | 默认冷却先提交与实际字段覆盖已确认，复放完整主体；待运行验证 |
| `max-speed-shot` | 速射能量炮 | 麦克斯 | A：完整主体草案 | [MAX_SPEED_SHOT_AUTHORING_DRAFT.md](MAX_SPEED_SHOT_AUTHORING_DRAFT.md) | 保留冷却1；下一全局回合实例Rule重置已确认，待运行验证 |
| `minato-flying-raijin-passive` | 飞雷神 | 波风水门 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 锚点与逐目标突袭Rule已补；事件元数据、挂起复核与运行待验证 |
| `minato-kunai-formula` | 苦无术式 | 波风水门 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 主体已补；新规范差异和运行表现待验证 |
| `minato-rasengan` | 螺旋丸 | 波风水门 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 主体已补；新规范差异和运行表现待验证 |
| `minato-spiral-barrage` | 螺旋连丸 | 波风水门 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 准备拒绝/效果后成功结束/击杀奖励取消与创建者锚点维护齐备；运行待验证 |
| `mortis-night-construct` | 暗夜造物 | 莫提斯 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 阈值与二态资格已确认，完整主体已补；资格/显示/成员绑定待运行落实 |
| `mortis-shovel-charge` | 铁铲突击 | 莫提斯 | A：完整主体草案 | [AUTHORING_BATCH_01.md](AUTHORING_BATCH_01.md) | 批次01完整主体；公共接口细化和运行验证尚未完成 |
| `muru-lament` | 穆鲁的挽歌 | 莉亚德琳 | A：完整主体草案 | [HOLY_AREA_SKILLS_AUTHORING_DRAFT.md](HOLY_AREA_SKILLS_AUTHORING_DRAFT.md) | 主体已补；按最新消灭/基线数值/实例规范，待运行验证 |
| `muzan-blood-whip` | 血之鞭击 | 鬼舞辻无惨 | A：完整主体草案 | [MUZAN_BLOOD_WHIP_AUTHORING_DRAFT.md](MUZAN_BLOOD_WHIP_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `muzan-demon-body` | 无惨之躯 | 鬼舞辻无惨 | A：完整主体草案 | [MUZAN_DEMON_BODY_AUTHORING_DRAFT.md](MUZAN_DEMON_BODY_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `muzan-flesh-regeneration` | 血肉再生 | 鬼舞辻无惨 | A：完整主体草案 | [MUZAN_REGENERATION_AUTHORING_DRAFT.md](MUZAN_REGENERATION_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `muzan-parasitism` | 寄生 | 鬼舞辻无惨 | A：完整主体草案 | [MUZAN_PARASITISM_AUTHORING_DRAFT.md](MUZAN_PARASITISM_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `nano-boost` | 纳米激素 | 安娜 | A：完整主体草案 | [ANA_NANO_BOOST_AUTHORING_DRAFT.md](ANA_NANO_BOOST_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `naruto-rasengan` | 螺旋手里剑 | 漩涡鸣人 | A：完整主体草案 | [NARUTO_RASENGAN_VANGUARD_AUTHORING_DRAFT.md](NARUTO_RASENGAN_VANGUARD_AUTHORING_DRAFT.md) | 普通伤害后独立沉默完整主体已补；待运行验证 |
| `naruto-sage-mode` | 仙人模式 | 漩涡鸣人 | A：完整主体草案 | [NARUTO_CLONE_SAGE_AUTHORING_DRAFT.md](NARUTO_CLONE_SAGE_AUTHORING_DRAFT.md) | 模板/逐字段伪装与独立打坐Rule完整正文已补；依赖和投影待运行验证 |
| `naruto-shadow-clone` | 影分身之术 | 漩涡鸣人 | A：完整主体草案 | [NARUTO_CLONE_SAGE_AUTHORING_DRAFT.md](NARUTO_CLONE_SAGE_AUTHORING_DRAFT.md) | 模板/逐字段伪装与独立打坐Rule完整正文已补；依赖和投影待运行验证 |
| `naruto-vanguard` | 率先出阵 | 漩涡鸣人 | A：完整主体草案 | [NARUTO_RASENGAN_VANGUARD_AUTHORING_DRAFT.md](NARUTO_RASENGAN_VANGUARD_AUTHORING_DRAFT.md) | 游戏开始时插入第1位完整主体已补；部署调度待运行验证 |
| `obito-ally-teleport` | 神威·转移 | 宇智波带土 | A：完整主体草案 | [OBITO_TRANSFER_AUTHORING_DRAFT.md](OBITO_TRANSFER_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `obito-space-time` | 神威 | 宇智波带土 | A：完整主体草案 | [OBITO_KAMUI_AUTHORING_DRAFT.md](OBITO_KAMUI_AUTHORING_DRAFT.md) | 主体及玩家常驻万花筒Rule已写；通用出局完整签名/生命周期仍需细化 |
| `passive-injury-charge-discount` | 铁甲坦克 | 艾尔·普里莫 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 初始化声明区及获得时Rule部署已补；共用玩家减免，待运行验证 |
| `pulse-pistol` | 脉冲手枪 | 猎空 | A：完整主体草案 | [TRACER_SIMPLE_AUTHORING_DRAFT.md](TRACER_SIMPLE_AUTHORING_DRAFT.md) | 完整主体已有；类型/来源命名、种子随机输入与被动结构需统一 |
| `rafaam-curse-amplify` | 诅咒增幅 | 拉法姆 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 无牌正常成功；按原列表复制当前手牌内容；复制生命周期与满手待运行验证 |
| `rafaam-curse-ward` | 诅咒结界 | 拉法姆 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 创建、持有Rule、玩家伤害及字符串显示模板已补；运行与满手边界待验证 |
| `rafaam-temporal-distortion` | 时空扭曲 | 拉法姆 | A：完整主体草案 | [AUTHORING_BATCH_05.md](AUTHORING_BATCH_05.md) | 主体已补；新规范差异和运行表现待验证 |
| `reap` | 收割 | 死神 | A：完整主体草案 | [AUTHORING_BATCH_02.md](AUTHORING_BATCH_02.md) | 批次02主体已补；阶段实现与表现/运行验证待后续 |
| `recall` | 回溯 | 猎空 | A：完整主体草案 | [RECALL_AUTHORING_DRAFT.md](RECALL_AUTHORING_DRAFT.md) | 独立副本、事件计数和到期恢复完整正文已补；待运行验证 |
| `rocket-punch` | 火箭重拳 | 末日铁拳 | A：完整主体草案 | [COLLISION_DASH_AUTHORING_DRAFT.md](COLLISION_DASH_AUTHORING_DRAFT.md) | 完整作者主体与公共依赖已补；待运行实现与验证 |
| `sasuke-amaterasu` | 天照之炎 | 宇智波佐助 | A：完整主体草案 | [SASUKE_AMATERASU_RULES_AUTHORING_DRAFT.md](SASUKE_AMATERASU_RULES_AUTHORING_DRAFT.md) | 主体及三个Rule已写；全局/玩家安装登记、多来源调度及表现需核对 |
| `sasuke-chidori` | 千鸟 | 宇智波佐助 | A：完整主体草案 | [SASUKE_CHIDORI_AUTHORING_DRAFT.md](SASUKE_CHIDORI_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `sasuke-susanoo` | 须佐能乎 | 宇智波佐助 | A：完整主体草案 | [SASUKE_SUSANOO_AUTHORING_DRAFT.md](SASUKE_SUSANOO_AUTHORING_DRAFT.md) | 完整主体已有；重复获得Cluster策略、返回及次数刷新需统一，不能当作已定稿 |
| `shadow-bolt` | 暗影箭 | 古尔丹 | A：完整主体草案 | [SHADOW_BOLT_AUTHORING_DRAFT.md](SHADOW_BOLT_AUTHORING_DRAFT.md) | 方向/元组同时伤害主体已有；页首旧接口待确认描述和费用限制仍须对齐 |
| `shadow-chaos-control` | 混沌控制 | 夏特 | A：完整主体草案 | [AUTHORING_BATCH_03.md](AUTHORING_BATCH_03.md) | 完整主体已补；事件/字段映射、生命周期和运行验证待实施 |
| `shadow-chaos-spear` | 混沌之矛 | 夏特 | A：完整主体草案 | [AUTHORING_BATCH_03.md](AUTHORING_BATCH_03.md) | 完整主体已补；事件/字段映射、生命周期和运行验证待实施 |
| `shadow-ride-sweep` | 骑射横扫 | 夏特 | A：完整主体草案 | [SHADOW_RIDE_SWEEP_AUTHORING_DRAFT.md](SHADOW_RIDE_SWEEP_AUTHORING_DRAFT.md) | 路径先伤害、实际冲刺、可选侧射正文已补；待运行验证 |
| `shadow-step` | 暗影步 | 死神 | A：完整主体草案 | [SHADOW_STEP_AUTHORING_DRAFT.md](SHADOW_STEP_AUTHORING_DRAFT.md) | 状态正值刷新、标记替换与单次结算/清理已补；待运行验证 |
| `shelly-bandage` | 止血绷带 | 雪莉 | A：完整主体草案 | [SHELLY_AUTHORING_DRAFT.md](SHELLY_AUTHORING_DRAFT.md) | 正常治疗及统一遇阻规则已确认；逐段/资源/显示待运行验证 |
| `shelly-dash` | 冲刺跑鞋 | 雪莉 | A：完整主体草案 | [SHELLY_AUTHORING_DRAFT.md](SHELLY_AUTHORING_DRAFT.md) | 正常治疗及统一遇阻规则已确认；逐段/资源/显示待运行验证 |
| `shelly-shotgun` | 大口径霰弹枪 | 雪莉 | A：完整主体草案 | [SHELLY_AUTHORING_DRAFT.md](SHELLY_AUTHORING_DRAFT.md) | 正常治疗及统一遇阻规则已确认；逐段/资源/显示待运行验证 |
| `shelly-super-shell` | 超级霰弹 | 雪莉 | A：完整主体草案 | [SHELLY_AUTHORING_DRAFT.md](SHELLY_AUTHORING_DRAFT.md) | 正常治疗及统一遇阻规则已确认；逐段/资源/显示待运行验证 |
| `shield-of-light` | 圣光盾 | 安度因、乌瑟尔 | A：完整主体草案 | [PALADIN_SHIELD_AUTHORING_DRAFT.md](PALADIN_SHIELD_AUTHORING_DRAFT.md) | 五项及共享圣盾/强化Rule主体已补；保留整份状态消费，待运行验证 |
| `shishio-combustion-passive` | 自燃 | 志志雄真实 | A：完整主体草案 | [SHISHIO_COMBUSTION_AUTHORING_DRAFT.md](SHISHIO_COMBUSTION_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `shishio-flame-spirit` | 我流·炎灵 | 志志雄真实 | A：完整主体草案 | [SHISHIO_FLAME_SPIRIT_AUTHORING_DRAFT.md](SHISHIO_FLAME_SPIRIT_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `shishio-infinite-blade` | 无限刃 | 志志雄真实 | A：完整主体草案 | [SHISHIO_INFINITE_BLADE_AUTHORING_DRAFT.md](SHISHIO_INFINITE_BLADE_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `sleep-dart` | 麻醉镖 | 安娜 | A：完整主体草案 | [ANA_SLEEP_DART_AUTHORING_DRAFT.md](ANA_SLEEP_DART_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `sonic-free-move-passive` | 音速 | 索尼克 | A：完整主体草案 | [SONIC_FREE_MOVE_AUTHORING_DRAFT.md](SONIC_FREE_MOVE_AUTHORING_DRAFT.md) | 完整作者主体与公共依赖已补；待运行实现与验证 |
| `sonic-homing-attack` | 追踪攻击 | 索尼克 | A：完整主体草案 | [SONIC_MOMENTUM_AUTHORING_DRAFT.md](SONIC_MOMENTUM_AUTHORING_DRAFT.md) | 共享动能依赖与完整主体已补；运行及UI验证待后续 |
| `sonic-spin-dash` | 旋转冲刺 | 索尼克 | A：完整主体草案 | [COLLISION_DASH_AUTHORING_DRAFT.md](COLLISION_DASH_AUTHORING_DRAFT.md) | 完整作者主体与公共依赖已补；待运行实现与验证 |
| `sonic-super-form` | 超级形态 | 索尼克 | A：完整主体草案 | [SONIC_MOMENTUM_AUTHORING_DRAFT.md](SONIC_MOMENTUM_AUTHORING_DRAFT.md) | 共享动能依赖与完整主体已补；运行及UI验证待后续 |
| `soul-fracture` | 裂魂 | 古尔丹 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `tails-armor-assembly` | 护甲组装 | 塔尔斯 | A：完整主体草案 | [TAILS_ARMOR_AUTHORING_DRAFT.md](TAILS_ARMOR_AUTHORING_DRAFT.md) | 代码块与手牌正文已补，满手进入弃牌；运行与显示绑定待实施 |
| `tails-mechanical-support` | 机械支援 | 塔尔斯 | A：完整主体草案 | [TAILS_MECHANICAL_SUPPORT_AUTHORING_DRAFT.md](TAILS_MECHANICAL_SUPPORT_AUTHORING_DRAFT.md) | 状态选择与取消已确认，完整主体已补；待运行验证 |
| `tails-twin-flight` | 双尾飞行 | 塔尔斯 | A：完整主体草案 | [TAILS_TWIN_FLIGHT_AUTHORING_DRAFT.md](TAILS_TWIN_FLIGHT_AUTHORING_DRAFT.md) | 独立任务、分别传送、移除快照取消及状态清理完整主体已补；待运行验证 |
| `tirion-divine-glory` | 圣骑士的荣耀 | 提里奥弗丁 | A：完整主体草案 | [PALADIN_SHIELD_AUTHORING_DRAFT.md](PALADIN_SHIELD_AUTHORING_DRAFT.md) | 五项及共享圣盾/强化Rule主体已补；保留整份状态消费，待运行验证 |
| `tirion-holy-recall` | 圣光重召 | 提里奥弗丁 | A：完整主体草案 | [PALADIN_SHIELD_AUTHORING_DRAFT.md](PALADIN_SHIELD_AUTHORING_DRAFT.md) | 五项及共享圣盾/强化Rule主体已补；保留整份状态消费，待运行验证 |
| `turalyon-expedition-order` | 征讨号令 | 图拉扬、维伦 | A：完整主体草案 | [AUTHORING_BATCH_06.md](AUTHORING_BATCH_06.md) | 参数与连续主体及相关Rule已补；新规范差异和运行验证见批次06 |
| `turalyon-grand-crusade` | 圣光大远征 | 图拉扬 | A：完整主体草案 | [GRAND_CRUSADE_AUTHORING_DRAFT.md](GRAND_CRUSADE_AUTHORING_DRAFT.md) | 逐项成功圣盾/Cluster次数刷新完整主体已补；待运行验证 |
| `turalyon-lightforged-march` | 圣铸进军 | 图拉扬 | A：完整主体草案 | [TURALYON_MARCH_AUTHORING_DRAFT.md](TURALYON_MARCH_AUTHORING_DRAFT.md) | 已确认直接触发免费普通移动，完整主体已补；待运行验证 |
| `ulquiorra-cero` | 虚闪 | 乌尔奇奥拉 | A：完整主体草案 | [ULQUIORRA_CERO_AUTHORING_DRAFT.md](ULQUIORRA_CERO_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `ulquiorra-high-speed-regeneration` | 超速再生 | 乌尔奇奥拉 | A：完整主体草案 | [ULQUIORRA_PASSIVES_AUTHORING_DRAFT.md](ULQUIORRA_PASSIVES_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `ulquiorra-resurreccion` | 归刃·黑翼大魔 | 乌尔奇奥拉 | A：完整主体草案 | [ULQUIORRA_PASSIVES_AUTHORING_DRAFT.md](ULQUIORRA_PASSIVES_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |
| `velen-fate-shelter` | 命运庇护 | 维伦 | A：完整主体草案 | [VELEN_FATE_SHELTER_AUTHORING_DRAFT.md](VELEN_FATE_SHELTER_AUTHORING_DRAFT.md) | 敌友变化不取消已确认，完整结算和死亡清理主体已补；待运行验证 |
| `velen-holy-prophecy` | 圣光预言 | 维伦 | A：完整主体草案 | [VELEN_PROPHECY_AUTHORING_DRAFT.md](VELEN_PROPHECY_AUTHORING_DRAFT.md) | 离手保留已确认，实例等待/永久强化及提前完成正文已补；待运行验证 |
| `velen-thousand-futures-ultimate` | 万千未来 | 维伦 | A：完整主体草案 | [VELEN_PROPHECY_AUTHORING_DRAFT.md](VELEN_PROPHECY_AUTHORING_DRAFT.md) | 离手保留已确认，实例等待/永久强化及提前完成正文已补；待运行验证 |
| `venom-claw-rend` | 利爪撕裂 | 毒液 | A：完整主体草案 | [AUTHORING_BATCH_04.md](AUTHORING_BATCH_04.md) | 主体已补；共享调度、实例与表现适配待运行验证 |
| `venom-host-transfer` | 宿主转移 | 毒液 | A：完整主体草案 | [VENOM_HOST_TRANSFER_AUTHORING_DRAFT.md](VENOM_HOST_TRANSFER_AUTHORING_DRAFT.md) | 换位配对及占用依赖已补，无必须全部成功参数；待运行验证 |
| `venom-symbiote-drag` | 共生拖行 | 毒液 | A：完整主体草案 | [VENOM_DRAG_AUTHORING_DRAFT.md](VENOM_DRAG_AUTHORING_DRAFT.md) | 已确认通行布尔true；射线查找、合法落点、位移后定身完整，待运行验证 |
| `watcher-form` | 红蓝形态 | 观者 | A：完整主体草案 | [WATCHER_FORM_AND_CARDS_AUTHORING_DRAFT.md](WATCHER_FORM_AND_CARDS_AUTHORING_DRAFT.md) | 以初始平静游戏开始Rule及获准手牌extension初始化为最新正文，旧待确认段落需清理 |
| `watcher-ultimate` | 潦草急救 | 观者 | A：完整主体草案 | [WATCHER_ULTIMATE_AUTHORING_DRAFT.md](WATCHER_ULTIMATE_AUTHORING_DRAFT.md) | 主体与相关Rule已写；运行实现、公共接口细化及UI/日志/动画验证待后续 |

## 分母以外的内容

以下已在作者索引中，但不混入140分母；不是全部可达内容清单，尚未完成所有生成卡牌/召唤模板/隐藏辅助Skill的可达性审计。

| 内容 | 证据 | 状态 |
| --- | --- | --- |
| 黑色月牙天冲 | [作者草案](ICHIGO_BLACK_GETSUGA_AUTHORING_DRAFT.md) | 有完整主体 |
| 黑虚闪 | [作者草案](ULQUIORRA_CERO_AUTHORING_DRAFT.md) | 有完整主体 |
| 豹王之爪 | [作者草案](GRIMMJOW_PANTHER_CLAW_AUTHORING_DRAFT.md) | 有完整主体 |
| 加具土命／因陀罗之矢 | [主动草案](SASUKE_KAGUTSUCHI_AUTHORING_DRAFT.md)、[共享天照草案](SASUKE_AMATERASU_RULES_AUTHORING_DRAFT.md) | 有作者主体，依赖天照Rule |
| 圣光惩击／治疗／充能及灵魂残片 | [卡牌草案](HOLY_AND_SOUL_CARD_AUTHORING_DRAFT.md) | 四牌主体已有，强化消费等边界需统一 |
| 平静／暴怒 | [观者草案](WATCHER_FORM_AND_CARDS_AUTHORING_DRAFT.md) | 两牌作者主体已有 |
| 恶魔召唤1—5 | [链条草案](DEMONIC_RITUAL_AUTHORING_DRAFT.md) | 五牌草案已有，多实例及异常链条未定 |

## 运行实现与验收进度

本阶段按用户要求只设计框架、补作者代码。既有工作区包含较早模块引擎/UI/数据改动，不能把它们说成不存在，也不能依据作者文件数量认为已兼容最新接口。本次未审计这些生产改动或运行测试，因此不提供运行迁移完成百分比；当前最新作者规范的运行验收数量没有核验证据。旧54个索引条目是文件/技能组数量，本次用140项清单替代进度口径。

最新追加：用户确认霜之哀伤击杀召唤物也获得技能额外1充能，完整主体转A；该次更新后A125/B15/C0。巫妖誓约继续整理模板初始化接口，未实施运行引擎。

最新追加：[巫妖誓约](ARTHAS_LICH_COVENANT_AUTHORING_DRAFT.md)死亡后完整主体已补，成员初始化由引擎统一保证；该次更新后A126/B14/C0，未实施运行引擎。

最新追加：圣铸进军按用户要求直接调用普通移动；鸣人螺旋手里剑、率先出阵补齐完整作者主体。该次更新后A129/B11/C0，未实施运行引擎。

最新追加：影分身与仙人模式完整作者主体已补，队友无真实分身显示权限。该次更新后A131/B9/C0，仅作者规范，未实施运行引擎。

最新追加：泰兰德三项完整作者主体已补，守护每玩家独立一份；圣光牌旧无目标失败语句同步撤回。该次更新后A134/B6/C0，未实施运行引擎。

最新追加：命运庇护确认施加后不分敌我结算，完整主体已补；该次更新后A135/B5/C0。圣光预言离开手牌区的清理时机待确认。仅作者规范，未实施运行引擎。

最新追加：圣光预言离手保留、返手继续；与万千未来共用永久强化Rule的完整主体已补。该次更新后A137/B3/C0，仅作者规范，未实施运行引擎。

最新追加：镜花水月和回溯完整作者主体已补，当前A139/B1/C0。最后恶魔仪式需确认第5张无原实例时的静态模板召唤行为；作者数量不代表引擎已实现。

最新追加：恶魔仪式只召回绑定原实例已确认，五张牌链改为逐实例extension传递；满血回场时序仍待确认，保持A139/B1/C0。

最终主体整理：用户确认满血入场初始化，恶魔仪式转A；当前A140/B0/C0。仅表示140个去重初始Skill均有作者主体，不表示接口冻结、所有衍生内容覆盖或运行迁移完成。下一阶段要求见[工作台与引擎开发提示词](WORKBENCH_ENGINE_IMPLEMENTATION_PROMPT.md)。
