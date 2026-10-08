# 沙漏独立刷新修复

用户验收反馈：`battle.html?mode=practice&timerPreview=1` 静置时停在45秒，鼠标操作后才更新。范围仅表现层调度、预览配置及直接回归；不改正式规则时长或超时结算。风险Medium。

基线 main `9d1b0c30801cd733ec4cede37ce1ef0889a2313a`，从刷新main建分支后快进继承完整社区候选 `a4e73b1ef6fefec47d5370bf887c1816a9852d0d`，保留历史修复。

根因：预览deadline注册误放在showDmFeedback中，scheduleDeadlineStatusRefresh无法发现预览时钟；预览还缺少durationMs，导致沙量分母随剩余时长改变，始终为1。

修复：登记预览deadline/burnStartsAt到现有独立调度器，补齐45秒durationMs。按下一次显示秒数变化安排单个timeout，只更新计时DOM；仅旧版awaiting-locks阶段同时更新部署倒计时。渐进部署候选和棋盘不参与计时重绘。页面销毁停止、归零后不再调度。

验证：新增直接执行页面调度函数与实际预览初始化配置的VM测试，先复现两项调度失败及缺durationMs沙量失败，再修复。预览45→44、烧绳、归零停止、正式回合/响应时钟、重复调度去重、部署倒计时及销毁取消均通过。相关5文件52项通过。

浏览器实际页面重新加载后不再发送鼠标/键盘操作，观测45秒→13秒，沙量CSS变量由1变为0.28886666666666666，进入烧绳阶段。截图见 hourglass-refresh-fixed.png。此页面是视觉预览，归零不结束练习回合，不等同真实双端联机验收。

人工复查：刷新现有timerPreview入口，鼠标保持不动，确认数字每秒递减、上沙减少下沙增加、30秒进入预览烧绳、0秒保持且不重置；普通训练仍不显示假时钟。回退仅撤销本修复提交，保留全部已有UI/社区改动。

后续静置观察到剩余0秒、沙量0。独立Astra审查无实质问题，自行运行5文件52项通过。集成TypeScript、测试ESLint、encoding、diff及main-baseline通过。未进行原生Electron或真实双端联机新增验收，未合并发布。
