# 地格效果表现

地格效果默认使用 simultaneous：同一动作中相邻的地格效果一起播放，不逐格等待。
expand 按 presentationStep 分圈播放，同圈同时出现；暴风雪和天照使用此模式。
旧 instant 提示归一化为 simultaneous，不再作为新 SkillCode 的选项。

SkillCode 使用 flow.effects.tileBatch(effects, presentation?) 批量写入地格效果；expand 按批次坐标包围盒中心计算切比雪夫距离作为圈序。
表现提示随地格事件传递，客户端只据此组织动画。所有格子的规则状态在技能执行时已经提交，动画不参与规则等待；进入己方选择器仍可立即跳过剩余表现。
单格天照只有一圈。因陀罗之矢保持默认 simultaneous。

选择器与表现队列：BattlePresentation 在接收最新模型并登记展示事件后，遇到己方 pending 或 target 模式，立即清空展示队列并将棋盘同步到当前权威模型。该操作不触发 onPlaybackIdle 的页面重绘回调，避免同步选择器时递归重绘；对方 pending 不触发此跳过。目标取消遵守权威 canCancel，取消请求不提前标记权威会话已结束，被拒绝后仍可恢复选择。
