# RED-252 内容流程图覆盖清单

状态：普通对局可达的 276 个代码主入口、84 个预览入口均通过图校验；3 个生成卡族、2 个 pending 字段（3 个子源码）均有独立冻结图证明。行为验证见 [验证记录](../qa/RED-252-verification.md)，不代表人工验收。声明式内容、不可达内容和冒险内容分别计数。

基线：`main@00df31f8bd35b34200d507fd83853bf5ac99ba94`。

清单文件：[RED-252-content-coverage.json](../qa/RED-252-content-coverage.json)。重新生成：

```text
node scripts/audit-content-graph-coverage.mjs --write
```

该命令只读取 `data/{pieces,skills,rules,cards}` 的注册 manifest 及其 JSON 定义。生成结果不执行内容代码，也不把源码流程图、编辑器 AST 视图或任意脚本节点当作已迁移内容。

## 分母与入口

四个 manifest 的总数与本批普通对局分母如下：

| 内容 | 总 manifest | 普通对局入口 | 其中声明式 | 其中内联字段 | PVE 排除 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 棋子 | 53 | 45 | 45 | 0 | 8 |
| 技能 | 183 | 174 | 6 | 168 | 9 |
| 规则 | 122 | 121 | 20 | 101 | 1 |
| 卡牌 | 76 | 16 | 0 | 16 | 60 |

“声明式”表示定义没有字符串类型的 `code`、`skillCode`、`previewCode` 或 `effect` 字段，因此没有需要替换的旧代码字段；它的效果、引用和依赖仍然需要单独验证。“内联字段”表示至少有一个这样的字符串字段，审计会逐字段记录其迁移状态。普通对局共 356 个条目，其中 71 个声明式、285 个含内联字段；这些条目共有 373 个普通内联代码字段。可达的非棋子条目共 302 个，其中 26 个声明式、276 个含内联字段。

普通对局入口是全部非 PVE 棋子、普通卡牌和非 PVE 规则。技能不单独作为入口，而是从这些入口通过静态引用递归追踪。规则定义在本清单中作为全局规则入口；棋子上的 `rules`、`playerRules`、状态的 `relatedRules` 及代码中的规则 ID 仍会记录为边。定义带有 `availability.modes: ["pve"]` 或 `pve-` ID 前缀时，清单记录 `scope: excluded`，并保存排除原因与证据字段。

本次实际基线结果：356 个普通条目中有 347 个可从入口通过已确认的静态边到达，9 个技能保持 `unreachable`，分别是：

```text
arthas-howling-blast
blackwidow-toxin-damage
elune-guidance-trigger
elune-protection-trigger
hand-cannon
holy-shield-defense
obito-kamui
reap-heal
venom-corrosion
```

可达性只回答“注册内容是否被普通入口引用”，不回答内容是否已经通过运行时差分。不可达项不能从分母中删除，后续迁移批次必须明确处理或记录为保留旧路径。

## 引用与动态候选证明

审计递归读取数组和对象字段，并使用 TypeScript 解析器检查 `code`、`skillCode`、`previewCode` 与 `effect` 字段中的字符串字面量和调用参数。已识别的技能、规则、卡牌和召唤模板棋子会产生带来源字段路径的边；直接字符串引用不会因为出现在旧代码中就改变迁移状态。

动态项仍完整保存在 `dynamicReferences` 中，包含定义文件、字段、行列、表达式、调用名称和原有候选前缀。扫描器会在可识别的数组、`selectOption` 选项、条件分支或受限生成表达式上附加 `resolution`。编译器把局部变量声明规范化为状态机中的赋值、括号和安全索引包装时，扫描器只沿同一源码 AST 的赋值链解析；Rafaam 生成族还要求该字段已经通过实际内容图编译器校验。每个证明都包含 `sourceProof.sourceSha256`，哈希针对当前内联源码字符串；源码修改后旧候选证明不会继续适用。能确认属于 manifest 的有限候选会另外产生 `references` 中的 `evidenceKind: "dynamic-finite-candidate"` 边。

当前 8 条普通对局动态入口的解析如下：

