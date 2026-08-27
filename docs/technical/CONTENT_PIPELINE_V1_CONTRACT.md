# Content Pipeline v1 公共合同

状态：RED-113 Proposed contract

基线：`main@81c754f247b4f627741fbb953df820fdd82ffee2`

决策：[ADR-0018](../decisions/ADR-0018-content-pipeline-v1.md)

## 1. 本阶段交付边界

RED-113 只交付平台无关的 TypeScript/Zod 合同、fixture 和文档。它不读取 ZIP 或文件系统，不计算
hash，不签名/验签，不解析 Patch，不安装或激活 Profile，也不创建或推进 PVE Run。

本阶段合并后，现有 Electron loader、Server、房间、PVE 页面和存档行为保持不变。后续消费者必须
导入这里的 schema/type；不得复制字段、重新解释 hash，或在 UI 中实现规则。

| 唯一来源 | 职责 |
| --- | --- |
| `lib/content-pipeline/contracts/primitives-v1.ts` | ID、SemVer、SHA-256、ABI、路径、JSON 值与确定性字符串排序 |
| `lib/content-pipeline/contracts/pack-v1.ts` | Snapshot/Patch manifest、文件描述符、operation、capability、detached signature |
| `lib/content-pipeline/contracts/profile-v1.ts` | Resolved Profile full/authority identity、provenance 与双 hash envelope |
| `lib/pve/contracts/content-v1.ts` | PVE content manifest、Campaign 及内容文档 |
| `lib/pve/contracts/flow-v1.ts` | 八类独立 Flow node |
| `lib/pve/contracts/run-v1.ts` | PVE Run、checkpoint、receipt 与 active battle reference |

所有对外对象使用 `.strict()`，未知字段失败关闭。导出的 TypeScript type 均由 schema 推导，不能维护
第二份手写接口。

## 2. 公共原语

### 2.1 标识与版本

- `ContentIdV1Schema`：1–128 位 lowercase ASCII；首尾是字母或数字，中间可用
  `a-z 0-9 . _ : -`，不允许 `/`。
- `SemVerV1Schema`：严格 SemVer 2.0.0，不接受前导零等非规范形式。
- `Sha256HexV1Schema`：精确 64 位 lowercase hex。
- `AbiVersionV1Schema`：形如 `rvb-engine/v1`、`rvb-content/v1` 的显式 ABI。
- `UnicodeScalarStringV1Schema`：只接受 well-formed Unicode scalar sequence；拒绝任何未配对
  UTF-16 surrogate，且不执行隐式 normalization。

### 2.2 路径

`PosixRelativePathV1Schema` 只接受 NFC、well-formed Unicode 的相对 POSIX 路径：

- 禁止绝对路径、盘符、反斜杠、NUL/控制字符、空段、`.`、`..` 和末尾 `/`；
- 禁止 Windows 非法字符、尾点/尾空格和保留设备名，包括 `COM¹/COM²/COM³`、`LPT¹/LPT²/LPT³` 及其扩展名形式；
- 总长与单段 UTF-8 长度有固定上限；
- 跨文件大小写碰撞、symlink、ZIP entry 类型和真实落盘路径仍由阶段 2/3 检查。

`compareUnicodeCodePointsV1()` 是集合型字符串的唯一 locale-free 排序函数。不能用 `localeCompare`
或 JavaScript 的 UTF-16 code-unit `>` 代替。Schema 明确标记为集合的数组要求唯一并按该比较器排序；
Patch Chain、branch condition、UI choice、效果执行等有语义顺序的数组保持原顺序。

### 2.3 JSON 值

`JsonValueV1Schema` 只接受 null、boolean、finite number、`UnicodeScalarStringV1Schema`、数组和普通对象
（prototype 只能是 `Object.prototype` 或 null）。对象 key 同样必须通过 Unicode scalar schema。
`Date`、`Buffer`、class instance、function、symbol、BigInt、undefined、NaN、Infinity，以及值或 key
中任何未配对 surrogate 都不是 v1 JSON 值。

阶段 2 从 strict UTF-8 JSON 文本解析，并另外负责重复 key、深度/节点/字符串预算和危险 key 扫描。

## 3. Pack manifest

### 3.1 公共字段

`PackManifestV1Schema` 使用：

