# Content Pipeline v1 核心库

- 状态：RED-114 实现合同
- 风险：High
- 上游合同：`ADR-0018-content-pipeline-v1.md`、`CONTENT_PIPELINE_V1_CONTRACT.md`
- 适用目录：`lib/content-pipeline/core/**`

## 1. 责任边界

核心库接收调用方已经取得的内存字节，完成确定性身份、严格内容校验、Ed25519 验签和线性
Snapshot/Patch 解析。核心输入只有 `path + Uint8Array + declared metadata`；它不读取 ZIP、文件系统、
网络、环境变量、时间或活动 Profile 指针，也不执行内容中的代码。

核心库不负责下载、trust store、安装、激活、回退、垃圾回收、UI、房间、存档、Trace/Replay 或
PVE Runner。这些 adapter 只能消费核心结果，不能重新解释 schema、降低 capability 或绕过拒绝。

`resolvedProfileHash` 和 `authorityContentHash` 不能互换：

- `resolvedProfileHash` 绑定完整资源树与 provenance，用于安装、精确 Patch parent、诊断和回退；
- `authorityContentHash` 只绑定 ABI、权威 capability 和最终 JSON descriptor，用于后续房间、对局、
  PVE Run、战斗 Trace/Replay 的玩法兼容性；
- 纯 raster 更新应只改变 `resolvedProfileHash`，不得中断相同权威内容上的玩法状态。

本任务不接入上述消费者；后续 adapter 必须显式固定一次 `authorityContentHash`，不能在动作执行中
重新读取可变活动指针。

## 2. 公共 API

调用方从 `@/lib/content-pipeline/core` 导入。barrel 只重导出 v1 核心模块，不重导出 schema；schema
仍由 `@/lib/content-pipeline/contracts` 与 `@/lib/pve/contracts` 提供。

barrel 对 source 模块只显式导出公共类型；`createReadonlyContentTreeV1` 及统一字节快照 primitive
属于核心内部构造能力，不属于公共 barrel API。核心内部模块仍可直接导入这些能力。

### 2.1 输入与只读树

`ContentPackSourceV1` 包含 canonical manifest 的原始 UTF-8 字节、可选 detached signature envelope
字节和 payload entries。输入数组顺序不参与身份。

所有 v1 公共字节参数只接受真实的 `Uint8Array` view，且 backing buffer 必须是普通
`ArrayBuffer`。跨 realm 的普通 `Uint8Array` 按 intrinsic brand 接受；Proxy、detached view 与
`SharedArrayBuffer`-backed view 必须在 parser、hash、signature 或内容树消费前稳定拒绝。共享内存可
在复制期间并发改变，无法形成确定性快照，因此 v1 不接受；核心只对一次验证后的有限长度进行复制。

`ReadonlyContentTreeV1` 和 `ResolvedSnapshotViewV1` 不暴露内部字节引用：`readFile(path)` 每次返回
副本；descriptor、Profile 和 identity 元数据被冻结。调用方不得把“只读”解释为持久化或激活。

### 2.2 Canonical、hash 与签名

- `canonicalizeJsonV1` / `canonicalJsonBytesV1`：序列化已经解析的 JSON 值；raw JSON 的 UTF-8、
  重复 key 与预算检查属于 strict parser；
- `computePackageHashV1`：计算 package identity；
- `computeResolvedProfileHashV1`：计算完整 Profile identity；
- `projectAuthorityContentIdentityV1` / `computeAuthorityContentHashV1`：投影并计算权威内容 identity；
- `computeResolvedProfileIdentitiesV1`：一次得到 full/authority 两类结果；
- `signPackageHashV1`：供受控工具链使用测试/发布密钥签名；核心不生成、不存储、不打印生产私钥；
- `verifyPackageSignatureV1`：校验 envelope、package hash、publisher keyId 和签名。

Ed25519 验签接受集合固定为 strict RFC 8032，并显式调用 `zip215:false`。ZIP215-only 的小阶或非规范点
必须稳定拒绝。`keyId` 永远从原始 32-byte 公钥重新计算；签名字节固定为
`UTF8("RVB_PACK_SIGNATURE_V1\0") || rawPackageDigest`。

