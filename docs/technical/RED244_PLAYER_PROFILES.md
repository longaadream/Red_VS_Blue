# RED-244 玩家资料与回放

用户已于2026-10-08明确批准资料权限、终局回放与新增持久化方案。Linear RED-244 为需求合同。base_branch: main；base_sha: 9d1b0c30801cd733ec4cede37ce1ef0889a2313a；继承候选 ce824e824409547321aeeead4d05613a96600b62（PR231），不替换历史修复。

## 实现接口约定

所有下列 API 均复用官方 Bearer 会话。公开资料是向已登录玩家提供的安全字段，不包括邮箱、凭据、进行中阵容或原始检查点。

- GET `/official/players/catalog` → `{characters, resourceIdentity}`。
- GET `/official/players/cards?ids=...` → `{players}`；至多50个稳定账号ID，简短头像/昵称投影。
- GET `/official/players/:accountId` → `{profile}`。
- POST `/official/players/me` `{name, avatarCharacterId}` → `{profile}`。身份只取认证会话；拒绝额外写入字段。头像只能选择目录角色，允许 null 恢复默认。
- GET `/official/players/:accountId/history?cursor=...` → `{matches,nextCursor}`，每页至多20场，仅结束对局；按时间和ID稳定游标，不使用offset猜页。
- GET `/official/character-stats` → `{resourceIdentity,matches,playerGames,characters}`，仅当前资源身份的已结算、实际开局样本；选择率=携带该角色的参赛阵容数/参赛阵容总数，胜率=获胜携带阵容数/携带阵容数，平局单列，显示样本量。
- GET `/official/matches/:matchId/replay` → `{trace}`；仅参赛者且已落盘终局。导出脱敏 Trace v2，保持既有验证预算和hash校验；无归档明确不可用。
- GET/POST `/official/community/invitations`：收件箱/发送邀请，POST只接受`targetAccountId,hostId,roomId`；POST `/:invitationId/accept` 或 `/decline` 仅收件人可操作。邀请5分钟过期，单账号每分钟最多5条新邀请，重复待处理邀请复用同一条。

CharacterCard: `{id,name,image}`；image 是受限本地图片标识，客户端只解析到本地 images，不接受外部URL。PlayerCard: `{id,name,avatar:CharacterCard|null}`。

Profile: PlayerCard 加 `{totalGames,wins,draws,season:{id,name,rating,games,wins},favoriteRosters:{light:Roster|null,dark:Roster|null},recentMatches:MatchSummary[]}`。
Roster: `{pieces:CharacterCard[],games,wins}`，只使用真实锁定过的完整8棋子组合，顺序无关，不拼接8个高频棋子。
MatchSummary: `{id,createdAt,finishedAt,status,map:{id,name}|null,players:MatchPlayer[],winnerId,reason,replayAvailable}`。
MatchPlayer: PlayerCard 加 `{alignment:'light'|'dark'|null,pieces:CharacterCard[],ratingBefore:number|null,ratingAfter:number|null,delta:number|null}`。

资料编辑只新增独立版本化资料表中的头像字段，并更新既有账号昵称权威字段；历史汇总从官方比赛与已锁定赛前记录派生，避免重结算或重复计数。老记录缺少阵容/地图/回放时明确显示未记录，不推测。历史显示采用记录时的名称，头像是当前个人选择；不得用资源Profile hash作为玩家永久身份。

## 客户端

复用一份 `player-profile.js` 弹窗和 `player-profile.css`；自有页、好友、榜单、战绩中的玩家卡打开相同弹窗。仅本人显示编辑页。数据使用textContent，不接受HTML；切换用户/服务器或关闭弹窗使旧请求失效。账号服务端地址和token复用 RvBUtils 的HTTPS验证与会话，不创建第二套账号存储。

回放保留现有逐帧、速度、视角、拖进度能力，增加按回合跳转、对局概要与回到战绩。观看只物化历史检查点；不重跑规则、不连接活跃房间。保留原局外门禁与文件导入验证。

等待房间中“邀请好友”选择当前共享房间与好友；社区/排位/首页的“约局邀请”显示收件箱。仅保存同一账号服务器内的hostId与roomId，不接收任意URL。接受后复用multiplayer的资源身份检查与lobby的签名加入/选择阵营，邀请本身不授予房间权限。离线或未开启互联网共享的房间给出原因。room.html仅为这两个入口及资料脚本做必要呈现接入。战斗头像以roomUpdate的accountId映射，离线棋子和未识别账号不会用游戏实体ID冒充用户档案。

## 验证与回退

High风险；验证双账号权限、非法头像/额外字段、资料重启保留、阵容/地图准确、分页、匿名/非参与者/未终局回放拒绝、统计资源隔离/幂等、合法导出导入、弹窗键盘与小窗口、历史UI回归。独立AI审查后提供实际截图，不替代人工体验验收。
回退关闭新增入口/API，保留资料表和旧数据；不更改Elo、规则、journal或Trace格式，不合并/发布。
