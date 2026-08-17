# ESLint 零新增门禁与历史基线（RED-88）

状态：实现候选
日期：2026-08-17
关联任务：[RED-88](https://linear.app/redvsblue/issue/RED-88/建立-eslint-零新增门禁并冻结历史违规基线)
风险：Medium

## 目标

`npm run lint` 是“零新增违规”门禁，不是“历史技术债已经全部修复”的声明。

ESLint 9 的 bulk suppression 以 `eslint-suppressions.json` 记录当前存量。普通 lint 会应用该文件：存量不重复报错，新增违规仍会失败；存量被修复后，未使用的 suppression 会让 lint 失败，要求同步 prune。

## 2026-08-17 初始证据

最新 `main`（包含 RED-80）直接运行 ESLint 的基线为：

- 639 errors、334 warnings，共 973 项；
- 90 个文件；
- 主要规则为 `no-explicit-any` 555、`no-unused-expressions` 211、`no-unused-vars` 112、`no-require-imports` 66。

RED-88 做了三类治理：

1. `data/pages/js/game-engine.js` 有 189 项，但它由 `npm run build:game-engine` 从 TypeScript 源码生成，因此排除该产物，继续检查其源代码和构建脚本。
2. 删除 4 条 ESLint 已确认无效的行级 disable 注释；只删除注释，不修改运行时代码。
3. 将原 warning 规则提升为 error，并用官方 suppression 记录剩余存量。

提交的 suppression 基线为 780 项、89 个文件、118 个“文件 + 规则”桶：

| 规则 | 数量 |
| --- | ---: |
| `@typescript-eslint/no-explicit-any` | 555 |
| `@typescript-eslint/no-unused-vars` | 81 |
| `@typescript-eslint/no-require-imports` | 66 |
| `@typescript-eslint/no-unused-expressions` | 53 |
| `prefer-const` | 8 |
| `import/no-anonymous-default-export` | 5 |
| `react-hooks/set-state-in-effect` | 4 |
| `@next/next/no-img-element` | 2 |
| `@typescript-eslint/no-this-alias` | 2 |
| `react/no-unescaped-entities` | 2 |
| `@typescript-eslint/no-unsafe-function-type` | 1 |
| `react-hooks/purity` | 1 |

## 日常使用

每个 PR 必须运行：

```powershell
npm.cmd run lint
```

预期结果：退出码 0，0 errors，0 warnings。

如果本次修改真正修复了历史违规，普通 lint 会提示存在 stale/unused suppression。此时运行：

```powershell
npm.cmd run lint:prune
npm.cmd run lint
```

必须把更新后的 `eslint-suppressions.json` 与修复一起提交。suppression 只能减少；禁止为了让新违规通过而直接运行 `--suppress-all` 或增加 suppression，除非有独立、人工批准的基线迁移任务。

## 生成文件边界

`data/pages/js/game-engine.js` 的唯一维护方式是：

```powershell
npm.cmd run build:game-engine
```

构建脚本为 `scripts/build-game-engine.js`，可维护源代码位于 `lib/game/**` 等 TypeScript 模块。Android 的 `android-client/www/js/game-engine.js` 镜像此前已经排除。

`data/pages/js/crypto-lib.js` 没有被 RED-88 排除：当前 `build:crypto-lib` 只明确生成 Android 路径，不能把页面版本未经证据地视为同一生成物。

## suppression 的限制

ESLint suppression 按文件和规则记录数量，不定位到某一行。因此：

- 新文件或原本干净的规则出现违规会立即失败；
- 同一文件、同一规则的违规数量增加会失败；
- 修复导致数量减少时会要求 prune；
- suppression 不是永久免责，也不能代替逐项检查具体代码。

后续清债顺序：

1. React Hooks 规则；
2. 游戏状态、动态 SkillCode 边界的 `any`；
3. 服务端和移动端模块边界；
4. 测试与旧构建脚本。

最终目标是让 `eslint-suppressions.json` 为空并删除它。

## 回退

整体 revert RED-88 的配置、脚本、suppression 和文档即可恢复旧 lint 输出。回退不涉及游戏状态、玩法数据或不可逆写入。
