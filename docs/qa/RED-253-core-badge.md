# RED-253 核心棋子 badge 隐私回归

## 合同与基线

- 风险：Medium（仅战斗页表现权限，未改变规则、存档、协议或状态哈希）
- 基线：`main` / `00df31f8bd35b34200d507fd83853bf5ac99ba94`
- 分支：`codex/RED-253-naruto-core-privacy`
- 范围：`data/pages/battle.html` 的棋子详情 badge、页面 renderer 的轻量 DOM 回归 fixture、相关技术与 QA 说明。
- 不在范围：召唤 sealed recipe、`displayIsCore` 新字段、公共投影协议、权威 `isCore`、终局结算、state hash。

## 修复前复现

使用页面原样 `renderPieceIdentity` 与轻量 DOM 字段 fixture，设置 source `isCore=true` 与 active clone `isCore=false/masterPieceId=source`：

```text
npm.cmd exec vitest run tests/ui/red253-core-badge.test.ts --maxWorkers=1
```

基线结果：`4 failed, 1 passed`。敌方 source/clone、墓地 source、缺失 source clone 与 raw spectator clone 仍显示 badge；普通非核心棋子用例通过。

## 修复后自动验证

```text
npm.cmd exec vitest run tests/ui/red253-core-badge.test.ts --maxWorkers=1
```

结果：`6 passed`。fixture 检查轻量 DOM 对象的 `textContent`、`className`、`title`、`aria-label`、`hidden`，执行页面原样 renderer，覆盖 owner、enemy、spectator、active clone、source death、missing source、clone death、重复切换、ordinary piece、ID 前缀误判，以及真实召唤 projection 的 JSON roundtrip。

真实游戏召唤与公开投影 fixture：

```text
npm.cmd exec vitest run tests/game/red253-core-badge-fixture.test.ts --maxWorkers=1
```

结果：`1 passed`。

该 fixture 从 `data/skills/naruto-shadow-clone.json` 加载真实技能，通过 `aiEnvironmentV1` 执行召唤，确认本体仍为 `isCore=true`、clone 为 `isCore=false` 且携带显式 `masterPieceId`；敌方公开投影保留这两个字段。明确传入 spectator viewer 时，公开投影会去除 `masterPieceId` 并把存活 source 的显示身份复制到两条记录；source 死亡或缺失时，clone 的 projection 可能回退为 `isCore=false`。UI fixture 将这三种真实 JSON roundtrip 都喂给原 renderer，所以页面在 `SPECTATE_MODE` 统一隐藏身份 badge，不依赖公开投影补全分组。

页面加入 `.pi-identity[hidden] { display: none; }`，覆盖 inline-flex 对浏览器默认 `[hidden]` 样式的覆盖。根任务的 Chromium 隔离探针共 `17` 个场景通过，确认隐藏 badge 的 computed `display` 为 `none`，并确认 ordinary badge 恢复为可见的非 `none` display；该探针只消费页面函数和 DOM，不修改权威状态。

根任务的浏览器隔离探针记录在 `output/RED253-browser/result.txt` 与 `output/RED253-browser/spectator-result.txt`，截图为 `output/RED253-browser/badge-dom.png`；这些记录提取原样 renderer/CSS 并运行隔离 DOM 场景，不宣称完整 Electron 验证。

根任务还记录了 `typecheck`、编码检查与 main baseline 检查通过。更宽的候选测试共 `180` 项，其中 `167` 项通过、`13` 项为基线已有失败；同一 `13` 项也在修复前基线复现，记录见 `output/RED253-browser/baseline-existing-failures.json` 与 `output/RED253-browser/baseline-existing-failures.log`。

## 人工验证

1. 打开 battle 页面，进入一个有鸣人影分身的对局。
2. owner 视角查看本体与 clone，确认各自仍显示原始“核心棋子／非核心棋子”；切换普通棋子后 badge 不留空或隐藏状态。
3. enemy 或队友视角查看同一组，确认本体与 clone 的 badge 都完全隐藏，且详情正文的 stats/skills 镜像仍正常。
4. 让 source 死亡但 clone 存活，再查看墓地 source 与 live clone；两者 badge 都隐藏。让 clone 消散后再次查看 live source，badge 恢复。
5. 进入 spectator URL，确认 raw 或 source 缺失的投影都不通过 badge 暴露身份；页面无新增网络字段或权威状态修改。

## 限制与回退

观战页统一隐藏身份 badge，因此普通 core/non-core badge 对观战者不可见；这是覆盖公开投影 source 缺失／死亡降级态所需的最小客户端策略。回退 `battle.html` 的 CSS、helper 与 renderer 分支即可恢复旧 UI，不需要数据迁移或协议回退。

## 最终集成检查

- 直接相关与核心相邻回归：7 个文件、133 项通过，0 失败；报告 `output/RED253-browser/targeted-results.json`。
- 新增 fixture 最终类型修正后：typecheck 通过；定向 ESLint、编码、baseline、diff whitespace 检查通过。
- 独立 Astra 审查：通过，无实质性发现；独立重跑新增 7 项以及终局/真实技能/表现 51 项通过。
- 完整 Electron 和实战人工体验仍待验收；不据此合并、发布或部署。
