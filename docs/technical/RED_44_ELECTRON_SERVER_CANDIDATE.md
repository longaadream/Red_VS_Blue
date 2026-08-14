# RED-44：Electron Server 内部候选验证记录

状态：实现候选，等待独立审查与人工验收

验证时间：2026-08-14（Asia/Shanghai）

风险：Medium

决策边界：[`ADR-0003`](../decisions/ADR-0003-electron-server-packaging.md)。本记录中的
`win-unpacked` 只用于开发与 QA；**内部候选 ≠ 公开发行物**。

## 基线与环境

- 基线 commit：`04e7301dcf911a2140e44fdb23378657971ab898`
- 系统：Windows 10 `10.0.19045`，x64
- Node.js：`v24.19.0`
- npm：`11.17.0`
- Electron：`43.4.0`
- electron-builder：`26.15.3`
- 候选绝对路径：
  `C:\Users\Administrator\Documents\GitHub\Red_VS_Blue\dist\server-build\win-unpacked`
- manifest 绝对路径：
  `C:\Users\Administrator\Documents\GitHub\Red_VS_Blue\dist\server-build\server-candidate-manifest.json`
- Authenticode：`NotSigned`；builder 配置没有签名或 publish 配置。

## 候选资源证据

最终 `source-comparison` 与 staging 清理后的 `manifest-replay` 得到相同结果：

| 对象 | 文件数 | 大小（bytes） | SHA-256 |
| --- | ---: | ---: | --- |
| `win-unpacked/resources` | 2,033 | 191,107,197 | `ebd63bef294552525dfb6030e070e4f29c48142ab428fdef62e4489701b4eb7d` |
| `RED vs BLUE Server.exe` | 1 | 225,533,440 | `52b9d7405c98d5a3d5db8eb80b68d837f19cf783bb20d726627992778424d83e` |
| `resources/node.exe` | 1 | 92,825,416 | `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237` |
| `server-candidate-manifest.json` | 1 | 425,955 | `1ef5ba959163d8b8020271a8404407c8062652b5cd9ae8ed56e0fcc1cf2da620` |

manifest 列出每个资源的相对路径、大小与 SHA-256，并显式包含 Electron main/管理面板、
`standalone/server.js`、`.next/static`、standalone Node 依赖、`public`、`data`、`prisma`、
`init-db.js`、`adm-zip` 与独立 `node.exe`。验证器还拒绝 `resources/app/node_modules`
中除 `adm-zip` 外的顶层依赖。

构建成功后：

- `_client-stage`：不存在；
- `_client-node`：不存在；
- 3000 监听进程数：0；
- manifest 独立回放：退出码 0。

## Smoke JSON

`node tests/electron/windows-smoke.mjs server` 退出码 0：

```json
{
  "entry": "server",
  "rendererBoundary": {
    "title": "RED vs BLUE Server",
    "processType": "undefined",
    "requireType": "undefined",
    "url": "file:///C:/Users/Administrator/Documents/GitHub/Red_VS_Blue/dist/server-build/win-unpacked/resources/app/electron/dashboard/index.html"
  },
  "rejectedNavigation": {
    "original": "file:///C:/Users/Administrator/Documents/GitHub/Red_VS_Blue/dist/server-build/win-unpacked/resources/app/electron/dashboard/index.html",
    "current": "file:///C:/Users/Administrator/Documents/GitHub/Red_VS_Blue/dist/server-build/win-unpacked/resources/app/electron/dashboard/index.html"
  },
  "stopped": true,
  "port3000Reachable": false,
  "helperProcessCountsAfterStop": {
    "C:\\Users\\Administrator\\Documents\\GitHub\\Red_VS_Blue\\dist\\server-build\\win-unpacked\\resources\\node.exe": 0
  },
  "exitedCleanly": true,
  "processCountsAfterExit": {
    "C:\\Users\\Administrator\\Documents\\GitHub\\Red_VS_Blue\\dist\\server-build\\win-unpacked\\RED vs BLUE Server.exe": 0,
    "C:\\Users\\Administrator\\Documents\\GitHub\\Red_VS_Blue\\dist\\server-build\\win-unpacked\\resources\\node.exe": 0
  }
}
```

## 命令与退出码

| 顺序 | 命令 | 最终退出码 | 结果摘要 |
| ---: | --- | ---: | --- |
| 1 | `npm.cmd ci` | 0 | 安装 942 个包；npm 报告 1 high，依赖升级不在 RED-44 范围 |
| 2 | `npm.cmd run test -- tests/electron/security-boundary.test.ts` | 0 | 18/18 通过 |
| 3 | `npx.cmd tsc --noEmit` | 0 | 首次因新 fixture helper 只接受 string 而退出 1；改为 `string \| Buffer` 后复验通过 |
| 4 | `npx.cmd tsc -p electron/tsconfig.json --noEmit` | 0 | 通过 |
| 5 | `npx.cmd eslint scripts/verify-electron-server-package.js tests/electron/server-package-verifier.test.ts tests/electron/windows-smoke.mjs` | 0 | 通过 |
| 6 | `npm.cmd run check:encoding` | 0 | 494 个文本文件通过 |
| 7 | `npm.cmd run build:electron:server` | 0 | 最终构建、源树验证和 cleanup 通过 |
| 8 | `node scripts/verify-electron-server-package.js` | 0 | staging 清理后的 manifest 回放通过 |
| 9 | `node tests/electron/windows-smoke.mjs server` | 0 | 安全、导航、启停、端口和进程断言通过 |
| 10 | `git diff --check` | 0 | 通过 |
| 补充 | `npm.cmd run test -- tests/electron/server-package-verifier.test.ts` | 0 | 5/5 通过；覆盖缺失、过期、越界依赖、分发边界、manifest 与篡改 |
| 补充 | `npm.cmd test` | 0 | 10 个测试文件、102/102 通过 |

真实构建第一次运行验证器时退出 1：builder 的通用 `_client-stage` 映射没有复制嵌套
`node_modules`，而旧验证仅检查 `server.js`，未发现该漏包。RED-44 在 Server builder 中增加
`_client-stage/node_modules -> app/standalone/node_modules` 的显式映射；重新构建后 1,620 个
staging 文件均进入预期路径，最终验证通过。共用 staging/cleanup 没有修改，因此没有触发
Client 构建链变更。

## 已知警告与回退

- Next 报告 `middleware` 文件约定弃用，以及 `lib/resource-pack.ts` 两处动态文件访问会扩大
  tracing；这是现有构建警告，RED-44 没有修改相关代码。
- electron-builder 报告 `asar: false`、默认图标和重复依赖引用；这些是 ADR-0003 已记录的
  内部候选边界，不能把本候选描述为公开发布包。
- `npm ci` 报告 1 个 high 漏洞；RED-44 禁止升级依赖，不能描述为 audit 全绿。
- 回退 RED-44 的独立提交即可移除 Server 验证器、显式 standalone 依赖映射、测试和文档，
  恢复到 RED-23 决策时的显式 `dir` 构建入口。回退不会修改依赖、Client/Editor、游戏规则、
  协议、端口策略或存档格式。
