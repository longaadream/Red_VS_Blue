# 服务器管理

Windows 检出或解压的远程脚本会在发送前移除 UTF-8 BOM，并将 CRLF/CR 换行规范化为 LF，避免 Linux Bash 解析失败。更新便携包后需关闭旧管理进程并重新运行 start.cmd。

RED-248 统一入口采用现代运维布局。工具版本显示为 `RED-248.1`；它与远端服务版本是两回事。截图中的 Bash `set` / `case` 报错与未规范化换行相符，但不代表正在运行的旧进程会随文件更新自动生效。新版对实际执行边界进行了回归验证；真实服务器仍需重新运行工具后查询确认。

从仓库目录启动：

```powershell
node scripts/server-admin/admin.mjs
```

打开终端输出的完整链接。界面只监听本机，链接携带临时会话令牌；退出进程即关闭管理入口。需要本机安装 OpenSSH，私钥已绑定服务器，且服务器指纹已通过正常 SSH 登录确认。不要关闭主机密钥验证。

填写服务器、密钥路径、服务及真实数据库名称，点击“查看状态与版本”。连接配置保存在 `%LOCALAPPDATA%/RedVsBlue/server-admin/connection.json`（非 Windows 为用户 `.config` 下同名目录）；仅包含地址、端口、用户名、密钥路径、服务和数据库名称。管理令牌只保留于当前进程，不保存密钥内容或数据库密码。备份保存在服务器 `/var/backups/rvb`，应另行下载到安全位置作为异地备份。

## 更新游戏服务与资源

1. `node scripts/build-linux-room-server.mjs` 构建包含资源和引擎的完整目录。
2. 在界面填写该目录和新版本名称，校验并上传。版本名称不能重复，上传不会立即生效。上传中断时保留不完整候选供检查，请使用新名称重试。
3. 确认没有进行中的对局、新旧版本不涉及数据库迁移。勾选维护确认，再启用版本。工具不会自动排空房间。
4. 工具停服、备份数据库、切换链接、启动，检查进程与端口；失败尝试恢复旧链接。成功后仍需实际建房/开局验收。
5. 回退使用相同入口，填写旧版本名称。数据库不回退；涉及 schema 或存档不兼容的版本不能使用此方式。

服务必须使用对应链接启动：`rvb-game` → `/opt/rvb/current/colyseus-server.mjs`；`rvb-relay` → `/opt/rvb/relay-current/relay.mjs`；`rvb-official` → `/opt/rvb/official-current/official-server.mjs`。旧链接必须指向 `/opt/rvb/releases/` 内的版本。工具不会改写 systemd 配置；未完成初次配置会拒绝切换。服务是否已经部署、是否健康，以实际查询为准。

候选必须有 `SHA256SUMS`，每行 `SHA256<两个空格>相对文件名`，必须覆盖所有文件（清单本身除外）；拒绝符号链接、越界路径和额外文件。仅部署自己构建并审查的代码；清单校验不是发布者签名。

## 命令行

将界面相同字段写入本机 JSON 文件（不包含密码），运行：

```powershell
node scripts/server-admin/admin.mjs cli C:\path\operation.json
```

字段：`host`, `port`, `user`, `key`（私钥路径）, `service`, `database`, `action`（status/logs/backup/stage/activate）。stage 另需 `directory`, `release`；activate 另需 `release`, `maintenance: true`。命令失败返回非零退出码。操作超时不能证明远程停止，先查询服务状态后再操作。

备份仅包含 PostgreSQL 数据库，不包含私有配置和用户目录。工具不运行数据库迁移、不恢复数据库、不管理证书、不上传客户端安装包，不改变现有资源包签名规则。

## 完整指挥台
默认入口复用官方指挥台的运营栏目，SSH 运维与连接位于同一导航。连接时自动通过 SSH 读取 `/var/lib/rvb-official/control-panel.url`，也可手工填写该 URL 的回环端口和会话令牌。运营请求通过 SSH 转发，管理端口不对公网开放。远端重启后令牌会变化，需重新连接。原备份恢复和 SMTP 配置仍依赖服务端 operations 实现，不能用此代理把 Windows 专用恢复变成 Linux 恢复。

新服务器在 snapshot 中报告功能能力；旧服务器缺少动态地图目录或社区新功能时，仅对应功能提示升级。HTTP 错误状态经过 SSH 代理保留。地图池读取服务器实际加载的资源目录；新增地图默认不勾选，非排位地图注明原因。已启用地图失效后停止创建新排位，必须重新保存至少三张有效地图；不会自动替换。资源目录沿用服务启动时的加载边界，不在此工具中新增热切包能力。

社区审核提供关键词、状态筛选、分页、隐藏和恢复。恢复不撤销作者删除；所有写操作继续要求原因并记录审计。公告沿用单条官方纯文本公告。

## 生成本机便携候选

```powershell
node scripts/server-admin/package.mjs
```

输出至 `dist/server-admin-RED-248.1`，拒绝覆盖非空目录。目录包含 Node 运行时、`start.cmd`、面板资源、构建身份和 SHA256 清单；仍需系统 OpenSSH。这是本机候选构建，不上传或发布。更新后先关闭旧工具进程，再从新目录启动。
