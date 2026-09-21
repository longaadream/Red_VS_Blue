# RvB 部署 SOP

## 概述

本文档描述如何部署 RvB 游戏服务器引擎和资源包到生产环境。

## 前置条件

- 已构建的服务器引擎包（`linux-room-server/candidate-*/`）
- 已签名的资源包（`signed-*.rvbpack`）
- `install-profile.cjs` 脚本
- `content-script-publishers.json` 配置文件
- SSH 访问权限到目标服务器

## 部署流程

### 1. 准备部署脚本

确保 `output/` 目录包含以下文件：

- `scp-108.sh` - 上传脚本
- `deploy-108.sh` - 部署脚本  
- `install-profile-0112.cjs` - 资源包安装器
- `signed-1.0.8.rvbpack` - 签名后的资源包
- `linux-room-server/candidate-gm6PW2/` - 服务器引擎目录

### 2. 上传文件到服务器

```bash
cd C:\Users\lngsc\Documents\Red_VS_Blue\release-018-build\output
bash scp-108.sh
```

上传脚本会：
1. 打包服务器引擎为 `server.tar.gz`
2. 通过 SCP 上传所有必需文件到 `/tmp/rvb-release-108`
3. 设置部署脚本的执行权限

### 3. 执行部署

```bash
ssh root@38.22.90.175 "bash /tmp/rvb-release-108/deploy-108.sh <target-name>"
```

例如：
```bash
ssh root@38.22.90.175 "bash /tmp/rvb-release-108/deploy-108.sh release-108-content-108"
```

部署脚本会执行以下步骤：

1. **前置检查**
   - 获取文件锁防止并发部署
   - 验证符号链接一致性
   - 检查目标目录（如果是当前版本则自动清理）

2. **空闲检查**
   - 检查数据库中是否有活跃的排位赛或队列
   - 检查所有服务端口是否有活跃房间
   - 如果服务未启动则跳过检查

3. **准备新版本**
   - 创建目标目录
   - 解压服务器引擎
   - 验证 SHA256 校验和
   - 复制配置文件和资源包
   - 重新生成校验和
   - 设置文件所有权

4. **备份**
   - 创建备份目录 `/var/backups/rvb/<target-name>-<timestamp>`
   - 保存服务单元配置
   - 备份中继服务器脚本（如有变更）
   - 记录数据库指纹
   - 导出数据库备份

5. **安装资源包**
   - 安装到 `/var/lib/rvb/resource-pack/`（rvb-game 服务使用）
   - 安装到 `/var/lib/rvb-official/resource-pack/`（rvb-official 服务使用）

6. **切换版本**
   - 停止 nginx、rvb-game、rvb-official 服务
   - 停止 rvb-relay（如有变更）
   - 原子性更新 `/opt/rvb/current` 符号链接
   - 更新 `/opt/rvb/official-current` 符号链接
   - 更新中继服务器脚本（如有变更）

7. **启动服务**
   - 启动 rvb-game、rvb-official 服务
   - 启动 rvb-relay（如有变更）
   - 等待健康检查通过（最多 60 秒）

8. **验证部署**
   - 从端口 2567 获取资源包 hash
   - 从端口 2568 获取资源包 hash
   - 验证两个 hash 非空且一致
   - 检查数据库指纹变化
   - 启动 nginx

9. **完成**
   - 输出部署成功信息和资源包 hash

### 4. 验证部署

部署完成后，手动验证：

```bash
# 检查服务状态
ssh root@38.22.90.175 "systemctl status rvb-game rvb-official"

# 检查资源包 hash
ssh root@38.22.90.175 "curl -s http://127.0.0.1:2567/catalog/identity | jq -r '.resolvedProfileHash'"
ssh root@38.22.90.175 "curl -s http://127.0.0.1:2568/catalog/identity | jq -r '.resolvedProfileHash'"

# 检查符号链接
ssh root@38.22.90.175 "ls -la /opt/rvb/current /opt/rvb/official-current"
```

## 服务架构

### 服务端口

- `2567` - rvb-game（游戏服务）
- `2568` - rvb-official（官方排位服务）
- `8080` - rvb-relay（中继服务）

### 目录结构