```text
schemaVersion = rvb-pack/v1
kind          = snapshot | patch
packageId     = ContentId
version       = SemVer
displayName   = trimmed display text
description?  = bounded display text
publisher     = { id, keyId: sha256 | null }
compatibility = { engineAbi, contentAbi }
capabilities  = sorted unique capability[]
files         = sorted unique PackFileDescriptor[]
```

Manifest 不包含 channel、trust、联网资格、构建时间、绝对路径、ZIP hash 或签名。`publisher.keyId = null`
只让 Local Dev 合同可以先构建未签名 manifest；是否允许未签名由调用方策略决定。

### 3.2 文件与 capability

允许的媒体边界只有：

| 路径 | mediaType |
| --- | --- |
| `data/**/*.json` | `application/json` |
| `images/**/*.png` | `image/png` |
| `images/**/*.{jpg,jpeg}` | `image/jpeg` |
| `images/**/*.webp` | `image/webp` |

文件描述符固定 `path`、正安全整数 `size`、lowercase `sha256` 与匹配扩展名的 `mediaType`。

封闭 capability 枚举是：

- `game-data`
- `pve-content`
- `raster-assets`
- `trusted-executable-content`

Manifest 只声明 capability。阶段 2 必须从真实路径和 JSON 语义推导同一集合；未知、少报或多报都
失败。`trusted-executable-content` 只可由 `bundled-base` 策略识别，不能被 external/local-dev 包用于
获得执行权限。

### 3.3 Snapshot 与 Patch

Snapshot 不接受任何 Patch 字段。Patch 额外要求：

```text
parentProfileHash: sha256
operations: sorted unique-by-target operation[]
```

Operation 合同：

| op | 字段 | 局部语义 |
| --- | --- | --- |
| `add` | `targetPath`, `sourcePath` | target 必须尚不存在（阶段 2 检查） |
| `replace` | `targetPath`, `sourcePath`, `expectedHash` | target/hash 必须匹配父 Snapshot |
| `remove` | `targetPath`, `expectedHash` | target/hash 必须匹配父 Snapshot |

同一 Patch 的 `targetPath` 不可重复并按 code-point 顺序排列。`sourcePath` 是否存在于本包 files、
remove-only Patch 是否没有多余 payload、媒体类型和最终跨文件引用闭合均由阶段 2 检查。

## 4. Identity 与签名字节

阶段 2 必须严格实现 ADR-0018 的 canonical JSON；本阶段只冻结输入投影和 domain 常量：

```text
PACK_IDENTITY_DOMAIN_V1              = UTF8("RVB_PACK_IDENTITY_V1\0")
PROFILE_IDENTITY_DOMAIN_V1           = UTF8("RVB_PROFILE_IDENTITY_V1\0")
AUTHORITY_CONTENT_IDENTITY_DOMAIN_V1 = UTF8("RVB_AUTHORITY_CONTENT_IDENTITY_V1\0")
PACK_SIGNATURE_DOMAIN_V1             = UTF8("RVB_PACK_SIGNATURE_V1\0")
```

```text
packageHash = SHA256(PACK_IDENTITY_DOMAIN_V1 || UTF8(canonical(strictManifest)))

resolvedProfileHash = SHA256(
  PROFILE_IDENTITY_DOMAIN_V1 || UTF8(canonical(resolvedProfileIdentity))
)

authorityContentHash = SHA256(
  AUTHORITY_CONTENT_IDENTITY_DOMAIN_V1 || UTF8(canonical(authorityContentIdentity))
)

signatureMessage = PACK_SIGNATURE_DOMAIN_V1 || decodeLowerHex(packageHash)
```

### 4.1 RVB Canonical JSON v1

阶段 2 的 canonicalizer 必须逐项实现以下算法，不得直接依赖宿主默认 `JSON.stringify` 或 locale：

1. 只接受无 BOM 的 strict UTF-8 JSON；拒绝 malformed/overlong UTF-8、重复 key 和 JSON 外数据。
   数字 token 以 IEEE-754 binary64、round-to-nearest ties-to-even 解析，非有限结果失败。
2. Strict schema 解析后，所有 string value 与 object key 必须是 well-formed Unicode scalar sequence。
   Canonicalizer 不做 Unicode normalization；路径等字段由 schema 单独要求 NFC。