| 来源 | `resolution` | 候选或生成族 |
| --- | --- | --- |
| `rules/rule-rafaam-curse-ward` | `resolved-generated-family` | `^rafaam-curse-[0-9]+$`；由 `battle.customCards` 生成。 |
| `rules/rule-watcher-form` | `resolved-finite-candidates` | `watcher-calm`、`watcher-rage`；候选来自形态分支。 |
| `skills/elune-blessing` | `resolved-finite-candidates` | `holy-smite`、`holy-heal`、`holy-charge`；候选来自 `cardPool`。 |
| `skills/initial-draw` | `resolved-with-baseline-missing` | `sample-reactive-card`；`sample-active-card` 是冻结基线中已知但当前 manifest 缺失的候选。 |
| `skills/rafaam-curse-amplify` | `resolved-with-generated-family` | 静态 `rafaam-curse-sample`，以及 `^rafaam-curse-copy-[0-9]+-[0-9]+$`。 |
| `skills/tails-armor-assembly` | `generated-candidate-set` | 六个二选一组合：`armor-attack-defense`、`armor-attack-heal`、`armor-attack-speed`、`armor-defense-heal`、`armor-defense-speed`、`armor-heal-speed`。 |
| `skills/turalyon-expedition-order` | `resolved-finite-candidates` | `holy-smite`、`holy-heal`、`holy-charge`；候选来自 `selectOption` 选项和校验数组。 |
| `skills/watcher-ultimate` | `resolved-finite-candidates` | `watcher-calm`、`watcher-rage`；候选来自 `cards` 数组。 |

生成族保存在独立的 `generatedFamilies` 字段，不创建伪 manifest 节点，也不增加静态可达数。本次清单识别 3 个生成族和 6 个有限生成候选 ID，三个 `generatedSourceStatus` 均为 `graph-source-validated`。Rafaam ward 与 Tails armor 直接携带 typed source/materializeSource 子图；Rafaam amplify 通过专用 copy closure proof 验证：手牌筛选绑定 `rafaam-curse-` 前缀，来源只包括普通 manifest 中的 `rafaam-curse-sample` 与已验证的 ward 生成族，`battle.customCards[cardId]` 经 JSON clone/parse 后只修改复制 ID，保留原 `code`。外部自定义卡牌脚本不属于 ordinary manifest 分母。Rafaam 固定字符串和 Tails 模板字符串会写入运行时 `customCards.code`，这是独立的卡牌执行入口；只有对应 child/copy proof 与 exact frozen graph proof 同时通过，才计入这 3 个已验证生成族。

生成族还有独立的 `generatedSourceStatus` 和 `generatedSourceProof`。三类生成入口与两个 pending 入口均有登记的独立冻结证明：审计通过一次 `node --import tsx` 子进程从 fixture 调用现有 generated/pending builder，得到 expected graph 与 compiler output，再按规范化完整 graph 和编译后源码哈希逐项比较生产定义。只有实际 artifact、expected graph、compiled source 三者同时匹配，才会标记 `graph-source-validated`；缺少 builder、改动 graph 或改动编译产物都会 fail closed。`registeredGraphProof.entries` 保存每个入口的字段、expected graph SHA-256 和 expected compiled-source SHA-256，便于复核。sink walker 只提供诊断路径和 raw/unresolved 证据，不能单独把未知 graph 计为已迁移。

当前五个登记入口是 `rules/rule-rafaam-curse-ward.skillCode`、`skills/rafaam-curse-amplify.code`、`skills/tails-armor-assembly.code`、`skills/minato-spiral-barrage.code` 和 `skills/turalyon-grand-crusade.code`。ward 卡牌子图、Tails 的 `materializeSource`、Minato 的一个及 Turalyon 的两个 pending 子图均绑定到冻结源码构建结果；Rafaam copy 另外要求复制来源证明与完整产物精确匹配同时成立。任意未登记内容可以保留编译器与遍历诊断，但不能借用其他入口的证明数量。

`pendingSources` 单独记录代码字段内每个 `effectCode` 出现位置，并保留候选种类、字段源码哈希、冻结源码哈希、候选数量和 typed source 计数。候选分母绑定 `tests/game/fixtures/RED-252-legacy-content.json`，因此编译后的状态机即使把多个旧 `.toString()` 入口物化成一个字符串，也不会降低覆盖数量。当前生产数据有 2 个 pending 字段、3 个 pending 源候选（Minato 1 个、Turalyon 2 个），两个字段均为 `graph-source-validated`。只有与冻结候选数量相符的 `source`/`materializeSource` 子图通过实际编译器校验、且完整 graph 和 compiled source 与登记的冻结构建结果一致，才会计为 `graph-source-validated`。扫描只解析 `code`、`skillCode`、`previewCode`、`effect` 这些可执行字段；描述、名称等普通文本即使包含 `code` 一词也不会被当成程序。

