# RED-245 官方服务器 0.1.13 部署记录

日期：2026-10-09（Asia/Shanghai）。本次普通服务与官方排位服务已实际切换，COS 仍由用户上传。

## 授权、范围与版本

- 用户先要求“给我 COS 发行目录，然后给官方服务器部署一下最新版服务端”，随后对具体维护、备份和回退方案回复“现在就是无游戏连接，你直接强行更新就行”。此前暂不切换的决定已被撤销。
- `base_branch: main`；本次 fetch 后 `base_sha: 9d1b0c30801cd733ec4cede37ce1ef0889a2313a`；baseline 通过。
- 风险 High；只更新 `rvb-game`、`rvb-official` 的 release link 和可信资源 Profile，保留数据库内容、Nginx、relay、密钥和旧发布目录。
- 实际发布源码：`77c79ea8e41de4c8e604d2162e11443999f38510`；服务端 `0.1.13`；完整签名资源 `1.0.12`。
- 新目录：`/opt/rvb/releases/release-0113-77c79ea8e-content-1012`；旧目录：`/opt/rvb/releases/release-0112-4cd7617d8-content-1011`。
- Linux archive SHA-256：`5a4246e712b9c55e47990e5f18eaa7868ed4e2b104852125158c8e62c175c922`。
- 新 Profile：`56211560292d9088c7ec0d1a97e0af86725fb63cd5ed2b16b4a1fd38bd24e3dd`；authority：`a46408509276fbb3a96d58bc2a8b6a0b0792775040f8f7ee63375f022c658fd2`。

## 候选、入口冻结与闲置证据

1. 上传完整包，检查 archive hash、安全路径、完整 `SHA256SUMS`、干净源码提交和固定 Node 24.21.0；未覆盖旧目录。
2. 独立验证者用独立 `red245_*` 数据库、临时 state 和 loopback 3567/3568，验证实际双服务、签名资源安装/回退、登录后的档案读写。旧 0.1.12 也成功启动于新增表存在的 QA 数据库，证明此次新增结构的回退兼容性。QA 进程均已停止。原始证据：`output/RED245/production-candidate-verification/evidence.md`。
3. 发布资产中的通用 activation 脚本继续保留缺完整证据时的固定拒绝；此次批准的专用运维变体由 `output/RED245/make-production-ops.mjs` 从冻结原脚本生成，不修改已发布源码/包。
4. 运维变体 SHA-256：`5a4d5e942eb67845e7107ceb70a5dc299df30816931cb13190755a33fe33145c`；执行前远端摘要相同，`bash -n` 通过，并经独立审查。
5. 临时 iptables OUTPUT 规则仅针对 UID 33（Nginx）/999（relay）到 `127.0.0.1:2567/2568`。确认游戏监听严格为这两个回环端口、无已建立游戏连接；实际 uid 探测验证阻断，root 运维仍可访问。8080 的独立玩家托管转发不属于此次替换服务，保持可用；其到两个本机游戏端口的连接受 UID 999 规则约束。
6. 在独立 network namespace 实测：两 uid 被阻断、root 可访问、8080 不受影响、未验证服务的清理拒绝、验证后撤销规则恢复访问，PASS。最初监听断言误检查了 ss 的 peer 通配地址，已改为精确比较本地地址列后通过；未在生产执行失败测试。
7. 冻结后等待 35 秒；独立审查实际旧 bundle 确认离线 PVE 默认超过 30 秒释放 lease。再次检查游戏连接、双库未终局房间、assigned/recent queue、DB 无待执行事务、PVE online listing 为空及持久化指纹不变。两份普通 PVE 均为 current=saved、行动阶段且无交战的停驻存档；无 filesystem PVE run store。没有把空公开房间列表单独当成完整闲置证据。
8. 备份完成后、首次停服前再次检查 fence、连接、数据库事务、排位和双库房间状态。REJECT 可能中断检查与冻结之间新建的连接，因此不宣称绝对零中断；本次用户已明确允许强制更新。

## 实际切换与结果

- 双库与双方 resource-pack 备份：`/var/backups/rvb/RED-245-20261008T184706Z-1339880`，目录权限 700；两个 dump 均通过 `pg_restore --list`，数据库没有还原或删除。
- 停止两个 unit 后使用 canonical `install-profile.mjs` 安装签名资源，再原子切换两个 symlink；启动并验证 health、identity 与 panel，最后恢复原维护状态和临时规则。
- activation exit=0，输出 `RED-245 deployment verified: release-0113-77c79ea8e-content-1012`。启动阶段曾出现四次连接拒绝，属于服务尚未监听的有界 readiness 重试；最终健康和身份检查通过，不是忽略失败继续发布。
- 两个链接均指向新目录，game/official PID 为 1341043/1341044；relay PID 858628、Nginx master PID 1123048 保持不变。
- 两个本机服务及公网 `https://play.redvsblue.top` 的 health HTTP 200，资源 identity 与新签名包完全一致；本地 Windows 发起的公网 health/identity 检查也通过。
- 公网 `/official/info`、排行榜（14 位）及 `/hosts` HTTP 200；好友、公告板、档案 catalog/history、回放及邀请 API 的未登录请求 HTTP 401，验证已接入且没有绕过认证。登录后的功能验证发生在隔离候选，未操作真实玩家账号。
- 原 19 个账号、普通服务 2 个 PVE run/2 份 save 均保留；官方 PVE 为 0。新增社区、档案和邀请表存在。
- 临时 fence 已完全撤销。原始执行与 postcheck 输出：`output/RED245/production-activation.log`、`output/RED245/production-postcheck.log`。
- 独立只读部署后复核 PASS：双 links/active unit、health/identity、完整候选 manifest、维护 false、临时规则不存在、四份备份及两个 dump 可读取。

## 回退与限制

旧代码和旧可信 Profile 保留；回退必须先停两个服务，用 canonical helper `rollback` 验证旧/new stable pointer，再原子恢复旧 links、启动并验证，最后开放入口。禁止复制 active.json，禁止自动还原生产数据库覆盖社交/档案数据。

旧 PVE 存档未删除，但其记录的旧资源 identity 与新资源不同；现有恢复逻辑仍执行兼容校验，不能宣称这些存档已通过跨资源版本恢复。玩家真实双端登录、对局和产品体验仍需人工验收。本轮未上传 COS、未部署官网、未合并 PR，也未修改已公开资产。

收尾时 main 合入 PR #224，`origin/main=b01e6a0ad82319b05d9d3753f878e8783074d557`，血缘检查变为 behind 2。新增的是已在本候选累计继承的 RED-239 暴风雪修复：`data/skills/blizzard.json` 与新 main 完全一致，对应测试仅多一个末尾空行。此前候选构建/本次开工检查基于 9d1b0c308 通过；收尾的 baseline 失败明确记录，不能冒称现在通过。冻结发行产物和已部署服务未重建或替换；共享分支历史未擅自改写，PR 的后续基线同步仍需负责人选择策略。

关联：[RED-245](https://linear.app/redvsblue/issue/RED-245)、[PR #233](https://github.com/longaadream/Red_VS_Blue/pull/233)。
