# RED-179 动作演出常驻速度按钮验收记录

## 合同与基线

- Linear：RED-179
- 基线分支：`main`
- 开发基线：`59d79dddb1a301b8e2090b39b8b939ba39a463f3`
- 风险：Low（仅战斗表现层本地速度状态）

## 实现结果

- 1× / 2× 切换从临时演出状态条移到战场浮层的独立常驻按钮。
- 按钮在队列空闲时仍挂载，显示当前速度并通过 `aria-pressed` 与动态标签公开状态。
- 常驻按钮与动作小剧场队列共享同一个速度；演出中切换继续按已播放进度重排剩余阶段。
- 按钮层级高于演出遮罩，拥有 44×44px 触控面积；其 pointer/click 事件被本地消费，不触发战场略过或规则意图。
- 速度只保留在当前页面组件内，不进入权威战局、存档、回放文件或服务器消息。

## 自动验证

失败先行：新增常驻控制测试后，当前实现得到 1 个预期失败（14 通过、1 失败），原因为空闲时不存在速度控件。

实现后：

```text
npm.cmd test -- tests/ui/battle-action-vignette.test.ts tests/game/battle-page-contract.test.ts
2 files passed; 47 tests passed

node --check data/pages/js/battle-ui/battle-action-vignette.js
passed
```

## 浏览器验证

Windows Codex 内置 Chromium 加载正式 `battle.html?mode=training` 后，在动作队列空闲状态可访问到常驻控件：

- 可访问名称：`动作演出速度：1 倍，点击切换为 2 倍`
- 标题：`动作演出速度 1×`
- 当前状态：未按下（1×）

两次尝试从训练设置启动真实 Three.js 战局时，内置浏览器标签页均崩溃；因此本轮没有把 1× → 2× → 1× 的真实战局点击结果记为通过。该路径已由 47 项自动测试覆盖，合并前仍建议在 Windows 候选客户端补一次手动点击确认。

## 回退

整体 revert RED-179 提交即可恢复演出内临时速度按钮；不涉及数据迁移。
