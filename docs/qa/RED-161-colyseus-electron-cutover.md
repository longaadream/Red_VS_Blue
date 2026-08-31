# RED-161 Colyseus 默认玩家链路切换验收记录

- 风险：High
- 分支：`codex/red-161-colyseus-electron-cutover`
- 合同起始基线：`base_branch: main`，`base_sha: 8902c0da94957fdb52d142363c2c45a2ebda7a7f`
- 当前验证基线：`origin/main@b0a5c3fb99b68b2a7e174c03b2b0c0a4b30b6926`，RED-138 已重放为
  `6ab7609`、`9db8cb6`
- 状态：实现验证中；真实 PostgreSQL、候选包和独立审查未完成，不能合并或发布

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

## 自动验证

- RED-161/受影响 Colyseus 与 Electron 回归：5 files / 12 tests，通过。
- RED-138 渐进部署与 SkillCode 相邻回归：7 files / 85 tests，通过。
- RED-160 原始套件与相邻回归此前合计 42 tests 通过；本次新增 product action 后以以上 12 项为
  当前切换门禁。
- `npm.cmd run typecheck`：通过。
- `npx.cmd tsc -p electron-client/tsconfig.json`：通过。
- `node --check`：Colyseus product/QA/static/build 四个脚本通过。
- `npm.cmd run build:colyseus`：通过，生成 5.4 MB product authority bundle。
- bundle 使用故意不可达的 PostgreSQL 端口启动时执行到数据库边界并明确 `ECONNREFUSED`；这只证明
  产物可加载和失败关闭，不是数据库集成通过。

## 待完成门禁

- 在真实 PostgreSQL 上运行 `npm.cmd run test:postgres`。
- 构建 Electron 候选包，并从候选包完成双端动作、重连、普通 APPLIED 与终局 DURABLE 验收。
- 完成 High 风险独立审查。
- 执行 `check:main-baseline`、diff/编码检查并创建 Draft PR。

## 回退

整体回退 RED-161 分支。不要同时开放 legacy 与 Colyseus 两套玩家权威；PostgreSQL 数据可保留，
不需要破坏性删除。
