# RED-245 服务器安全切换工具验证

## 范围与基线

- `base_branch`: `main`
- `base_sha`: `9d1b0c30801cd733ec4cede37ce1ef0889a2313a`
- 风险：High。工具会停止两个服务、更新两个受管 release link 和两个 canonical Profile pointer；本次实现未执行生产调用、未提交 commit、未修改 Nginx/relay/数据库内容。
- 允许修改：`scripts/deploy/release-activate.sh`、`scripts/deploy/release-profile.mjs`、`tests/build/server-release-deploy.test.mjs`、本文档。

## 固定输入

- Runtime：`/opt/rvb/runtime/node-v24.21.0-linux-x64/bin/node`
- Services：`rvb-game`（2567）、`rvb-official`（2568），两者必须是 `rvb:rvb`。
- Release links：`/opt/rvb/current`、`/opt/rvb/official-current`。
- Previous release allowlist：`release-0112-4cd7617d8-content-1011`。
- Candidate 必须是 RED-245 allowlist ID、`/opt/rvb/releases/<id>` 的真实不可变目录，并通过完整 `SHA256SUMS`、安全相对路径、无 symlink、`build.json` clean/expected commit/Node 24 检查。
- Signed package `packageHash`：`25b673f202e1b9eeace0fce32398439c3178c7b128b23a32b3710e5c7e6d2346`。
- Candidate profile：`resolvedProfileHash=56211560292d9088c7ec0d1a97e0af86725fb63cd5ed2b16b4a1fd38bd24e3dd`，`authorityContentHash=a46408509276fbb3a96d58bc2a8b6a0b0792775040f8f7ee63375f022c658fd2`。
- Old production profile evidence：`resolvedProfileHash=13988cfa03263f65365bbea66ee28e5ab7733b084712e74f472fce584c148aa8`，`authorityContentHash=ab8006a933c8d9ce6faea2fee507d214e9d05242d0541d2be4e4b682a82d8b71`。

## Helper 验证

`release-profile.mjs` 是唯一 Profile 写入入口。它在动态加载 runtime 前设置显式 `APP_ROOT_DIR`/`USER_DATA_DIR`，Profile root 固定由 canonical runtime 推导为 `<state-root>/resource-pack`，安装保持 signed-only（`allowLocalDevUnsigned: false`），并且只输出一份 identity JSON。

- `inspect` 只读 `readState()` 并 verify stable reference；发现未完成 activation 时 fail-closed，不在线调用 recovery。
- `install`/`rollback` 只在停服后调用 `recoverInterruptedActivation()`，并使用 `beginActivation`/`commitActivation`；已是 expected new stable 的 install 是严格 previous-stable 守卫下的幂等 no-op。
- rollback 先辨认 stable 是 old/new；old 已稳定时安全跳过，new 只有在 previous-stable 是 expected old 时才可切换。
- 本地 signed fixture 已验证：signed install、重复 install no-op、inspect 对 activation journal 拒绝且不改写 state、canonical rollback。

## Activation 顺序

1. 获得 `flock`，核对旧 link、systemd ExecStart、服务账号和两个 profile state owner。
2. 读取 panel URL；每次 panel 请求重新读取 `/var/lib/rvb-official/control-panel.url`，使用 loopback origin 和 URL fragment token，token 永不输出。
3. 记录旧 profile identity，并对两端执行 `/healthz`、`/catalog/identity`、normal `/rooms`、PVE `/rooms?mode=pve`；要求两个 authority 一致、房间列表为空。
4. 通过既有 control panel audited action 打开 maintenance，重新 snapshot 和 room probe，再查询 `rvb` 与 `rvb_official` 的 `battle_room_authority` 非 terminal 计数以及官方 assigned/recent queue idle，最后生成 `sudo -u postgres pg_dump -Fc` 与两个 resource-pack evidence backup。
5. 在第一次 `systemctl stop` 前设置 `CUTOVER_STARTED=1`。停服后才以 `sudo -u rvb` 调用 canonical helper 安装两端 profile；之后原子更新两个 link。
6. 启动两个服务后进行最多 30 次有界 readiness 轮询（healthz、catalog identity、panel snapshot）；通过后再执行完整 identity/rooms postcheck，确认两端 hash/authority 与 candidate 完全一致。
7. 只有 verified service ready 后才恢复原 maintenance 状态。切换期间不改 Nginx、relay、DB schema 或 active pointer 文件。