3. Object key 用 `compareUnicodeCodePointsV1()` 按 Unicode scalar/code point 升序排列；本项目排序
   **不同于 RFC 8785 的 UTF-16 code-unit key ordering**。Array 保留 schema 的集合排序或语义顺序。
4. String 遵循 RFC 8785 §3.2.2.2 最小 escaping：quote/backslash 为 `\"`/`\\`；
   `U+0008/0009/000A/000C/000D` 为 `\b/\t/\n/\f/\r`；其他 C0 control 为 lowercase
   `\u00xx`。`/`、其余 ASCII、非 ASCII 与非 BMP scalar 不转义，直接写 UTF-8。
5. Number 遵循 RFC 8785 §3.2.2.3 / ECMAScript binary64 shortest-round-trip：`-0` 为 `0`；
   去除无意义尾零；非零且 `1e-6 <= abs(n) < 1e21` 使用普通十进制，其余非零值使用 lowercase `e`
   科学计数，正指数带 `+` 且指数无前导零。NaN/Infinity 非法。
6. 使用紧凑 `{key:value,...}` / `[value,...]`，不输出 BOM、空白、缩进或换行；最终文本编码为 UTF-8。

Normative ordering vector：

```text
logical object keys (intentionally unordered): ["😀", "\uE000", "a"]
canonical text: {"a":0,"":1,"😀":2}
canonical UTF-8 hex: 7b2261223a302c22ee8080223a312c22f09f9880223a327d
```

Normative escaping/number vector：

```text
logical numbers: [-0, 1.2300, 0.000001, 1e-7, 1e20, 1e21, 333333333.33333329]
logical string: quote:" slash:/ backslash:\ controls:<BS><TAB><LF><FF><CR><NUL> 汉😀
canonical text: {"numbers":[0,1.23,0.000001,1e-7,100000000000000000000,1e+21,333333333.3333333],"string":"quote:\" slash:/ backslash:\\ controls:\b\t\n\f\r\u0000 汉😀"}
```

`` 是单个 `U+E000`，不是 ASCII escape；`<BS>` 等只描述 logical string 中的控制 scalar。
Canonical text 行实际包含反斜杠 escape。任一 byte 不同都必须失败，不得 hash、签名或激活。

ZIP entry 顺序、mtime、压缩算法、宿主路径和 locale 不参与身份。

### 4.2 Detached signature

`rvb-pack-signature/v1` 是 detached envelope：

```text
algorithm   = Ed25519
keyId       = SHA256(raw 32-byte publicKey)
publicKey   = 64 lowercase hex
packageHash = 64 lowercase hex
signature   = 128 lowercase hex
```

Schema 只验证结构。阶段 2 必须重新计算 keyId/packageHash 并验证签名。签名不代表信任或内容安全。

## 5. Resolved Profile 的双 identity

`ResolvedProfileIdentityV1Schema` 是 full hash 投影；`ResolvedProfileV1Schema` 在相同字段上增加
必填的 `resolvedProfileHash` 与 `authorityContentHash`。这里的 Resolved Profile 是解析后的资源内容
组合，不是玩家 Profile 或存档。

Full identity 固定：

- `schemaVersion = rvb-profile/v1`；
- engine/content compatibility；
- effective sorted capabilities；
- Base `{ packageId, version, packageHash }`；
- 有语义顺序的 Patch Chain，每项增加 `parentProfileHash`；
- 按最终 path 排序的完整文件清单；
- 每个最终文件的来源 package、`snapshot | add | replace` 和 source path。

`ResolvedProfileIdentityV1Schema` 保持为上述 strict 字段，不包含两个输出 hash。

`AuthorityContentIdentityV1Schema` 是独立 strict 投影：

```text
schemaVersion = rvb-authority-content/v1
compatibility = Resolved Profile compatibility
capabilities  = sorted unique subset of
                game-data | pve-content | trusted-executable-content
files         = final sorted unique application/json descriptors
                { path, mediaType, size, sha256 }
```

它不含 raster 文件、package/base/patch/provenance/source path、ZIP 元数据或任何 hash 输出。v1 中最终
树的全部 JSON 都属于权威内容；后续若要出现“不影响规则的 JSON”，必须以新合同明确分类，不能由调用方
静默排除。

