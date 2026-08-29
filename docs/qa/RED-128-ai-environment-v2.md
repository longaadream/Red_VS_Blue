# RED-128 AI Environment v2 验证证据

日期：2026-08-29
分支：`codex/RED-128-ai-environment-v2`
基线：`origin/main@0a09899b8e269b9b8bdcbffbea7b2171782572d3`
风险：Medium

## 范围

- 保留 protocol 1 与 `aiEnvironmentV1`。
- 新增 protocol 2、`aiEnvironmentV2`、结构化 pending decision space 与权威物化入口。
- 新增公开 `boardEffects` 白名单；不暴露完整 `extensions`。
- 未修改 pending、targeting、turn、技能、卡牌、UI、网络、存储、随机或依赖。

## v1 / v2 兼容矩阵

| 能力 | v1 | v2 |
| --- | --- | --- |
| 协议版本 | 1，保持不变 | 2，显式接入 |
| 普通完整动作 | `listLegalActions()` | `decisionSpace().candidates` |
| multi pending | 单例 + 稳定前缀代表 | 原子 option/target descriptor |
| 任意非前缀组合 | 不能完整表达 | `materialize()` 后由正式 validator 接受 |
| 动态地格 | 不读取 `extensions` | `boardEffects` 五字段白名单 |
| browser bundle | 保持现有 v1 导出 | 本任务不扩大导出面 |

## 组合与权威校验

- 合成 10 option、选择 1–4：v2 返回 10 个 atom；v1 既有测试仍固定为 13 个代表动作；未生成 385 个组合。
- 真实穆鲁的挽歌：10 张圣光手牌进入 pending，物化索引 1、4、9 的非前缀 3 张组合，正式隔离 runner 接受，
  pending 清理，手牌从 10 变为 7。
- 同一真实穆鲁 pending 的取消由正式取消 validator 接受；手牌仍为 10，行动点未扣除。
- 合成 multi target：物化第 1、3 个非前缀 target，生成既有 primary + `extraTargets` 动作并被正式 validator 接受。
- option 和 target 均覆盖空/超限、重复、未知、过期 revision、错误玩家；每次拒绝后输入状态序列化保持一致。
- 真实黑崎一护：正式 grid target 动作命中后进入 option pending，v2 物化 `stay` 并完成伤害结算。

## 公开投影

- `tileType: 'amaterasu'` 被投影为 `{ id, type, icon, x, y }`。
- 同一 effect 的 `sourceId`、`bgColor` 等字段不进入 observation。
- `visible: false` effect、`privateDebug`、`privatePayload` 与完整 `extensions` 不进入 observation。
- 公开动态地格变化会改变 protocol 2 的 player state key。

## 确定性与性能

固定 seed：`0x84c0ffee`

- descriptor ID：`decision-49247d0b254331115adda08e`
- candidate ID：`candidate-d8e940a962e1897feaf9c507`
- accepted state hash：`1cb859f2577e8f4257482e5d742a029ea6d9e317d7a3bbb478b4ed882e2781a9`
- transition hash：`f9cf345178c099c1d18b993dc5dac5a6bc788bd5aafbcd4d71c59bbcfb46713f`
- 320 个 multi-target 候选：320 个 descriptor atom，首次生成 `4.87ms`，descriptor ID
  `decision-d2a679c54fae012ca9a46e9a`；测试阈值 `<100ms`。
- 重复 observation、descriptor、candidate 和 simulate 得到相同 ID/hash/trace；输入状态、TriggerSystem 规则、
  RNG trace 和动态代码缓存身份不变。

性能数值是本机单次证据；回归测试固定的是线性 atom 数量、稳定 ID 和 100ms 上限，不把该单次耗时视为跨机器基准。

## 自动验证

| 命令 | 结果 |
| --- | --- |
| 新增测试实现前基线 | 预期失败：4 个 v2 用例因接口不存在失败；11 个 v1 用例通过 |
| `npm.cmd test -- tests/game/ai-environment.test.ts tests/game/ai-isolation.test.ts --reporter=verbose` | 通过：2 files，22 tests |
| `npm.cmd test -- tests/game/ichigo-itachi.test.ts tests/game/holy-hand-system.test.ts tests/game/pending-interaction.test.ts` | 通过：3 files，59 tests |
| `npm.cmd run check:encoding` | 通过：768 text files |
| `npm.cmd run check:main-baseline` | 通过：Ahead 0 / Behind 0，基线 SHA 一致 |
| `git diff --check` | 通过 |
| `npm.cmd run typecheck` | 环境/基线阻塞，见下节；RED-128 文件无 TypeScript diagnostic |
| `npm.cmd run lint` | 配置加载阻塞，见下节 |
| `npm.cmd test` | 126/127 files、1337/1338 tests 通过；1 个环境 fixture 失败，见下节 |

## 未解决的静态/环境阻塞

这些失败不在 RED-128 allowed paths 内，本任务未修改依赖或 Electron 打包 fixture：

1. `typecheck` 只剩 `electron-client/main.ts` 与 `electron/main.ts` 的既有 `ws` 类型解析：
   `typeof import('@types/ws')` 不可构造，并连带产生 6 个回调隐式 `any`。v2 公共类型错误已修复后不再出现。
2. `lint` 在检查任何文件前退出：ESLint 配置声明 `import/no-anonymous-default-export`，但未加载
   `eslint-plugin-import`。
3. 全量测试唯一失败为 `tests/build/electron-client-package.test.ts`，测试 fixture 缺少
   `resources/app/standalone/node_modules/next/package.json` 与 `ws/package.json`。其余 1337 个测试通过。

## 审查与验收

- 独立 Medium Risk AI/人工代码审查：待 PR 创建后执行。
- 人工产品验收：待审查与 CI 结果完成后，由项目负责人执行。
- 当前结论：实现候选已通过聚焦与受影响回归，但在上述仓库环境静态阻塞关闭前，不宣称全部检查通过。

## 回退

整体 revert RED-128 的 protocol 2 类型、实现、测试和文档；v1 不需要迁移，玩法状态和存档均未改变。