`signature.ts` 使用精确锁定的 `@noble/curves@2.2.0` 预构建 Ed25519 实例。该实例在构造时把
SHA-512 捕获在私有闭包中；核心不读取或修改 `@noble/ed25519.hashes`、`globalThis.crypto` 或任何其他
共享可变 hash provider，公开函数对相同输入仍然同步且确定。依赖升级可能改变验签接受集合，因此必须
重新跑 RFC 8032 golden、ZIP215-only 小阶/非规范点固定向量，并接受独立安全审查。v1 不使用默认
async/WebCrypto 路径，以免引入 global crypto/platform capability，并迫使 validator/resolver 的同步
API 全面异步化。

### 2.3 Validator

`validatePackSourceV1(source, policy, context?)` 返回 `ValidatedPackV1`。策略必须显式选择：

| policy | 签名 | 受信执行内容 | `networkEligible` |
| --- | --- | --- | --- |
| `bundled-base` | 必须 | 仅用于随程序只读内置 Base | `true` |
| `external` | 必须 | 永远禁止 | `true` |
| `local-dev` | 仅在 `allowUnsigned: true` 时可省略 | 永远禁止 | `false` |

所有策略都必须提供精确 `expectedCompatibility`。Local Dev 只放宽“未签名”这一项，不放宽路径、
预算、schema、媒体、引用、capability 或执行字段检查。Patch 校验还必须通过 context 提供 parent
只读树。

Snapshot manifest 校验不会读取 `context.parent`。只有 Patch 分支会读取一次 context 的 parent getter，
然后把 parent 只读树复制为本地有界快照：`parent.files` 与 `parent.readFile` getter 各读取一次，
descriptor 通过 strict schema、规范排序、唯一性和大小写碰撞检查；每个 descriptor 只调用一次
`readFile(path)`，返回值必须是 ordinary-ArrayBuffer-backed `Uint8Array`，并重新执行单文件/总字节
预算、实际 size/hash、媒体/strict JSON、PVE 引用闭合和递归执行字段检查。Validator 只使用从字节
重新推导的 executable 事实，永远不读取或信任调用方提供的 `hasExecutableContent` 标记。

Validator 对 `source.entries`、Patch `parent.files`、candidate `files` 与
`trustedExecutablePaths` 这些运行时数组只读取一次长度，再按 `0..length - 1` 做 own-property
检查并读取一次对应数值索引；继承索引与 hole 以 `PACK_SCHEMA_INVALID` 拒绝。own accessor 与
non-enumerable own index 均允许，额外 string/symbol 属性与可覆写 iterator 不被观察；Proxy 的
own-check/getter trap 也收敛到同一稳定 schema 错误边界。

`validateResolvedCandidateV1` 供 Resolver 对完整候选树再次执行最终验证。它不是公共安装旁路，不能
把未经 `validatePackSourceV1` 验证的外部包直接变成可激活内容。

### 2.4 Resolver

`resolveProfileV1({ base, patches, candidateCheck })` 只接受一个 Snapshot Base 和调用方给出的有序
Patch 列表。Patch Chain 上限复用已冻结的 `ResolvedPatchChainV1Schema.max(256)`：0–256 项允许；
257+ 必须在读取/验证 Base 或任一 Patch、读取 candidate-check 前以
`PACK_BUDGET_EXCEEDED` / stage `patch` 拒绝，调用方不得调大。

Resolver 先按声明的 dense array 长度和 0-based 数字索引复制 Patch 输入到有界普通数组，不使用可覆写的
iterator、spread、`for-of` 或 `Array.from` 决定链内容。非数组、非法长度、稀疏索引或 Proxy trap
统一以 `PACK_SCHEMA_INVALID` / stage `patch` 拒绝。每个 `ResolvePackInputV1` 的 `source` 与
`policy` 在真正解析该包前各读取一次并快照；非对象或 getter trap 统一以
`PACK_SCHEMA_INVALID` / stage `source` 拒绝。

每个 `ResolvePackInputV1` 独立携带 source 与 policy。返回的
`ResolvedSnapshotViewV1` 包含：

- 冻结的完整 `profile`，其中同时含 `resolvedProfileHash` 与 `authorityContentHash`；
- 冻结的 `authorityContentIdentity`；
- 完整只读内容树；
- 由整条链合取得到的 `networkEligible`。

可选 `candidateCheck` 只观察已完整解析的候选副本。Resolver 只读取一次 hook；读取 getter、
调用 hook、检查返回对象与读取 `result.ok` 都处于受控错误边界。任一 trap、异常、非对象结果或
`ok !== true` 统一映射为 `CANDIDATE_CHECK_FAILED`，不泄漏原始异常，不返回部分候选，也不污染
parent。

## 3. 固定预算

