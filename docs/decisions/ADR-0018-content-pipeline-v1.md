# ADR-0018：Content Pipeline v1 的开放包、Resolved Profile 与声明式 PVE 合同

- 状态：Proposed（等待 RED-113 PR 审查与项目负责人明确接受）
- 日期：2026-08-27
- 任务：RED-111、RED-113
- 风险：High
- 基线：`main@81c754f247b4f627741fbb953df820fdd82ffee2`

## 背景

当前桌面客户端和独立服务端各自维护一套资源包导入逻辑。包只描述很少的构建元数据，导入成功会
直接切换活动指针；客户端、服务端和浏览器页面对“当前内容”的判断也不完全一致。这样的全量资源
替换不能可靠表达“一张图片、一个数值对象或一个 PVE 节点发生变化”，更不能为房间、存档和回放
提供稳定的内容身份。

现有 PVE 页面同样只是浏览器原型：页面逐文件读取 `data/pve/**`，用浏览器时间和随机数创建 Run，
并把权威状态写入 localStorage。它没有可验证的流程图、版本化 Run、精确内容引用或与正式战斗
Runner 的权威终局桥接。

项目还存在一个更严格的安全约束：`lib/game/dynamic-code-runtime.ts` 会编译 JSON 中的 `code`、
`skillCode`、`triggerSkill`、`previewCode` 和 `effectCode`。该运行时只适用于项目内受信内容，
不是第三方代码沙箱。签名只能证明某把密钥签过内容，不能把任意执行内容变安全。

Red VS Blue 因此需要一条同时供官方开发、QA、Stable 发布和社区作者使用的 Content Pipeline；
格式必须开放且一致，但来源信任、运行权限和联网资格必须由调用方策略决定。

## 决策

### 1. 一个格式，多种调用方策略

官方、QA、Local Dev 和社区包统一使用 Content Pipeline v1 的 manifest、schema、validator、
resolver 和 builder。官方身份只表示本地 trust store 预置信任某些发行公钥，不拥有私有字段、
私有包格式或验证旁路。

包作者只能声明内容事实，不能在包内授予自己信任、联网资格或执行权限。后续 validator 的调用方
必须显式选择以下策略之一：

- `bundled-base`：只用于随应用发布且只读的 Base，可以识别当前项目内受信执行内容；
- `external`：用于所有可下载 Snapshot/Patch，要求签名并禁止执行内容；
- `local-dev`：可以由调用方显式跳过签名，但其余内容安全检查不放宽，且结果不能进入普通联网。

### 2. 版本化、严格且只含 JSON 的公共合同

阶段 1 以 `lib/content-pipeline/contracts/**` 和 `lib/pve/contracts/**` 的 strict Zod schema 作为
唯一机器可读合同。所有对象拒绝未知字段；所有标识、路径、hash、ABI 和 SemVer 使用公共原语。
合同只接受 JSON 可表达的数据，不接受函数、`Date`、`Buffer`、平台路径、非有限数字或宿主对象。
所有字符串值和对象 key 必须由 well-formed Unicode scalar value 组成；JSON escape 解码后若仍含未配对
UTF-16 surrogate，schema 必须失败关闭，不能等到 canonicalizer 用替换字符修复。

主要文档使用独立的 schema version/discriminator。v1 文档不得在原字段上静默改变语义；破坏性
变化必须增加新的 schema/ABI 版本，并保留旧解析器或明确拒绝旧版本。
这里的“增加版本”只指 pack 协议、canonical/hash 或 schema 字段语义发生破坏性变化。普通资源更新
仍使用 v1，通过新的 package version、Snapshot/Patch 和内容 hash 表达，不要求更新游戏本体、玩家
Profile 或存档 schema。

阶段 1 只验证单份文档的结构与局部不变量。真实文件字节、hash、签名、capability 推导、跨文件
引用闭合和 Patch 解析属于阶段 2，不能由 UI、Electron adapter 或 PVE 页面各自解释。

### 3. Snapshot Pack、Patch Pack 与文件边界

`rvb-pack/v1` 是 snapshot/patch 的严格 discriminated union：