```
/opt/rvb/
├── current -> releases/release-XXX/           # rvb-game 使用
├── official-current -> releases/release-XXX/  # rvb-official 使用
├── releases/
│   ├── release-108-content-108/
│   └── ...
├── relay-v1/
│   └── relay.mjs
└── runtime/
    └── node-v24.21.0-linux-x64/

/var/lib/rvb/
└── resource-pack/                             # rvb-game 资源包
    ├── active.json
    ├── packages/
    └── profiles/

/var/lib/rvb-official/
└── resource-pack/                             # rvb-official 资源包
    ├── active.json
    ├── packages/
    └── profiles/

/var/backups/rvb/
└── <target-name>-<timestamp>/
    ├── units.txt
    ├── relay.mjs
    └── rvb_official.pgdump
```

### 环境变量

**rvb-game 服务：**
- `WorkingDirectory=/opt/rvb/current`
- `APP_ROOT_DIR=/opt/rvb/current`
- `USER_DATA_DIR=/var/lib/rvb`

**rvb-official 服务：**
- `WorkingDirectory=/opt/rvb/official-current`
- `APP_ROOT_DIR=/opt/rvb/official-current`
- `USER_DATA_DIR=/var/lib/rvb-official`

## 回滚

如果部署失败，回滚到之前的版本：

```bash
ssh root@38.22.90.175
systemctl stop rvb-game rvb-official nginx
ln -sfn /opt/rvb/releases/<previous-version> /opt/rvb/current
ln -sfn /opt/rvb/releases/<previous-version> /opt/rvb/official-current
systemctl start rvb-game rvb-official nginx
```

如需恢复数据库：

```bash
systemctl stop rvb-game rvb-official
runuser -u postgres -- pg_restore -d rvb_official -c /var/backups/rvb/<backup>/rvb_official.pgdump
systemctl start rvb-game rvb-official
```

## 故障排查

### 部署脚本静默退出

启用详细输出查看失败位置：
```bash
bash -x /tmp/rvb-release-108/deploy-108.sh <target-name>
```

### 资源包 hash 不一致

检查资源包安装位置：
```bash
ls -la /var/lib/rvb/resource-pack/active.json
ls -la /var/lib/rvb-official/resource-pack/active.json
cat /var/lib/rvb/resource-pack/active.json
cat /var/lib/rvb-official/resource-pack/active.json
```

### 服务启动失败

查看服务日志：
```bash
journalctl -u rvb-game -n 50
journalctl -u rvb-official -n 50
```

### 健康检查超时

检查服务是否真的启动：
```bash
systemctl status rvb-game rvb-official
curl http://127.0.0.1:2567/healthz
curl http://127.0.0.1:2568/healthz
```

## 注意事项

1. **部署时机**：避免在高峰时段部署，确保没有活跃的排位赛
2. **目标名称**：使用描述性的目标名称，如 `release-<引擎版本>-content-<资源包版本>`
3. **备份**：每次部署都会自动创建数据库备份，但不会自动清理旧备份
4. **资源包双安装**：脚本会自动安装资源包到两个位置，确保两个服务都能读取
5. **原子性切换**：符号链接通过 `ln -sfn` + `mv -Tf` 原子性更新，避免竞态条件
6. **文件锁**：部署脚本使用 `/var/lock/rvb-admin.lock` 防止并发执行

## 仅更新资源包

如果只需要更新资源包而不更新引擎：

```bash
ssh root@38.22.90.175
systemctl stop rvb-game rvb-official nginx
cd /opt/rvb/current
APP_ROOT_DIR=/opt/rvb/current USER_DATA_DIR=/var/lib/rvb \
  /opt/rvb/runtime/node-v24.21.0-linux-x64/bin/node \
  install-profile.cjs content.rvbpack
APP_ROOT_DIR=/opt/rvb/current USER_DATA_DIR=/var/lib/rvb-official \
  /opt/rvb/runtime/node-v24.21.0-linux-x64/bin/node \
  install-profile.cjs content.rvbpack
systemctl start rvb-game rvb-official nginx
```

## 脚本定制

如果需要部署不同版本号的包：

1. 复制 `scp-108.sh` 和 `deploy-108.sh`
2. 修改版本号（如 `108` → `109`）
3. 更新文件路径引用（资源包文件名、引擎候选版本等）
4. 保持脚本逻辑不变
