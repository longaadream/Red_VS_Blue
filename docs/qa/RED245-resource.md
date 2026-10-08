# RED-245 资源包 1.0.12 / 客户端 0.1.13 配套验证

## 范围与基线

- `base_branch`: `main`
- `base_sha`: `9d1b0c30801cd733ec4cede37ce1ef0889a2313a`
- 工作分支：`codex/RED-245-release-0.1.13`
- 内容来源提交：`c7003af49214909cadc5ee4aa955be1b2734e86d`
- 风险：Medium。只生成本地签名资源候选，不公开上传，不修改生产代码、依赖、秘密或 tracked 游戏数据。

## 最终产物

- source：`output/RED245/resource/source-1.0.12-safe`
- pack：`output/RED245/resource/content.rvbpack`
- 清单：`output/RED245/resource/content-update.json`
- 本地 helper 验证凭据：`output/RED245/resource/verification.json`（`{"ok":true,"signatureVerified":true}`）
- 草稿 tag 资料：`output/RED245/resource/draft-release.json`
- 草稿说明：`output/RED245/resource/release-notes.md`
- 内容 hash / `packageHash`：`25b673f202e1b9eeace0fce32398439c3178c7b128b23a32b3710e5c7e6d2346`
- 归档 SHA-256：`1b9f3625476ff0c9df1f12b7c66a0ae7c2e4cae6d4583299b33b1ee39d25e760`
- `resolvedProfileHash`：`56211560292d9088c7ec0d1a97e0af86725fb63cd5ed2b16b4a1fd38bd24e3dd`
- `authorityContentHash`：`a46408509276fbb3a96d58bc2a8b6a0b0792775040f8f7ee63375f022c658fd2`
- 发布者 `keyId`：`2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e`
- 最低客户端版本：`0.1.13`

staging 使用当前仓库 `data`，排除 `data/pages` 和仓库明确禁止分发的开发账号 `data/users.json`；图片从公开 `content-test-076ff9eb2da5e4bd80caa780e745c0ea02385c768940f3234a7d4e5e4bc0c784`（1.0.11）继承。最终包含 477 个 data 文件和 23 张图片，共 502 个归档条目（含 manifest/signature）；包内没有 `data/pages` 或 `data/users.json`。

相对 1.0.11 的语义差异记录在 `output/RED245/resource/verification/content-diff.json`：新增 2 个 data 文件，删除 0 个，变更 22 个；涉及 16 个 JSON 文件、47 个字段差异。图片记录在同一目录的 `content-verification.json`，23/23 缺失为 0、摘要不一致为 0，并逐字节匹配旧公开包。未签名的早期候选已弃用。

## 验证证据

canonical `rvb` 证据目录：`output/RED245/resource/evidence/RED-245/`。

- build：PASS，`20261008T163305775Z-build-111256-9c0b829d-dcc0-4dca-8de7-36fde56ca0f6/report.json`
- sign：PASS，`20261008T163310758Z-sign-87480-1a0cffbf-253f-47ac-a7b8-269bd3358e7e/report.json`
- validate：PASS，`20261008T163320231Z-validate-85664-56fb6266-fdfa-450f-8bb9-e4e0385ae499/report.json`
- resolve：PASS，`20261008T163324403Z-resolve-6944-ce49aa3e-ab23-4684-957b-8b35258caac3/report.json`
- smoke：PASS，固定 seed `245`，`20261008T163329198Z-smoke-74944-1d96fd82-500d-4203-99d1-a464c75a4991/report.json`
- `node scripts/check-resource-history.mjs output/RED245/resource/content.rvbpack`：PASS，33/33 历史记录
- 归档/清单一致性检查：PASS，清单 hash 与归档 SHA-256 一致，签名 snapshot envelope 完整，禁止路径为空

smoke 通过隔离 runtime 安装并绑定候选 profile 后执行实际 PVE 流程，最终 `terminalOutcome` 为 `victory`，最终 `finalRunHash` 记录在 smoke report 中。

## 规则回归

执行的 10 个历史/角色行为测试文件共 91 项，全部通过：Grimmjow、Colt、Shadow、RED-227、Akaza、Ichigo/Aizen 相关位移与技能回归。

额外执行包含 `tests/game/ichigo-itachi.test.ts` 的 11 个文件共 107 项时，106 项通过、1 项失败。失败是现有测试对 `data/skills/ichigo-zangetsu.json` 的旧描述断言，与当前候选 data 的实际描述不一致；本次按任务要求以当前 data 为准，未修改生产 data 或测试。

## 发布边界与回退