- Snapshot 描述一个完整内容树；
- Patch 固定精确 `parentProfileHash`，并只通过有类型的 `add | replace | remove` 操作产生新树；
- `replace` 和 `remove` 必须携带目标当前 `expectedHash`；
- 同一 Patch 中一个 target path 最多出现一次；
- Patch 的 payload 文件与最终 target path 分离，后续 validator 必须验证 source 引用、实际大小、
  SHA-256 和媒体类型；
- v1 只支持调用方给出的显式线性 Patch Chain，不支持依赖图、自动排序、可调加载顺序或
  last-write-wins。

包文件只允许规范的相对 POSIX 路径，以及 schema 明确列出的 JSON、PNG、JPEG 和 WebP 类型。
HTML、JavaScript、CSS、SVG、Electron IPC、native 模块和其他主动内容不属于 v1 内容包。
ZIP 只是运输容器；其压缩方式、entry 顺序、mtime 和平台元数据不参与玩法身份。

### 4. Capability 是可核对的内容事实

Manifest 使用封闭 capability 枚举声明包影响的内容域。阶段 2 必须从路径和解析后的 JSON 语义
独立推导 capability，并要求推导集合与声明集合完全相同；少报、多报和未知值都失败。

内置 Base 可以标记只供 `bundled-base` 策略识别的受信执行内容。任何外部或可下载包，即使签名
正确，也不得新增、替换或删除包含执行字段的对象或文件。外部 Patch 对父 Snapshot 中这类目标的
replace/remove 同样失败。签名、发行者名称或“官方”展示标记都不能绕过这一限制。

Capability 还决定后续激活的最小影响级别：纯表现内容可以是 `presentation-refresh`；PVE Flow、
场景和 gameplay 数据至少是 `authority-restart`；未知 ABI、未知 capability 或新增执行表面是
`app-update-required`。具体激活状态机属于后续任务，但调用方不得降低核心库给出的影响等级。

### 5. 确定性 package identity

Package manifest 不包含签名、构建时间、绝对路径或 ZIP 元数据。文件描述符包含内容字节的
SHA-256，因此 manifest 间接绑定完整包内容。

阶段 2 必须实现以下 **RVB Canonical JSON v1** 规范算法：

1. 输入文本必须是无 BOM 的 strict UTF-8；拒绝 malformed/overlong UTF-8、重复 object key 和 JSON
   语法外数据。数字 token 按 IEEE-754 binary64、round-to-nearest ties-to-even 解析；溢出到非有限值失败。
2. 先通过对应 strict schema，得到无未知字段的解析值。所有字符串值和 object key 都必须是
   well-formed Unicode scalar sequence；不执行 Unicode normalization。路径等字段由各自 schema
   另外要求 NFC。
3. Object key 使用 `compareUnicodeCodePointsV1()` 按 Unicode scalar/code point 升序排列；这与
   RFC 8785 的 UTF-16 code-unit key ordering **不同**。Array 保持 schema 已冻结的集合排序或语义顺序。
4. String 使用 RFC 8785 §3.2.2.2 的最小 JSON escaping：`U+0022` 与 `U+005C` 分别写成 `\"`、
   `\\`；`U+0008/0009/000A/000C/000D` 写成 `\b/\t/\n/\f/\r`；其余 `U+0000..001F`
   写成四位 lowercase `\u00xx`。其他 scalar（包括 `/`、非 ASCII 和非 BMP）不转义，直接编码 UTF-8。
5. Number 使用 RFC 8785 §3.2.2.3 / ECMAScript binary64 shortest-round-trip 表示：`-0` 写成 `0`；
   不保留无意义小数尾零；`1e-6 <= abs(n) < 1e21` 使用普通十进制，其余非零值使用 lowercase `e`，正指数
   必须含 `+`，指数不得有前导零。NaN 和 Infinity 永远非法。
6. Object 使用 `{key:value,...}`，array 使用 `[value,...]`，不输出 BOM、缩进、空格或换行；然后
   `packageHash = SHA-256(UTF8("RVB_PACK_IDENTITY_V1\0") || UTF8(canonicalManifest))`，digest
   使用 64 位 lowercase hex。

以下是 normative 文本/字节向量，阶段 2 必须逐字节复现：