停服前的 maintenance、room、DB idle 或 backup 门禁失败，只恢复原 maintenance，保持现有服务和 active match 运行；不会触发停服回滚。第一次 stop 后的任何失败都无条件 stop 两个 unit，确认已 stopped 后才恢复 old links/Profile，再启动并 verify old identity；无法验证时保留 maintenance 并报告。

## 生产前置证据缺口

2026-10-09 更新：用户重新授权部署并确认强制更新，已通过独立候选验证及本次专用临时入口冻结、双库/PVE/事务证据完成实际切换。通用发布脚本仍保留下面的缺证据固定拒绝，不修改已公开资产；具体执行、备份、回退和验收见 [官方部署记录](RED245-production-deployment.md)。下面描述的是本次专用运维方案获批准前的缺口。

当前只读生产检查已得到：两个 HTTP healthz 正常，normal/PVE listing 为空，assigned/recent queue 为 0；但 `/rooms` listing 不能证明 hidden/private/finished room 已终止。生产 DB 还需要在不打印凭据的情况下分别核对 `rvb` 与 `rvb_official` 的 authority 持久化房间 `terminal=false` 计数均为 0，并取得可用的 PVE durable lease 终止证据；还需要维护窗口冻结普通 game ingress 的既有审计证据。缺少这些证据时，工具应保持 automatic activation 阻断，不以空 listing 宣称全量 idle。

## 本地验证

```text
node --check scripts/deploy/release-profile.mjs
node --check tests/build/server-release-deploy.test.mjs
node --test tests/build/server-release-deploy.test.mjs
git diff --check -- scripts/deploy/release-activate.sh scripts/deploy/release-profile.mjs tests/build/server-release-deploy.test.mjs docs/qa/RED245-server-deploy.md
```

`server-release-deploy.test.mjs` 包含静态门禁顺序断言、真实 esbuild bundle 后的 signed install/idempotent/activation-guard/rollback fixture，以及 POSIX 隔离 mock command fixture。该 fixture 覆盖 post-start failure、official partial install failure 和停服前 DB gate failure；Windows 开发机上最后一项因没有可用 POSIX bash 会 skip，Linux 发布主机应运行它，确认 stop-before-rollback 顺序和停服前失败不停止服务。

POSIX fixture 只在读取 shell source 供隔离执行时归一化 CRLF，正式脚本仍按仓库的 LF 门禁检查；命令 mock 使用测试进程的绝对 Node 路径，并分别模拟 `%U:%G`、目录 `%a=755` 和文件 `%a=644`。Linux 验证应看到三项通过；若只在 Windows 运行，应明确记录一项 POSIX fixture skip，不能将其记为通过。

独立 Linux 验证曾复现 `atomic_link_update` 在同一 `local` 声明中读取尚未绑定的 `link`，导致 `set -u` 中止回退。已将 `temporary` 初始化拆到下一条声明。修复后，官方机器新建的 `/tmp/rvb-red245-shell-qa-dda817a776ad43e8b4f5243285f81dd0` 内真实 Bash fixture 为 1/1 PASS（post-start rollback、pre-stop refusal、partial-install rollback）；上传脚本 SHA-256 与本机完全一致：`af28ca88641136427df5df67ae1299963f1902cc89d979fd7f4ba176382edaf8`。测试副本只移除未被该 name-filter 执行的静态 `esbuild` import，没有改动 fixture 行为。另从实际脚本提取函数，在 `set -Eeuo pipefail` 下更新临时 symlink，`atomic_link_update_ok` 且 exit=0。全部 mock 状态位于新建 `/tmp` 下，未调用真实生产服务、DB 或 `/opt`/`/var` 写入；Windows 另外两项测试通过。

## 回退

回退只通过同一 trusted helper 的 `rollback` 和旧 release link 原子恢复完成；禁止复制或编辑 `resource-pack/active.json`，禁止恢复数据库。生产执行前应保存 stdout/stderr、panel snapshot、service 状态、old/new identity、DB idle 查询、backup 路径及 rollback 证据。
