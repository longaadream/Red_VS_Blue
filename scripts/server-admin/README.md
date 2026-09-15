# 服务器管理

从仓库目录启动：

```powershell
node scripts/server-admin/admin.mjs
```

打开终端输出的完整链接。界面只监听本机，链接携带临时会话令牌；退出进程即关闭管理入口。需要本机安装 OpenSSH，私钥已绑定服务器，且服务器指纹已通过正常 SSH 登录确认。不要关闭主机密钥验证。

填写服务器、密钥路径、服务及真实数据库名称，点击“查看状态与版本”。工具不会保存密钥内容或数据库密码。备份保存在服务器 `/var/backups/rvb`，应另行下载到安全位置作为异地备份。

## 更新游戏服务与资源

1. `node scripts/build-linux-room-server.mjs` 构建包含资源和引擎的完整目录。
2. 在界面填写该目录和新版本名称，校验并上传。版本名称不能重复，上传不会立即生效。上传中断时保留不完整候选供检查，请使用新名称重试。
3. 确认没有进行中的对局、新旧版本不涉及数据库迁移。勾选维护确认，再启用版本。工具不会自动排空房间。
4. 工具停服、备份数据库、切换链接、启动，检查进程与端口；失败尝试恢复旧链接。成功后仍需实际建房/开局验收。
5. 回退使用相同入口，填写旧版本名称。数据库不回退；涉及 schema 或存档不兼容的版本不能使用此方式。

服务必须使用对应链接启动：`rvb-game` → `/opt/rvb/current/colyseus-server.mjs`；`rvb-relay` → `/opt/rvb/relay-current/relay.mjs`；`rvb-official` → `/opt/rvb/official-current/official-server.mjs`。旧链接必须指向 `/opt/rvb/releases/` 内的版本。工具不会改写 systemd 配置；未完成初次配置会拒绝切换。目前转发服务仍使用固定目录，排位尚未部署。

候选必须有 `SHA256SUMS`，每行 `SHA256<两个空格>相对文件名`，必须覆盖所有文件（清单本身除外）；拒绝符号链接、越界路径和额外文件。仅部署自己构建并审查的代码；清单校验不是发布者签名。

## 命令行

将界面相同字段写入本机 JSON 文件（不包含密码），运行：

```powershell
node scripts/server-admin/admin.mjs cli C:\path\operation.json
```

字段：`host`, `port`, `user`, `key`（私钥路径）, `service`, `database`, `action`（status/logs/backup/stage/activate）。stage 另需 `directory`, `release`；activate 另需 `release`, `maintenance: true`。命令失败返回非零退出码。操作超时不能证明远程停止，先查询服务状态后再操作。

备份仅包含 PostgreSQL 数据库，不包含私有配置和用户目录。工具不运行数据库迁移、不恢复数据库、不管理证书、不上传客户端安装包，不改变现有资源包签名规则。

## 完整指挥台
默认入口复用原官方指挥台的八个栏目；服务器运维入口位于左侧导航。运维页填写同一SSH连接和远程指挥台的回环端口、会话令牌后，运营请求通过SSH转发，管理端口不对公网开放。令牌来自远程指挥台启动时给出的URL，重启后会变化。香港排位尚未部署，不能仅凭本面板获得账号/赛季数据。原备份恢复和SMTP配置仍依赖服务端operations实现，不能用此代理把Windows专用恢复变成Linux恢复。