```text
logical object keys (intentionally unordered): ["😀", "\uE000", "a"]
canonical text: {"a":0,"":1,"😀":2}
canonical UTF-8 hex: 7b2261223a302c22ee8080223a312c22f09f9880223a327d
```

```text
logical numbers: [-0, 1.2300, 0.000001, 1e-7, 1e20, 1e21, 333333333.33333329]
logical string: quote:" slash:/ backslash:\ controls:<BS><TAB><LF><FF><CR><NUL> 汉😀
canonical text: {"numbers":[0,1.23,0.000001,1e-7,100000000000000000000,1e+21,333333333.3333333],"string":"quote:\" slash:/ backslash:\\ controls:\b\t\n\f\r\u0000 汉😀"}
```

向量中的 `` 是单个 `U+E000`，不是六个 ASCII `\uE000` 字符；`<BS>` 等标记描述 logical
string 中的控制 scalar，canonical text 一行包含它们的反斜杠 escape。任何实现若产生不同文本或
UTF-8 bytes，必须失败，不得继续 hash 或签名。

同一 manifest 和文件字节不论输入遍历顺序、宿主目录或 ZIP 压缩方式如何，都必须得到同一
packageHash。所有集合型数组必须由 schema 要求唯一且按稳定键排序；Patch Chain 等有语义顺序的
数组保持显式顺序。任何会改变内容身份的字段都必须进入 canonical manifest；观察性时间和本机信息
不得进入 manifest。

### 6. Detached Ed25519 签名与信任分离

签名使用独立的 `rvb-pack-signature/v1` envelope，不嵌入 manifest，从而避免循环身份。合同固定：

- 算法只有 Ed25519；
- 公钥是 32 字节、签名是 64 字节，均使用 lowercase hex；
- `keyId = SHA-256(rawPublicKeyBytes)`，使用 64 位 lowercase hex；
- 签名字节为 `UTF8("RVB_PACK_SIGNATURE_V1\0") || rawPackageDigestBytes`；
- envelope 绑定精确 packageHash、public key、派生 keyId 和 signature。

阶段 2 必须重新计算 keyId、packageHash 并验签。Manifest 中的 publisher/keyId 是发行声明，
trust store 是本地策略；二者不能互相替代。Local Dev 未签名是调用方显式模式，不是 manifest
自我声明的豁免。测试和包内不得包含真实 Stable 私钥。

### 7. Resolved Profile 同时导出完整身份与权威内容身份

Resolver 总是在隔离副本上把一个完整 Snapshot 与显式线性 Patch Chain 解析为完整、不可变的
Resolved Profile。任一 parent/precondition/schema/reference/capability/candidate check 失败都不产生
候选结果，也不修改父 Snapshot。

这里的 Resolved Profile 是“已解析的资源内容组合”，不是玩家 Profile、账号档案或存档。它导出两个
用途不同、不能互相替代的 hash。

`resolvedProfileHash` 固定 engine/content ABI、全部有效 capability、最终完整文件清单、Base provenance
和有序 Patch provenance。它的 identity projection 保持为 strict 解析字段且不包含任何输出 hash；
规范 JSON 规则与 package 相同：

`resolvedProfileHash = SHA-256(UTF8("RVB_PROFILE_IDENTITY_V1\0") || UTF8(canonicalProfileIdentityProjection))`

`authorityContentHash` 使用独立 `rvb-authority-content/v1` identity projection，只固定：

- engine/content compatibility；
- 从最终 effective capability 中筛出的 `game-data | pve-content | trusted-executable-content`；
- 最终树内全部 `application/json` 文件的 `{ path, mediaType, size, sha256 }` descriptor。

这些 capability 与文件分别按合同要求唯一、按 Unicode code point 排序。投影不含 raster 文件、包坐标、
Base/Patch/provenance、source path、ZIP 元数据、`packageHash`、`resolvedProfileHash` 或任何 hash 输出：

`authorityContentHash = SHA-256(UTF8("RVB_AUTHORITY_CONTENT_IDENTITY_V1\0") || UTF8(canonicalAuthorityContentIdentityProjection))`

