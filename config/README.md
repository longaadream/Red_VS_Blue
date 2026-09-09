# 开发与打包配置

以下命令均从仓库根目录运行。

| 文件 | 用途与入口 |
| --- | --- |
| [colyseus.config.ts](colyseus.config.ts) | 对局开发服务；`npm.cmd run dev:colyseus` |
| [docker-compose.colyseus.yml](docker-compose.colyseus.yml) | 本机 PostgreSQL；`docker compose --project-directory . -f config/docker-compose.colyseus.yml up -d postgres` |
| [electron-builder.client.json](electron-builder.client.json) | Windows 游戏客户端打包；`npm.cmd run build:electron:client` |
| [electron-builder.editor.json](electron-builder.editor.json) | 内容编辑器打包；`npm.cmd run build:electron:editor` |
| [branding/](branding/) | 客户端程序图标及其源文件 |

Compose 命令保留 `--project-directory .`，避免目录迁移改变默认项目名和数据库卷。Electron Builder 配置中的资源路径仍以仓库根目录为基准。

完整环境说明见 [构建与运行](../docs/technical/BUILD_AND_RUN.md)。