阶段 2 Resolver 负责验证 provenance 闭合、每个 Patch 的真实 parent、操作 precondition、最终文件字节、
capability 与引用，在隔离副本上原子产生 Profile，并重新计算两个 hash。阶段 1 不宣称任何 fixture 是
已验证/可激活包。

用途边界：

- `resolvedProfileHash`：安装、Patch parent、精确完整树与 provenance 诊断；
- `authorityContentHash`：规则进程、房间握手、PVE Run、战斗 Trace/Replay；
- 玩家 Profile/收藏/构筑/设置/永久记录：使用自身存档版本和稳定内容 ID，不保存 full Profile hash。

## 6. Profile 影响等级

后续激活协调器不得低于以下边界：

| 内容事实 | 最低影响 |
| --- | --- |
| `resolvedProfileHash` 改变但 `authorityContentHash` 相同 | `presentation-refresh`；保留当前 PVE Run |
| `authorityContentHash` 改变 | `authority-restart`；新指针对玩家可见前清当前临时 PVE 状态 |
| 未知 ABI/capability，或外部 `trusted-executable-content` | `app-update-required` / reject |

只导入/验证候选而未激活时不清 Run。是否处于安全刷新点、Server 是否真实加载相同权威内容，以及
删除临时 PVE 状态与活动指针切换如何形成原子边界，属于后续安装/激活任务；包自身不能声明更低影响。
永久玩家 Profile、收藏、构筑、设置、解锁与完成记录不在清理范围。

## 7. PVE 内容文档

`rvb-pve-content-manifest/v1` 用 sorted `documents[{kind,contentId,path}]` 登记独立 JSON。kind 封闭为
`campaign | chapter | encounter | event | reward | relic | enemy`；同 kind+ID 和 path 均唯一。Manifest 与
Campaign descriptor 的 path 直接复用 `PackJsonPayloadPathV1Schema`，必须是 canonical
`data/**/*.json`，不能指向根目录或 `images/**`。

| schemaVersion | 关键引用 | 禁止内联的内容 |
| --- | --- | --- |
| `rvb-pve-campaign/v1` | entry node、独立 node descriptor | Flow body |
| `rvb-pve-chapter/v1` | title/description text、campaign | 自由流程 |
| `rvb-pve-encounter/v1` | map、enemy setup、objective | 自定义胜负代码 |
| `rvb-pve-event/v1` | narrative、choice label/effect/outcome | inline effect/expression |
| `rvb-pve-reward/v1` | reward table、registered grant effect | inline grant code |
| `rvb-pve-relic/v1` | rarity/name/description、ordered effect IDs | hook/code |
| `rvb-pve-enemy-setup/v1` | roster、AI profile | AI 脚本/内联棋子逻辑 |

Campaign 的 node descriptor 以 node ID 排序、ID/path 唯一，并要求 `entryNodeId` 已在同一 manifest 登记。
实际文件存在、descriptor/nodeId 一致、内容引用闭合与图可达性属于阶段 2。

## 8. PVE Flow 节点

每个节点是独立的 `rvb-pve-node/v1` strict 文档，以 `type` 区分：

| type | 关键字段 | 跳转 |
| --- | --- | --- |
| `story` | `storyId` | `nextNodeId` |
| `roster` | `rosterId` | `nextNodeId` |
| `battle` | `encounterId` | `victoryNodeId`, `defeatNodeId`, `drawNodeId` |
| `event` | `eventId` | sorted `outcomeId → nextNodeId` |
| `reward` | `rewardId` | `nextNodeId` |
| `branch` | ordered `conditionId → nextNodeId` | `fallbackNodeId` |
| `checkpoint` | `checkpointId` | `nextNodeId` |
| `end` | `endingId`, `completed | failed` | 无 |

Branch route 顺序是“第一个满足条件即命中”的规则语义，不排序；event outcome 是无序映射，要求唯一
和 code-point 排序。任何 expression、inline effect、inline reward、code 或未知字段都会失败。

阶段 2 检查全部 next/content ID、入口、可达性和循环；阶段 5 Runner 才执行 condition/effect/reward。

## 9. PVE Run、checkpoint 与 receipt

