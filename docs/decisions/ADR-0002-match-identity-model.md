# ADR-0002：分离对局座位、内容阵营与敌我关系

状态：已接受
日期：2026-08-13
关联任务：RED-27

## 背景

旧代码将 `faction` 同时用于 red/blue 座位、棋子内容归属与敌我推断。同阵营对局会使这些概念冲突，并可能错误处理目标、终局和 UI 状态。

## 决策

- `red | blue` 仅为对局座位（`seat`）。
- `light | dark` 为玩家选择的内容阵营（`alignment`）；读取旧 `good | evil` 时仅在兼容边界映射为此字段。
- `ownerPlayerId` 是唯一的 ally/enemy 判断依据。
- `firstPlayerId` 独立表达先后手；不得由座位或内容阵营推导。
- 房间旧 `faction: red | blue` 仅保留为座位兼容别名。棋子模板的内容 `faction` 仍是数据层字段，不能用于敌我判断。

## 影响

- 房间 HTTP、WebSocket、训练和调试入口传递独立的座位、内容阵营、所有权与先手信息。
- 服务端拒绝缺失或非法内容阵营，以及与玩家内容阵营不匹配的选人请求。
- 客户端终局的临时显示逻辑按存活 `ownerPlayerId` 统计，不按 `faction`。

## 回退方式

回退 RED-27 的独立提交即可恢复旧接口行为；兼容别名保留在 `room-store`，不需要迁移现有房间 JSON。

## 相关资料

- [RED-27](https://linear.app/redvsblue/issue/RED-27/分离对局座位内容阵营与敌我关系)
- [Demo v0.1 核心对局合同](../product/DEMO_V0_1_CORE_MATCH_CONTRACT.md)
