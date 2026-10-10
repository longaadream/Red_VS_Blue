# RED-248：服务器统一管理与动态排位地图池

任务：[RED-248](https://linear.app/redvsblue/issue/RED-248)。本文记录统一管理入口、资源包地图池和公告板审核的实现边界及候选验证证据。

## 基线与风险

- `base_branch: main`
- `base_sha: 00df31f8bd35b34200d507fd83853bf5ac99ba94`
- 风险：High。管理入口能够执行远程服务操作，排位地图池会阻止新比赛创建，社区恢复操作会改变公开内容可见性。
- 当前状态：本机候选，等待独立审查和人工验收；不包含生产部署、合并或发布。

## 动态地图池

地图真源是服务器启动时当前资源根目录中的 `data/maps/*.json`。`lib/game/map-repository.ts` 在加载资源配置后保留全部已加载地图；`getAllLoadedMaps()` 不按玩法过滤，便于管理面板展示资源包中的完整目录。资源包切换仍遵循服务器重启和加载边界，本任务没有增加运行中热切包能力。

`lib/game/map-selection.ts` 将每张已加载地图转换为管理目录项，并按稳定的地图 id 排序。排位资格逐项检查：

- 地图结构和名称有效；
- 不是保留给 2v2 的 `twin-fronts`；
- 内容标记允许 PVP；
- 至少有16个普通可部署地板格。

不符合条件的地图仍显示在目录中，并带有不可用原因。管理员保存的 `official_settings.ranked_maps` 只包含明确勾选的有效 1v1 地图。新发现的有效地图不会自动加入，保存前至少需要3张不同地图；因此资源包更新不会静默扩大匹配范围。

`getRankedMapPoolState()` 同时返回 `catalog`、`enabledIds`、`invalidIds`、`blocked` 和原因。已保存但被资源包移除或变为不合格的 id 会出现在 `invalidIds`；重复或格式错误另返回明确原因。数据库原始配置不会被自动截断或替换。`Ranked` 在启动、排队和配对检查该状态；失效池会写入 `map-pool-invalid` 审计并锁存确认状态，拒绝新排位进入或创建。已有比赛继续使用创建时写入的 pregame pool，不因资源包变化改写比赛快照。管理员通过地图池操作保存新的有效池后，锁存才清除并恢复新匹配。

## 统一管理入口与旧服务器

Windows 管理工具和官方指挥台共享现代运维导航。SSH 工具只在本机监听，连接配置持久化到本机用户目录中的 JSON，字段仅包含主机、端口、用户、密钥路径、服务和数据库名称；管理令牌及密钥内容不持久化。状态请求通过 SSH 代理官方指挥台，保留远端 HTTP 状态和错误体；状态读取失败时显示诊断，不把失败伪报为成功。

工具版本 `RED-248.1` 与远端服务版本分开显示。官方指挥台 snapshot 返回 `capabilities`，旧服务器不支持动态地图目录、社区审核、搜索或恢复时，只对对应功能显示升级提示；账号、对局、维护、备份等仍可用。管理端口继续限于回环地址，SSH 才是远程访问边界。

状态脚本发送前移除 UTF-8 BOM 并把 CRLF/CR 规范化为 LF，避免旧面板截图中的 Bash `set`/`case` 解析错误。更新管理工具后必须关闭旧进程并重新启动，不能假定旧进程会自动加载新脚本。

## 公告板审核

公告仍使用 `official_settings.announcement` 的单条纯文本字段。帖子和回复保留现有软删除、隐藏和 `official_audit` 记录。审核查询支持有界 `offset`、`q`、`status=all|visible|hidden|deleted`，服务层另支持 `kind=all|posts|replies`；帖子和回复各最多返回100条，并按创建时间和 id 稳定排序。隐藏和恢复通过本机可信管理入口执行，原因必填并审计。恢复只清除审核隐藏字段，作者已经删除的内容返回冲突并保持删除状态。

## 数据、兼容和回退

本任务不改变存档格式、游戏战斗状态、随机算法或社区表结构。`official_settings.ranked_maps` 沿用现有 JSONB 字段；地图失效锁存保存在进程内，并通过已有 `official_audit` 的失效/管理员确认记录在重启时恢复。回退不删除社区记录、不修改已有比赛快照、不自动替换地图。回退步骤如下：

1. 进入维护，停止新排位入口并确认没有需要继续接纳的新比赛。
2. 回退前先在当前管理面板保存旧候选支持的至少3张地图；保留当前数据库、资源包和审计记录。
3. 使用旧管理工具和旧服务候选恢复对应链接，验证兼容后再恢复新排位入口。
4. 重新检查指挥台状态、账号、排位历史、公告板和一场隔离测试对局；现有比赛继续读取其原始快照。

若资源包、数据库或旧候选状态无法证明兼容，保持新排位关闭并等待人工确认，不通过旧工具绕过地图池或管理权限。

## 验证证据

以下结果来自本地分支和隔离 PostgreSQL；不代表生产环境验收：

- `npx vitest run tests/integration/postgres/community.integration.test.ts --maxWorkers=1`：1 个文件、4 个测试通过，覆盖审核权限、搜索/状态筛选、分页、隐藏/恢复、审计和作者删除保护。
- `npx vitest run tests/integration/postgres --maxWorkers=1`：7 个文件、15 个测试通过；包含社区回归和 PostgreSQL 权威、资料、邀请及 HTTP 集成。
- `npx vitest run tests/game/map-selection.test.ts tests/colyseus/official-ranked-map.test.ts --maxWorkers=1`：2 个文件、25 个测试通过，覆盖资源包新地图、不可用地图、动态排位房间和已有池兼容。
- `npm.cmd run check:encoding`、聚焦 ESLint 和 `git diff --check` 通过；`npm.cmd run check:main-baseline` 确认分支基于 `origin/main` 的上述 `base_sha`。

最终候选仍需在 Windows 管理工具和实际资源包下完成桌面/窄窗口浏览器验收，记录资源目录实际地图总数、服务器版本提示、真实 SSH 状态查询和用户隔离的回退演练。不得用本机隔离 PostgreSQL 结果替代生产服务器冒烟。