`rvb-pve-run/v1` 固定：

- run ID、safe integer revision、uint32 root seed；
- `authorityContentHash` 和 campaign ID；
- current node、party、deck、relics、primitive flags；
- required checkpoint、nullable active battle reference；
- 有语义顺序的 receipt 列表。

Active battle reference 使用独立 `rvb-pve-active-battle/v1`，固定 battle ID、来源节点、encounter、
权威 state hash，并携带与 Run 相同的 `authorityContentHash`。客户端不能用它提交 winner/result。

Checkpoint 使用 `rvb-pve-checkpoint/v1`，保存可恢复 Run state、revision、receipt count/hash、state
hash 和 `authorityContentHash`。Receipt 使用 `rvb-pve-receipt/v1`，固定 command ID、
`effect | reward | battle-settlement`、来源节点、subject、from/to revision 和 result hash。

局部不变量：

- command ID 在一个 Run 中唯一；
- receipt 每次只推进一个 revision，并按 revision 严格递增且不重叠；非 receipt transition 可造成间隔；
- receipt/checkpoint 不得比 Run revision 新；checkpoint `receiptCount` 必须精确等于
  `toRevision <= checkpoint.revision` 的有序 receipt 前缀长度；
- party/relic ID 唯一，deck 顺序与重复均保留为玩法语义；
- checkpoint 和 Run 的 active battle 必须分别与其父对象的 `authorityContentHash` 相同；
- Run 不含 wall-clock identity 字段。

Receipt hash、checkpoint hash、CAS、命令去重、恢复和 exactly-once 提交由阶段 5 实现；Schema 不执行
状态转移。

激活协调器比较新旧 `authorityContentHash`：相同则保留当前 Run；不同则在新活动指针对玩家可见前删除
临时 Run/checkpoint/active battle。此策略不做 Run 迁移、不保留旧 Profile，也不得删除玩家 Profile、
收藏、构筑、设置、永久解锁或完成记录。RED-113 只冻结字段与责任，删除逻辑属于后续激活/PVE 阶段。

任何恢复、命令或 battle settlement 的 authority hash 不一致都失败关闭，不推进 revision、不写 receipt、
不发奖励。旧 `resolvedProfileHash` / `campaignPackageHash` 字段由 strict v1 Run schema 拒绝。

## 10. 验证职责矩阵

| 检查 | RED-113 schema | 阶段 2 core | 后续 adapter/runner |
| --- | --- | --- | --- |
| 字段、格式、discriminant、局部唯一/顺序 | 是 | 复用 | 复用 |
| ZIP 路径、entry、预算、真实 size/hash/media magic | 否 | 是（archive adapter 在安装阶段） | 只消费结果 |
| canonical package/full-profile/authority-content hash、keyId、Ed25519 | 只冻结字节合同 | 是 | 只消费结果 |
| capability 推导、动态代码字段递归拒绝 | 枚举/边界 | 是 | 不旁路 |
| Patch parent/precondition/原子解析 | 结构 | 是 | 只消费 Resolved Profile |
| PVE 文件/ID/图引用闭合与可达性 | 局部字段 | 是 | Runner 不猜测 |
| Run command/CAS/receipt/checkpoint/战斗终局 | envelope | 否 | 阶段 5 权威实现 |
| authority hash 变化时清临时 PVE 状态 | 字段/相等性 | 提供新旧 hash | 激活协调器/PVE adapter 原子执行 |

## 11. 演进与回退

- RED-113 ADR 保持 Proposed，项目负责人接受后 RED-114 才可开始。
- 阶段 2 若发现合同缺陷，暂停并修订 RED-113；不能在 core 中兼容性猜测。
- 未产生外部身份前可以整体 revert RED-113；没有运行时或玩家数据需要迁移。
- 普通资源更新继续使用 v1，通过新 package version、Snapshot/Patch 和 hash 表达，不要求更新游戏本体
  或玩家存档 schema。
- 一旦 v1 package/Profile/PVE Run 被对外引用，破坏性变化必须使用新 schema/ABI 或单独迁移任务，
  不得静默重写 v1。

合法/非法文档示例位于 `tests/content-pipeline/fixtures/contracts/v1/**` 与
`tests/pve/fixtures/contracts/v1/**`。