`resolvedProfileHash` 用于安装、Patch parent、精确资源树与 provenance 诊断；`authorityContentHash` 用于
权威规则进程、房间握手、PVE Run、战斗 Trace/Replay 的玩法兼容性。纯 raster 更新会改变完整 Profile
身份，但不改变权威内容身份。一个权威进程绑定 `authorityContentHash` 后，不得在动作中再次读取
可变活动指针决定规则根。

玩家 Profile、收藏、构筑、设置、永久解锁和完成记录使用自身版本化存档合同与稳定内容 ID，不固定
`resolvedProfileHash`，也不因资源包激活而被重写或清除。

### 8. 声明式 PVE Flow 使用 Campaign manifest 与独立节点

PVE 内容继续把 chapter、encounter、event、reward、relic 和 enemy 作为版本化数据，但 Campaign
流程使用独立合同。Campaign manifest 固定 campaign ID、入口节点和独立节点 descriptor；每个节点
保存在单独 JSON 文件中，因此 Patch 可以替换一个节点而不必替换整个 Campaign。

v1 节点是严格的 `story | roster | battle | event | reward | branch | checkpoint | end` 联合：

- 所有跳转使用稳定 node ID；
- battle 只引用 encounter/scene 等登记内容，并显式声明 victory/defeat/draw 跳转；
- branch 只引用登记的 `conditionId` 或 branch table ID；
- event/reward 只引用登记的 event/effect/reward ID；
- 不接受表达式、脚本、inline effect 或任意 code 字段。

Schema 只验证节点自身的形状和局部唯一性。入口存在、所有节点可达、跳转和内容引用闭合、循环和
自动步数预算由阶段 2 validator 检查；实际推进和战斗桥接由阶段 5 Runner 实现。

### 9. PVE Run 固定权威内容、随机根与 exactly-once 事实

`rvb-pve-run/v1` 是服务端权威的版本化 envelope，至少固定 Run ID/revision、`authorityContentHash`、
Campaign ID、current node、root seed、party、deck、relics、flags、checkpoint、active battle reference
和已提交 receipt。Run 不保存 `resolvedProfileHash` 或 campaign package hash；Campaign JSON 已由
`authorityContentHash` 绑定。

命令使用稳定 command ID 与 expected revision。effect、reward 和 battle settlement 的 receipt 以
command ID、来源节点和内容事实支持 exactly-once 去重；checkpoint 必须绑定 receipt 水位，刷新、
重试、并发冲突或 checkpoint 恢复不能重复应用。Run 身份不依赖 wall clock。浏览器只能提交登记
命令并渲染公开 view，不能生成规则 seed、上传胜负、推进节点或回传一份可篡改的权威 Run。

Run、checkpoint 和 active battle 都必须携带同一个 `authorityContentHash`；checkpoint 还必须独立验证
其嵌套 active battle 使用 checkpoint 自身的 hash。任何恢复、命令或战斗结算遇到 hash 不一致都必须
失败关闭，不推进 revision、不写 receipt、不发奖励。

资源包只完成导入/验证但尚未激活时，不影响当前 Run。激活新 Resolved Profile 时：若新旧
`authorityContentHash` 相同（例如纯 raster 更新），保留当前 Run；若不同，则激活协调器必须在新活动
指针对玩家可见前，直接删除当前临时 PVE Run、checkpoint 和 active battle，不迁移旧 Run，也不保留
旧 Profile 继续游玩。玩家 Profile、收藏、构筑、设置、永久解锁和完成记录必须保留。

RED-113 只冻结 schema 和责任边界，不实现激活时删除。旧 localStorage 原型不自动迁移为 v1 Run。

### 10. 战斗终局只来自正式权威 Runner

PVE battle adapter 必须从 active Resolved Profile 构造正式 `BattleState`，并验证其
`authorityContentHash` 与 Run 一致，再通过已有权威 Runner 执行。
胜、负、平只由服务端读取 `BattleState.terminalResult` 后映射到 Flow 跳转；PVE 层不得复制棋子统计、
终局规则或接受客户端提交 winner/result。固定 seed、初始化事实、`authorityContentHash` 和
terminalResult 必须进入可审计状态/Trace 边界。

该 adapter 和 Runner 不在 RED-113 实现；本 ADR 只冻结它们必须消费的 schema 与权威边界。

## 备选方案