本次没有执行 GitHub、COS 或其他公开上传。回退方式为丢弃本地 `output/RED245/resource` 候选并继续使用 1.0.11；若后续公开发布，必须使用上述 hash 对资产逐项核对，且继续保持 1.0.12 完整 snapshot 不变。

未生成 `public-verification.json`，因为当前资源仍是本地草稿，尚无公开 Release receipt；`prepare-cos-update-source.mjs` 只有在真实公开 receipt 存在后才能继续准备镜像。

草稿 tag 为 `content-test-25b673f202e1b9eeace0fce32398439c3178c7b128b23a32b3710e5c7e6d2346`，资料标记为 `draft: true`、`prerelease: true`、`makeLatest: false`；创建远端草稿前仍需用最终 source commit 更新并核对清单。


## 可选差量补丁（本地草稿）

本节只记录独立的 1.0.11→1.0.12 patch，不改变既有 full snapshot 或 `output/RED245/resource/content-update.json`。补丁源目录为 `output/RED245/resource-delta/patch-source`，包含 24 个 data 操作（add 2、replace 22、remove 0）；图片不进入操作，继续由 1.0.11 的 23 张图片继承。

- patch：`output/RED245/resource-delta/content-patch.rvbpack`，31865 bytes，archive SHA-256 `387ce679595ad55a33ac0fe98b2f2cd494b6d9f84960010b0daf2eab4dd7072b`
- patch 签名 identity/packageHash：`796f082bfb8e376eba64a00554653096ecbecb7ce7f46fbec714178eba63a16c`
- `parentProfileHash`：1.0.11 的 `13988cfa03263f65365bbea66ee28e5ab7733b084712e74f472fce584c148aa8`
- patch chain `resolvedProfileHash`：`c0c32aca66f27beeaf9eeb8eb7ee50553e3856094dfc4dda4b8e8933c1a897a8`
- patch chain `authorityContentHash`：`a46408509276fbb3a96d58bc2a8b6a0b0792775040f8f7ee63375f022c658fd2`，与 full 1.0.12 一致；patch chain 与 full snapshot 的 resolved hash 不同是来源 provenance 不同造成的，不能混用
- 重建等价证据：`output/RED245/resource-delta/reconstruction.json`，500/500 payload 文件路径、descriptor、字节一致；隔离安装证据：`output/RED245/resource-delta/isolated-installation.json`
- 详细验证：`output/RED245/resource-delta/patch-verification.json`；本地 helper 格式 `verification.json` 为 `{"ok":true,"signatureVerified":true}`。没有生成 `public-verification.json`。

canonical delta 证据在 `output/RED245/resource-delta/evidence/RED-245/`：build、sign、validate（带 1.0.11 base）、resolve、smoke 均 PASS；seed 245 smoke 为 victory。现有客户端 updater 支持 `patch.archive`、`patch.sha256`、`patch.parentProfileHash`、`patch.resolvedProfileHash`，要求父 profile 精确匹配，下载/安装失败回退 full；draft release 不会被自动发现。测试覆盖见 `tests/electron/official-updates.test.ts` 的 patch 选择与回退用例（focused 3/3 PASS）以及 `tests/electron/resource-release.test.ts` 的自动 patch 生成链（3/3 PASS）。

补丁草稿片段为 `output/RED245/resource-delta/draft-patch-fragment.json`，与 full 同 tag `content-test-25b673f202e1b9eeace0fce32398439c3178c7b128b23a32b3710e5c7e6d2346`，标记 `draft: true`、`prerelease: true`、`makeLatest: false`；没有上传或公开发布。后续若决定公开，需由发布流程生成包含该 patch 字段的全新清单并取得真实 public receipt，不能直接把本地片段当成公开清单。

完整 `tests/electron/official-updates.test.ts` 为 33/34；唯一失败是既有 COS 外链拒绝断言（当前 COS 分支按镜像根地址构造资源 URL，与本地 patch / GitHub updater 无关），本次未改 updater 生产代码。

## COS 差量准备门禁

`prepare-cos-update-source.mjs` 支持完整 snapshot 清单中的可选 canonical `patch` 字段，并会把经校验的 `content-patch.rvbpack` 复制到 `resource/<version>/` 和 `resource/latest.json` 的资产列表。该路径仍要求完整 snapshot 的签名、校验和、客户端 full fallback 及真实公开资源 receipt；receipt 必须逐字节匹配 patch 的摘要和大小。当前资源仍是本地 draft，COS 草稿 staging 在 `output/RED245/resource-delta/cos-draft/`，没有真实 receipt，因此本轮没有上传、公开发布或生成 `public-verification.json`。