预算是 v1 安全合同，外部调用方不得调大：

| 项目 | 上限 |
| --- | ---: |
| Patch Chain 项数 | 256 |
| payload entries | 2,048 |
| 单 payload 文件 | 16 MiB |
| payload 总字节 | 128 MiB |
| manifest | 16 MiB |
| detached signature envelope | 16 KiB |
| JSON 深度 | 64 |
| JSON value/key 节点 | 100,000 |
| 单个解码后 JSON 字符串 | 1 MiB UTF-8 |

边界值允许；任一 `+1` 以 `PACK_BUDGET_EXCEEDED` 失败。Patch Chain 的第 257 项固定为
stage `patch`，并在观察 Base、任一 Patch 包输入或 candidate-check 前拒绝。JSON parser 还拒绝 BOM、
malformed UTF-8、语法外字节、重复解码 key、非有限数字和未配对 surrogate。

## 4. 稳定验证顺序

为了让相同恶意输入在所有调用方得到相同的首个拒绝，Resolver 在调用
`validatePackSourceV1` 前先完成 Patch Chain 有界索引快照与 256 上限检查；只有该 preflight 成功后才
读取 Base，并按链顺序逐项快照 `source` / `policy`。随后 `validatePackSourceV1` 固定按以下阶段执行：

1. `source`：克隆输入；检查输入形状、entry/字节预算、路径与大小写碰撞；按 Unicode code point
   排序 payload entry；
2. `manifest`：strict UTF-8/JSON 解析与 strict `PackManifestV1` schema；
3. `compatibility`：精确匹配 engine/content ABI；
4. `signature`：计算 package identity，再按策略检查 detached signature、publisher keyId 和 strict
   RFC 8032 签名；
5. `inventory` / `content`：检查 missing/undeclared、实际 size/hash、媒体 magic、strict JSON 和任意
   深度执行字段；
6. 按包类型分支：Snapshot 先在 `reference` 阶段检查 PVE 闭合，再在 `capability` 阶段比对
   推导集合；Patch 先完成 parent 的有界快照与完整 descriptor/bytes/budget/size/hash/content 重验，
   再在 `reference` 阶段检查 parent PVE 闭合。只有 parent 完整 content + reference 验证成功后，才在
   `patch` 阶段检查 target 冲突、add/replace/remove precondition、source 消耗、target media 与外部包
   对重新推导出的受信执行内容之触碰，最后比对 Patch 推导 capability；
7. `profile`：Resolver 在隔离副本上应用 Patch，并按 compatibility、inventory/content、完整
   `reference` 闭合、effective `capability` 的顺序复验整个候选树；
8. 排序 descriptor/provenance 后计算双 identity；
9. `candidate-check`：仅在全部核心验证成功后调用注入 hook。

签名正确只证明字节来源，不能跳过 ABI、内容、capability、引用或执行字段检查。

## 5. Canonical 与 identity 不变量

RVB Canonical JSON v1 使用 Unicode scalar/code point key 顺序；数组保留 schema 冻结的顺序；字符串
使用最小 JSON escape；数字使用 ECMAScript binary64 shortest-round-trip，`-0` 写成 `0`。它与
RFC 8785 的 UTF-16 key 顺序不同，禁止用普通“稳定 stringify”替代。

三类 identity 都是 `SHA-256(domain || canonical projection)`，domain 分别为：

- `RVB_PACK_IDENTITY_V1\0`；
- `RVB_PROFILE_IDENTITY_V1\0`；
- `RVB_AUTHORITY_CONTENT_IDENTITY_V1\0`。

ZIP entry 顺序、压缩方式、mtime、绝对路径与宿主遍历顺序不进入 identity。authority projection
只含 compatibility、权威 capability（`game-data | pve-content | trusted-executable-content`）及最终树
内全部 JSON descriptor；raster、包坐标、provenance、source path 和任何 hash 输出都不进入投影。

## 6. Capability 与主动内容

Capability 由核心根据最终 target path、media type 和 JSON 语义推导，按 Unicode code point 排序。
声明少报、多报、未知或顺序不规范都以 `PACK_CAPABILITY_MISMATCH` 失败。

外部与 Local Dev 内容任意深度出现以下精确字段名都失败：`code`、`skillCode`、`triggerSkill`、
`previewCode`、`effectCode`。HTML、JavaScript、CSS、SVG、WASM、native 二进制与未知主动内容路径也
失败。签名、publisher 名称或展示上的“官方”标记都不授予执行权限。

