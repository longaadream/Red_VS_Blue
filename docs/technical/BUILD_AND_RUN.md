
# 构建与运行验证

## RED-18：electron-builder 26.15.3 候选验证

验证日期：2026-08-13

验证环境：Windows 10.0.19045、Node.js 24.19.0、npm 11.17.0

验证分支：`codex/red-18-electron-builder-upgrade`

### 依赖安装与审计

```powershell
npm.cmd ci
npm.cmd audit --json
npm.cmd ls electron-builder app-builder-lib builder-util node-gyp tar tmp form-data --all
```

- `npm ci`：退出码 0，安装 738 个包。
- 升级前 audit：32 项（1 critical、29 high、1 moderate、1 low）。
- 升级后 audit：17 项（1 critical、15 high、1 moderate）。
- 升级后不再报告 `electron-builder`、`app-builder-lib`、`builder-util`、`builder-util-runtime`、`@electron/rebuild`、`node-gyp`、`tmp` 或 `form-data` 漏洞。
- 仍报告的 `tar` 位于根 `node_modules/tar@6.2.1`，修复建议指向 `@capacitor/cli@8.5.0`；它不在 electron-builder 依赖链中，属于 RED-18 明确排除的 Android/Capacitor 升级范围。

升级后的关键构建依赖为：

- `electron-builder@26.15.3`
- `app-builder-lib@26.15.3`
- `builder-util@26.15.3`
- `builder-util-runtime@9.7.0`
- `@electron/rebuild@4.2.0`
- `node-gyp@12.4.0`，其内部使用 `tar@7.5.22`
- `tmp@0.2.7`
- `form-data@4.0.6`

锁文件节点由 917 个变为 845 个：新增 65 个、移除 137 个、版本变化 39 个。这些变化来自 electron-builder 25 到 26 的构建依赖树替换；未修改其他直接依赖声明。

### Electron 客户端

```powershell
npm.cmd run build:electron:client
```

结果：退出码 0，耗时 88.9 秒。`electron-builder 26.15.3` 生成 Windows x64 unpacked 目录：

- `dist/client-build/win-unpacked/RED vs BLUE.exe`
- EXE SHA-256：`615af01fe4445068ee344f21a7f8186445949f17e45b0cb5e1132e4cf849f644`

已验证以下资源仍存在：

- `resources/app/electron-client/dist/main.js`
- `resources/app/standalone/server.js`
- `resources/app/public`
- `resources/app/data`
- `resources/app/prisma`
- `resources/app/www`
- `resources/app/init-db.js`
- `resources/node.exe`

产物结构与 `electron-builder.client.json` 一致：继续使用 `asar: false` 和 Windows `dir` 目标，没有生成安装器。

### Electron 编辑器

```powershell
npm.cmd run build:electron:editor
```

首次结果：退出码 1。TypeScript 编译、Windows x64 unpacked 打包成功，随后下载 portable 辅助资源时连接 GitHub 超时（`ETIMEDOUT`）。

单次网络重试：退出码 1。NSIS 与 7zip 辅助资源下载成功，之后连接被重置（`ECONNRESET`），未生成最终 `dist/editor/RED vs BLUE Editor 0.1.0.exe`。

2026-08-13 在辅助资源已缓存后再次执行：退出码 0，耗时 533.6 秒，最终 portable EXE 生成成功。

最终产物：

- `dist/editor/RED vs BLUE Editor 0.1.0.exe`
- 文件大小：137,680,764 bytes
- SHA-256：`30ce82535c920d9bbedeb1e300e8c34a91d5a9e292a35620b07a8d2d48a0fe8b`

已验证的 unpacked 产物与资源：

- `dist/editor/win-unpacked/RED vs BLUE Editor.exe`
- EXE SHA-256：`22116c92edfc7e172c5ca1c1c7ae1121f4e54276725c0d4e88e2090709634b35`
- `resources/app/electron-editor/dist/main.js`
- `resources/app/data`
- `resources/app/scripts`
- `resources/app/package.json`

配置仍使用 `asar: false` 和 Windows `portable` 目标。编辑器打包入口已标记为通过；首次构建机仍需要访问 GitHub 下载 NSIS、7zip、NSIS resources 和 winCodeSign 辅助资源。

### Electron 服务端

```powershell
npm.cmd run build:electron:server
```

结果：退出码 1，npm 报告 `Missing script: "build:electron:server"`。当前重构基线只保留 `dev:electron:server`；`build:electron:server` 与 `electron-builder.server.json` 已在基线提交 `ac9b3bf` 中移除。

经项目负责人批准，RED-18 只验收当前存在的 client/editor 打包入口，不恢复服务端入口。是否恢复独立服务端桌面包由 Linear `RED-23` 单独评估；该任务只做架构决策，不在 RED-18 顺带实现。

### 签名与回退

两个现有 builder 配置都没有证书、发布或安装器签名配置。本次未修改 `electron-builder.client.json` 或 `electron-builder.editor.json`。日志中的 `signing with signtool.exe` 是 electron-builder 对 Windows 可执行文件的处理步骤；PowerShell `Get-AuthenticodeSignature` 对 portable 和 unpacked editor EXE 均返回 `NotSigned`，确认没有配置发行证书。

### 其他检查

- `npm.cmd run test`：首次因隔离 worktree 的沙箱禁止创建 `logs/` 而有 7 个 `EPERM` 失败；允许正常写入该目录后重跑，退出码 0，3 个测试文件、29 个测试全部通过。
- `npm.cmd run check:encoding`：退出码 0，483 个文本文件通过。
- `npm.cmd run lint`：退出码 1，`eslint` 命令不存在。当前 `package.json` 声明了 lint 脚本但没有 ESLint 依赖；这是现有基线缺口，RED-18 不增加范围外依赖。

回退时还原 RED-18 的独立提交，即可同时恢复 `package.json` 中旧版 builder 声明和对应 `package-lock.json` 构建依赖树。构建产物不提交到仓库。
