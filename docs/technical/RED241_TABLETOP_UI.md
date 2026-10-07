# RED-241 战局纸剧场界面

任务合同：[RED-241](https://linear.app/redvsblue/issue/RED-241)。开发基线为 `origin/main` 的 `9d1b0c30801cd733ec4cede37ce1ef0889a2313a`；继承完整 UI/移动候选 `cb882cadc3a5f5249b1403ddf61e190f3aa9f909`。不改游戏规则、教程或 AI。

## 表现边界

`battle-tabletop-ui.css` 是末尾材质层，复用现有字体、头像和木纹。手牌容器、卡面、展开与悬停几何仍由原有样式控制。行动记录的格式、选择、历史查看不变。

昵称从房间公开 metadata 映射进入 view model；metadata 晚到会重新投影，不写入权威 snapshot。无昵称时显示阵营玩家，训练营显示红方/蓝方。回合归属与响应归属分别展示。

部署角色签读取私有 `presentedDeployment()` 候选、真实属性和权威合法落点。选中后候选签自动收起，给合法落点让出空间；“更换棋子”随时重新展开，不额外确认部署。半透明落位影像是不可拾取 DOM 装饰，不能改变实体坐标、执行召唤或声称展示召唤结算。部署仍只有选角色→点合法格；无合法格时复用服务端随机兜底。

资源转盘只投影准确数字，视觉角度可以封顶，数字不能截断。箭头数字来自已有隔离技能/路径预演 snapshot；取消预演立即清除。沙漏使用 `RvBTurnTimerStatus` 的权威剩余时长；不创建游戏时钟，不在本地结束回合。

镜头复位和原有倍率控件放入设置；移动控件 DOM 节点保留原监听器。桌面全屏与移除的 CSS 全图模式不是同一功能。

## 独立房间便笺协议

`socialHello` 请求功能发现，`socialReady` 返回 v1、支持类型、allowlist 与限制。未收到功能声明时禁止发送，旧服务器显示不可用。`socialSend` 只包含 `requestId/kind/payload`；发送者、昵称与时间全部由服务端认证连接推导。

文本限制为 60 grapheme、2 行、256 UTF-8 bytes。快捷语和印章使用 allowlist ID。每稳定参战 `playerId` 每 3000ms 最多成功一次，各类型共用冷却；断线换 session 不清空。`socialAck` 返回接纳或拒绝结果与重试时间；同请求内容的幂等重试只返回原结果，不重复广播或消耗冷却。不同内容复用 requestId 被拒绝。

`socialEvent` 包含稳定 messageId、可信发送者、类型、内容和服务端时间。本房间认证参战者和授权观战者接收，观战者不能发送。异步读取昵称后重新检查连接身份。缓存有界，room dispose 清理。此通道不进入 BattleState、battle commands、authority version、journal、RNG、回放或行动记录。

客户端用 textContent 展示纯文本，保留本场最多 50 条便笺；静音只关闭到达提醒。Enter 发送，Shift+Enter 换行，Escape 关闭，IME 合成期间不发送。输入区阻断游戏键盘事件，失败保留草稿，断线不排队，冷却结束不自动发送。

## 桌面窗口偏好

`rvb-window-preferences.json` 使用独立 `rvb-window-preferences/v1`，不修改游戏存档或客户端服务器配置。缺失时默认全屏，只有用户通过设置/F11 明确切换才写入；损坏数据有上下文日志并回退默认。

可信 game renderer 只能调用 `getWindowFullscreen()`、`setWindowFullscreen(boolean)` 和订阅变化；main 限定游戏主窗口，admin/editor 不受影响。主菜单和战局设置显示实际状态，普通调试页面没有 Electron bridge 时隐藏该选项。

## 回退

按 UI、社交、桌面三个提交独立撤销。UI 回退不撤销继承的预演/路径修复；社交通道撤销不会改变战斗存档；桌面回退删除偏好入口并恢复旧启动行为。未经人工批准不合并、不发布。