## 7. PVE 可证明闭合边界

核心只验证当前 v1 schema 能机器证明的关系：

- PVE content manifest descriptor 精确对应 typed document 的 kind、contentId 与 path；
- chapter 引用存在的 campaign；
- campaign descriptor 精确对应 node path/nodeId，entry 存在，所有跳转存在，所有节点从 entry 可达；
- battle node 引用存在的 encounter；encounter 引用存在的 enemy setup；
- event node 引用存在的 event，且路由 outcome 集合与 event choices 的 outcome 集合精确相等；
- reward node 引用存在的 reward；
- 未被任何 campaign descriptor 使用的 node 失败。

当前 schema 没有 `mapId`、`objectiveId`、`storyId`、`rosterId`、`conditionId`、`checkpointId`、
`endingId`、text/effect/rewardTable/rarity/AI profile 等 registry。核心只让现有 strict schema 验证
这些字段的类型，绝不扫描任意 `*Id` 猜测引用。补充 registry 必须先新增并冻结机器可读合同，再由
后续 issue 扩展闭合，不能静默改变 v1 已发布身份语义。

## 8. Resolver 原子性

- Base 必须是 Snapshot；Patch 必须按调用方给出的显式线性顺序应用；
- Patch Chain 允许 0–256 项；257+ 在观察 Base/Patch/hook 前以
  `PACK_BUDGET_EXCEEDED` / `patch` 拒绝；
- `parentProfileHash` 精确匹配父 `resolvedProfileHash`；不支持依赖图、自动排序或
  last-write-wins；
- 同一 Patch 的 target 唯一；add 要求不存在，replace/remove 要求当前 hash 等于
  `expectedHash`；
- 所有 precondition 先对同一个 parent 检查，再在克隆 Map 中应用；
- 每个候选都重新验证完整树、PVE 引用与 effective capability 后才计算双 hash；
- 任一错误只抛稳定 `ContentPipelineErrorV1`，parent descriptor、字节与 hash 保持不变；
- 相同 Base/Patch chain 重复解析必须得到逐字节相同的 Profile identity 与相同双 hash。

## 9. 稳定错误模型

拒绝使用 `ContentPipelineErrorV1`，至少包含稳定 `code` 与 `stage`，可附带非敏感的 `packId`、
`path`、`contentId`。错误消息不得包含签名私钥、完整文件内容或其他敏感 payload。

| 类别 | 错误码 |
| --- | --- |
| schema/路径/预算 | `PACK_SCHEMA_INVALID`, `PACK_PATH_INVALID`, `PACK_PATH_COLLISION`, `PACK_BUDGET_EXCEEDED` |
| inventory/media | `PACK_FILE_MISSING`, `PACK_FILE_UNDECLARED`, `PACK_SIZE_MISMATCH`, `PACK_HASH_MISMATCH`, `PACK_MEDIA_TYPE_INVALID` |
| ABI/签名 | `PACK_ABI_UNSUPPORTED`, `PACK_SIGNATURE_REQUIRED`, `PACK_SIGNATURE_INVALID`, `PACK_PUBLISHER_KEY_MISMATCH` |
| 内容语义 | `PACK_CAPABILITY_MISMATCH`, `PACK_FORBIDDEN_EXECUTABLE_CONTENT`, `PACK_REFERENCE_INVALID` |
| Patch/Profile | `PATCH_PARENT_MISMATCH`, `PATCH_PRECONDITION_FAILED`, `PATCH_OPERATION_CONFLICT`, `PROFILE_HASH_MISMATCH`, `AUTHORITY_CONTENT_HASH_MISMATCH` |
| 候选检查 | `CANDIDATE_CHECK_FAILED` |

调用方可以根据 code/stage 呈现本地化错误，但不能通过匹配英文 `message` 推断业务行为。

## 10. 回退与后续工作

RED-114 不写持久化状态，阶段 3 接入前可整体 revert。后续 adapter 已接入时，先回退 adapter 再回退
核心。若 v1 identity 或签名已经对外产生，canonical/hash/signature/schema 的破坏性修订必须提升
ABI/schema 版本，不能静默修改。

后续任务包括：通用 PVE registry 合同、Profile 原子安装/激活、authority hash 变化时清临时 PVE
Run/checkpoint/active battle、房间硬握手、Trace/Replay pin、PVE Runner 与作者工具链。资源包激活不得
清除玩家 Profile、收藏、构筑、设置、永久解锁或完成记录。
