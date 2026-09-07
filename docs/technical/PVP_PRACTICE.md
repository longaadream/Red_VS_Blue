# PVP 练习

关联：RED-195；决策：`docs/decisions/ADR-195-pvp-practice.md`。

## 入口与使用

主菜单「训练营 → PVP 练习」。玩家选 8 枚同阵营、不重复棋子；AI 可由玩家指定（手选或已有棋组），也可自动选组。自动选择优先从该阵营的合法已有预设中抽取，否则按种子打乱合法棋子生成一组。开局前展示实际 AI 棋组，可换组。这里的自动选组不是经过训练的阵容优化器。

阵营与先后手独立，可选择地图。已有 `rvb_piece_deck_presets` 格式不变；只将本次配置保存在 sessionStorage，战局退出即丢弃。练习不上传战绩。

准备页复用现有 tabletop 的木桌、纸纹、手写字体、红蓝墨色及角色头像；对局直接使用现有 battle.html 的棋盘与交互。

## 权威与 AI

- 一个对局一个 Web Worker，Worker 独占完整状态；页面只收玩家可见投影和表现事件。
- 使用当前主线 `createInitialBattleForPlayers` / `runBattleActionIsolated`，正式渐进部署、开局资源、核心胜负及规则选择。没有自由训练的双边控制或 10 AP 修改。
- AI 使用 RED-194 short-search v2（2–3 步短程搜索，部署单步评估）和 RED-184 v8 公开状态评价函数。只执行搜索给出的第一条指令，再按真实结算重算。未移植原实验工作区的引擎加速改动。
- 人类命令必须匹配 revision、输入拥有者及允许命令列表；规则选择优先于当前回合拥有者。人类响应完成后 AI 继续。拒绝过期命令和管理命令。
- 页面不接收 AI 私有手牌、预备区、选择值、调试回放或原始规则日志；AI 错误不携带私有准备信息。
- AI 思考目标约 4.5 秒/回合，包含正式执行和投影的累计计时。Worker 与页面分别检查 10 秒累计预算；单次请求另有 12 秒终止 watchdog。单个不可抢占的 reducer/搜索枚举可能跨越预算，因此不是严格实时保证。超限/无指令时暂停并允许返回，不制造胜负。
- 页面每条公开回执的 `[practice] receipt` 日志只记录 revision、拥有者、动作类型、节点数和耗时，供定位停滞；不输出状态和私有选择。动画等待不计入 AI 思考时间。

## 资源、构建与验证

`npm run build:practice-ai` 将独立模块编译为 `data/pages/js/practice/engine.js`。桌面开发与构建脚本已接入。VFS 只读，规则执行不访问窗口或同步网络。

使用桌面当前 Profile 的 `__battle-data.json` / `__tutorial-profile.json`。正式 setup 直接加载但 manifest 未列出的 `rule-lucky-coin-gamestart.json` 从同源 URL 单独补载；使用 URL 对象避开 pack-fetch 的旧 IDB 相对路径覆盖，缺失即报错。没有更改幸运币规则内容。

本次验证覆盖桌面资源协议和本地浏览器预览；未验证 Android、发布安装包或普通 Next HTTP 服务。预览：`node scripts/qa/practice-server.mjs`，打开 `http://127.0.0.1:8875/index.html`。此服务仅监听 localhost。

定向回归：`npm test -- tests/practice tests/game/ai-environment.test.ts tests/game/roster-contract.test.ts tests/game/red-183-deck-presets.test.ts --maxWorkers=1`。先构建 Worker。时延证据单独运行 worker.test.ts，避免并发重负载。测试输出写入 `output/pvp-practice/`，不作为全局性能保证。
