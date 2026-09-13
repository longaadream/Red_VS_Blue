# RED-181 最新主线合并

用户已授权解决与最新 main 的冲突。base_branch: main；2026-09-13 fetch 后 base_sha: `554f3fb16823fe4e6f6122da1c32872e9584c8a7`。PVE 原分支 HEAD：`ee29674`。使用 merge 保留历史，在独立 worktree 操作，原目录未提交的签名及编辑器文件不变。不发布、不修改密钥。

风险 Medium：合并服务入口、生成引擎与构建脚本，并检查自动合并的表现、资源租约。验收要求：未合并路径清零；双端宿主及浏览器引擎构建；相关回归、类型和 lint；独立复审。

## 冲突处理

- Colyseus 同时注册 PVP 和 PVE 房间，两者均计入主线更新保护；PVE 创建失败或销毁释放更新占用。
- Android 同时注入宿主发现与 SQLite 冒险仓库。
- package.json 保留 0.1.1 版本、主线同步发布命令和 PVE 构建命令。
- game-engine.js、practice/engine.js 从合并后的源码重建，并同步生成 adventure/engine.js，不手工拼接压缩代码。
- 主线 PostgreSQL 异步测试的 Buffer 类型收窄为实际 readFile 返回类型，避免新 Node 类型声明下编译失败。

## 验证

- 14 文件、84 项回归通过：PVE/PVP 房间、Android SQLite、宿主发现、资源租约、技能表现、镜头和教程。新增真实 SDK 测试覆盖更新期间禁止创建 PVE 房间、房间存在时禁止更新、销毁后允许更新。
- 全项目 TypeScript 与 ESLint 通过。浏览器/PVP AI/PVE 引擎、桌面 Colyseus、Android 双架构宿主构建通过。
- 隔离目录首次缺少 Android Node / PostgreSQL 运行时，已接入原目录现有只读运行时重新验证，不下载或更换运行时版本。
- 独立只读复审未发现阻断项，确认 Android 仓库/发现、PVE 资源租约及主线技能表现链均保留。
- 日志：隔离目录 `output/main-sync/`。原分支旧包不代表这次主线合并后的客户端验收，最终客户端需另行重新打包。
- `git diff --cached --check` 对主线引入的生成文件 `electron-editor/ui/code-ide.js` 报告模板字符串内行尾空白；该文件与 main 完全一致，不修改字符串内容来消除提示。冲突处理相对 main 的差异单独检查。

回退使用普通 revert 撤销合并及相关修复，不改写共享分支历史，不删除存档。
