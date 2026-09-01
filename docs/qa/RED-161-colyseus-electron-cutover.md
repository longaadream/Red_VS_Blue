# RED-161 Colyseus 默认玩家链路切换验收记录

- 风险：High
- 分支：`codex/red-161-colyseus-electron-cutover`
- 合同起始基线：`base_branch: main`，`base_sha: 8902c0da94957fdb52d142363c2c45a2ebda7a7f`
- 当前验证基线：`origin/main@aa1d91351d6852909166f9b2e75943105ded1255`，已包含最终 RED-138/139；
  RED-161 于 `ae7a28f` 合并该基线后重新验证
- 状态：实现验证中；候选包已构建，真实 PostgreSQL和独立审查仍未完成，不能合并或发布

## 已切换范围

- 五个默认玩家页面加载 Colyseus SDK，并通过 `RvBWs` 兼容层使用真实 Colyseus Room。
- Product Room 覆盖建房、双人入座、阵营、准备、8 棋阵容锁定、RED-138 渐进部署和战斗动作。
- Electron 的玩家 `localUrl` 指向 Colyseus 端口；内容 Profile 管理仍使用独立旧运行时端口。
- Colyseus authority 作为 Electron 资源独立打包；新 authority 模块不 import SQLite/Prisma。
- 普通动作回执不等待数据库；version 0 与终局仍使用 RED-160 的 PostgreSQL durable 边界。

## 本机无 Docker UI 冒烟

以下入口使用内存测试替身，只用于 UI/Room 验收：

```powershell
$env:RVB_COLYSEUS_PORT = '38671'
npm.cmd run qa:colyseus
npm.cmd run qa:colyseus-pages
```

浏览器打开 `http://127.0.0.1:38672`，连接 `http://127.0.0.1:38671`。health 会明确报告
`runtime=colyseus-qa-volatile`、`database=memory-test-double`，不得记录为 PostgreSQL 通过。

2026-09-01 自动浏览器双端已完成：连接、建房、暗/光入座、双方准备、各选 8 棋和进入战斗。
过程中发现并修复：连接页只接受旧 `rvb-ws`；战斗页把大小写敏感的 Colyseus Room ID 转成小写。
Trace 按合同未验证。既有内容数据仍缺少 `evil-explosion.json`，毒液配置引用 `venom.png` 而资源为
`venom.jpg`；两项均不在 RED-161 范围。

后续人工验收发现目标准备被 Colyseus `battleReceipt` 压平成普通失败、QA 计时器被脚本关闭，以及
目标技能需要一次额外的准备往返。修复后：拒绝协议保留 target/option continuation；兼容层转入既有
`actionError` 交互；QA 与产品均启用计时器；技能目标可由本地规则适配器即时展示，最终带目标命令
仍由服务端权威校验。该预检只读、非权威，不写回状态、不消费随机、不预测伤害/触发/终局；服务端
continuation/rejected 始终覆盖本地展示。通用客户端预测与 Web Worker 不在本任务范围。Colyseus
启动也显式安装 Node 原生 SHA-256 provider。

阻塞 writer 的双 SDK 客户端样本会单独报告前 5 次冷路径，并以之后 15 次作为热路径门禁。本机复测：

| 度量 | 冷路径最大值 | 热路径 P50 | 热路径 P95 |
| --- | ---: | ---: | ---: |
| 服务端 queue → rules → memory commit → receipt | 75.195 ms | 21.184 ms | 32.203 ms |
| 本机 SDK send → APPLIED | 85.444 ms | 28.229 ms | 46.399 ms |

热路径分解 P95：queue 0.046 ms、rules 19.409 ms、memory persistence 2.182 ms、其余投影/哈希
10.723 ms。数据库 writer 在采样期间保持阻塞，因此这些数字不包含 PostgreSQL 等待。

## 自动验证

- 同步最终 RED-138/139 后，`npm.cmd run test:colyseus`：5 files / 8 tests，通过。
- RED-138 渐进部署、RED-139 hash 证据、Room 隔离及浏览器规则差异回归：5 files / 23 tests，通过。
- 迁移 legacy raw WebSocket/单端口合同并保留 Profile、日志、LAN 与 UI 不变量：9 files / 106 tests，通过；
  由此发现并修复大厅缺失缓存 Identity 时误用 Colyseus `localUrl`、而非独立 `profileRuntimeUrl` 的问题。
- Colyseus 双客户端阻塞 writer 延迟门包含在上述套件中：热路径 server/client P95 均强制
  `< 100 ms`，通过。
- RED-160 原始套件与相邻回归此前合计 42 tests 通过；本次新增 product action 后以以上 12 项为
  当前切换门禁。
- `npm.cmd run typecheck`：通过。
- `npx.cmd tsc -p electron-client/tsconfig.json`：通过。
- `node --check`：Colyseus product/QA/static/build 四个脚本通过。
- `npm.cmd run build:colyseus`：通过，生成 5.9 MB product authority bundle。
- bundle 使用故意不可达的 PostgreSQL 端口启动时执行到数据库边界并明确 `ECONNREFUSED`；这只证明
  产物可加载和失败关闭，不是数据库集成通过。
- 在 RED-161 工作树内使用 `npm.cmd ci --legacy-peer-deps` 完成干净依赖安装；Colyseus 0.18 的可选
  Zod 4 peer 与项目现有 Zod 3 要求该兼容解析，锁文件本身未发生变化。
- `npm.cmd run build:electron:client` 的 Next 生产构建与 Colyseus bundle 通过。Electron 客户端的根
  `node_modules` 已从 `files` 排除，Next standalone 和 Node-targeted authority 作为独立资源打包，因此
  设置 `npmRebuild: false`，避免错误地把 Colyseus 可选原生加速模块重编译为 Electron ABI。随后
  Windows `dir` 候选构建通过，`verify-electron-client-package` 检查 48 个页面资源、287 个离线数据
  资源与 43 个图片资源，全部通过。
- `npm.cmd run check:main-baseline`：通过；HEAD 不落后上述 `origin/main`。
- `npm.cmd run check:encoding` 与 `git diff --check`：通过。
- `npm.cmd run test:postgres`：本机未配置 `RVB_TEST_POSTGRES_URL` 且 5432/5433 无监听，1 file / 1 test
  被明确跳过；不得算作真实 PostgreSQL 通过。
- 仓库全量 `npm.cmd test`：175 files / 1914 tests 通过、PostgreSQL 1 file / 1 test 跳过；另有 1 个范围外
  Electron Editor 归档测试在全仓并行时读到临时零字节 JSON 而失败，随后单独复跑 1 file / 9 tests
  全部通过。该波动不修改 Editor 生产路径，不能替代 RED-161 自身候选门禁。

## 待完成门禁

- 在真实 PostgreSQL 上运行 `npm.cmd run test:postgres`。
- 从已构建 Electron 候选包完成双端动作、重连、普通 APPLIED 与终局 DURABLE 验收。
- 完成 High 风险独立审查。
- 更新 Draft PR 并确认最终 head 的 CI。

## 回退

整体回退 RED-161 分支。不要同时开放 legacy 与 Colyseus 两套玩家权威；PostgreSQL 数据可保留，
不需要破坏性删除。