1. **每次内容变化都发布完整桌面程序**：实现简单，但开发、QA 和社区内容迭代成本过高，也不能为
   存档和房间提供内容身份。
2. **只分发全量 Snapshot ZIP**：比更新程序小，但单资源修订仍重复分发全部内容，且无法表达父版本
   和替换前置条件。
3. **按目录直接覆盖并允许用户调整加载顺序**：灵活，但结果依赖顺序、容易形成隐式冲突，无法得到
   唯一 Profile，也不适合作为联网和存档合同。
4. **官方包绕过验证、社区包单独走 Mod 系统**：会立即形成两套格式与工具，使第一方开发无法证明
   社区路径真实可用，也放大供应链风险。
5. **签名后允许任意动态代码**：签名不等于沙箱。当前 runtime 没有隔离文件、网络、宿主能力和资源
   消耗，因此拒绝。
6. **二进制差分**：传输体可能更小，但会把 ZIP/平台细节带入身份和恢复逻辑。v1 采用有类型内容操作，
   最终仍解析为完整 Snapshot。
7. **资源更新后保留旧 Profile 继续进行中的 PVE Run**：可避免清进度，但需要长期保留旧权威内容、
   管理多版本 lease 与恢复分支，复杂度和磁盘成本都较高。当前产品决策是权威内容变化时直接清当前
   临时 Run，因此拒绝。

## 影响

收益：

- 第一方与社区共享同一真实发布链；
- 小型内容更新不需要重发桌面程序；
- 完整资源身份与权威玩法身份分离，纯表现更新不会中断 PVE；
- 房间、PVE Run 和 Trace/Replay 可以固定可复现的权威内容身份；
- 玩家 Profile、收藏、构筑和永久记录不与资源包版本耦合；
- Patch 有明确父版本和 precondition，失败不会污染 stable；
- PVE 流程可被验证、局部替换和服务端权威执行。

成本与风险：

- v1 schema、canonical hash 和签名一旦产生外部身份就不能静默修改；
- 所有消费者必须等待公共合同合并，不能并行发明字段；
- 旧资源包和 localStorage PVE Run 不能自动视为 v1 内容；
- Resolver 必须计算两个 identity，激活协调器必须原子比较权威 hash 并清理失效的临时 PVE 状态；
- 当前受信动态代码仍留在只读 bundled Base，新执行原语仍要求更新本体；
- 安装、激活、Profile pin、PVE Runner 和工具链必须分阶段落地，RED-113 不会改变运行时行为。

## 验证方式

- strict schemas 对所有合法文档和八类节点 fixture 成功，对未知字段、未知 discriminant、非法路径、
  非规范 hash、表达式和 inline code/effect 失败；
- snapshot/patch 联合、Patch target 唯一性、expectedHash、Profile provenance 与双 identity 投影的局部
  不变量有测试；纯 raster 变化只改变 full Profile identity，权威 JSON 变化必须改变 authority identity；
- PVE Campaign/节点/Run/checkpoint/receipt 的局部不变量有测试；
- 阶段 2 使用 golden vectors 锁定 canonical package/full-profile/authority-content hash、Ed25519 消息
  和篡改矩阵；
- 后续阶段分别验证原子激活、权威 hash 变化时清临时 PVE 状态、Client/Server 权威内容一致、房间
  硬握手、Trace 固定、PVE exactly-once 与 Windows Candidate；
- RED-113 合并前确认没有现有 loader、PVE 页面、房间或存档接入新 schema，运行时行为保持不变。

## 回退方式

RED-114 接入前可以整体 revert RED-113；该阶段不写活动指针、不生成玩家数据、不迁移资源包或 PVE
Run。后续阶段已经消费合同后，必须先按依赖逆序回退消费者，再回退 schema。若 v1 identity 已被对外
包、存档或回放引用，只能新增版本或迁移任务，不能重写 v1 canonical/hash/signature 语义。

## 相关资料

- Linear：RED-111、RED-113
- `docs/technical/CONTENT_PIPELINE_V1_CONTRACT.md`
- `docs/technical/DYNAMIC_CODE_RUNTIME.md`
- `docs/decisions/ADR-0002-electron-resource-pack-ipc-trust.md`
- `docs/decisions/ADR-0016-trace-v2-recorded-state-replay.md`