冻结基线缺失项保存在独立的 `baselineMissingCandidates` 字段，当前为 `skills/initial-draw` 的 `sample-active-card` 一项。它不会加入 `unknownReferences`，也不会使审计因既有基线缺口失败；其记录仍包含来源哈希和 fixture 路径。若该源码变更，哈希不再匹配，候选会重新按普通动态缺失处理。当前 `unknownReferences` 仍为 0。

## 迁移状态与指纹

每个 manifest 条目都记录以下 SHA-256 指纹：

- `textSha256`：名称、描述、目标提示、关键词和效果标签。
- `targetingSha256`：`targeting` 及范围、目标类型、过滤器、形态、目标要求和 pending 取消字段。
- `codeSha256`：旧 `code`、`skillCode`、`previewCode` 和 `effect` 字段。
- `metadataSha256`：以上三组字段的稳定规范化组合。

对象键使用 Unicode code point 顺序规范化，数组保留原有语义顺序，便于迁移前后逐字比较。指纹是基线证据，不代表代码行为等价。

迁移状态按条目和字段分别记录。当前全 manifest 共 136 个声明式条目、298 个含内联字段条目；普通对局分母中为 71 个声明式、285 个含内联字段条目。373 个普通内联字段的实时迁移数量见生成 JSON 的 `counts`，每次内容迁移后重新生成，避免把阶段性数量当成最终结果。声明式条目的状态是 `declarative`，这只表示代码迁移不适用，不表示它的效果或依赖已经验收。

没有内联字段的条目：

```json
{
  "status": "declarative",
  "graphArtifact": "not-applicable",
  "codeFields": [],
  "fields": {}
}
```

有内联字段但没有图产物的条目，其条目状态为 `legacy`，每个字符串字段也单独为 `legacy`。源码图或编辑器生成的任意视图不会改变该状态。审计只有在内容定义显式携带 `contentGraph.version: "rvb-content-graph/v1"`、`contentGraphField`、匹配的 `contentGraphCompilerVersion`，并由仓库中的 `electron-editor/content-graph.ts` 的 `assertContentGraphArtifact` 实际重新编译且逐字节接受时，才会把被 `contentGraphField` 指定的字段标为 `graph-validated`。当前报告记录 276 个条目和 360 个字段为 `graph-validated`，仍有 22 个条目和 34 个字段保留旧代码状态；这些数量随每次迁移重新生成。

一个 `contentGraph` 只验证它指定的一个字段。例如 `contentGraphField: "code"` 被接受时，条目的 `previewCode` 仍然是 `legacy`；条目聚合状态是 `graph-partial`，不能宣称整个内容已完成迁移。需要迁移多个内联入口时，主入口继续使用兼容字段，额外入口使用 `contentGraphEntries`，每个字段独立编译和逐字节校验：

```json
{
  "contentGraphField": "code",
  "contentGraphCompilerVersion": "rvb-content-graph-compiler/v1",
  "contentGraphEntries": {
    "previewCode": {
      "graph": { "version": "rvb-content-graph/v1", "surface": "preview", "entry": "start", "nodes": [{ "id": "start", "kind": "return" }] },
      "compilerVersion": "rvb-content-graph-compiler/v1"
    }
  }
}
```

主字段不得重复出现在 `contentGraphEntries`。如果主字段和所有其他字符串内联字段都分别通过实际编译器验证，条目才是 `graph-validated`；缺少额外入口、额外入口校验失败或校验器不可用时，未验证字段保持 `legacy` 或 `graph-unverified`。图定义缺少必要字段、编译器不可用或断言失败时标记 `graph-unverified`。因此第一批可以提供完整迁移分母、依赖闭合和 parity baseline，但不能宣称普通对局已迁移完成。

## 验证边界

本清单不修改数据、不执行旧脚本、不改变技能、卡牌、规则或召唤协议，也不验证费用、冷却、随机流、pending 重连、日志、viewer 投影或动画事件的行为等价性。这些项目属于后续图编译、内容适配和逐内容差分批次。

生成器会在缺失 manifest 条目、定义 ID 与文件名不一致或 JSON 无法解析时报告 `validation.errors` 并以失败退出。PVE 专用内容仍出现在清单中，但通过显式 `exclusionReason: "pve-only"` 与 `scope: "excluded"` 从普通对局分母中排除。
