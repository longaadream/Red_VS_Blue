# RED vs BLUE 服务部署 SOP

本文描述服务器引擎、资源包和数据库的部署方式。主机、用户、临时目录和凭据全部通过环境变量或 CI secret 提供，不写死本地目录或真实主机信息。

## 1. 配置变量

在部署机或 CI 中设置：

```bash
export RVB_REMOTE_USER="<deploy-user>"
export RVB_REMOTE_HOST="<deploy-host>"
export RVB_REMOTE_ROOT="/tmp/rvb-release-<task>"
export RVB_TARGET="<release-name>"
```

SSH 使用已有 agent、凭据管理器或 CI secret。不要在脚本、命令历史或 PR 中写入私钥内容、密码或 token。

## 2. 构建服务端引擎

服务端引擎必须从已提交且干净的源码构建：

```bash
git status --short
git rev-parse HEAD
node scripts/build-linux-room-server.mjs
```

脚本会生成 `output/linux-room-server/candidate-<id>/`，其中包含 `build.json` 和覆盖全部文件的 `SHA256SUMS`。`build.json.sourceHead` 必须等于构建前的提交号，`dirty` 必须为 `false`。

部署输入仍然是这个完整目录。为了审计、下载和回滚，再将同一目录制作成独立 Release 资产：

```bash
tar -czf output/rvb-server-<version>-<commit>.tar.gz \
  -C output/linux-room-server/candidate-<id> .
sha256sum output/rvb-server-<version>-<commit>.tar.gz
```

Release 至少包含：

- `rvb-server-<version>-<commit>.tar.gz`
- 对应的 SHA-256 清单
- 构建目录中的 `build.json` 和 `SHA256SUMS`

服务端归档、客户端安装包和资源包使用不同的 Release 资产，不能把服务端引擎塞进资源包。

## 3. 准备和上传

```bash
git status --short
test -f output/signed-<version>.rvbpack
test -d output/linux-room-server/candidate-<id>
```

```bash
scp -r output/linux-room-server/candidate-<id> \
  output/deploy-<version>.sh \
  output/install-profile-<version>.cjs \
  output/content-script-publishers.json \
  output/signed-<version>.rvbpack \
  "$RVB_REMOTE_USER@$RVB_REMOTE_HOST:$RVB_REMOTE_ROOT/"
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" "chmod 700 $RVB_REMOTE_ROOT/deploy-<version>.sh"
```

如果项目构建脚本生成的文件名不同，以当前构建输出为准；不要从旧发布目录复制文件覆盖新构建结果。

## 4. 执行部署

```bash
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" \
  "bash $RVB_REMOTE_ROOT/deploy-<version>.sh $RVB_TARGET"
```

部署脚本应完成停止旧服务、备份当前配置、安装服务器引擎和资源包、更新服务配置、启动服务和健康检查。失败时保留临时目录和日志，先检查原因再重试。

## 5. 验证

```bash
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" "systemctl is-active rvb-game rvb-official"
curl -fsS "http://<service-host>:<health-port>/healthz"
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" \
  "journalctl -u rvb-game -n 80 --no-pager; journalctl -u rvb-official -n 80 --no-pager"
```

确认两个服务为 `active`、健康检查成功、资源包版本和 `packageHash` 与发布 PR 一致，并完成一次新旧客户端基础对局。

## 6. 仅更新资源包

只上传已经通过 `RELEASE.md` 验证的资源包和更新清单：

```bash
scp output/content.rvbpack output/content-update.json \
  "$RVB_REMOTE_USER@$RVB_REMOTE_HOST:$RVB_REMOTE_ROOT/"
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" \
  "node $RVB_REMOTE_ROOT/install-profile-<version>.cjs --archive $RVB_REMOTE_ROOT/content.rvbpack"
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" "systemctl restart rvb-game rvb-official"
```

## 7. 回滚

只回滚到上一个经过验证的引擎和资源包组合：

```bash
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" "systemctl stop rvb-game rvb-official"
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" "bash $RVB_REMOTE_ROOT/rollback-<version>.sh <backup-id>"
ssh "$RVB_REMOTE_USER@$RVB_REMOTE_HOST" "systemctl start rvb-game rvb-official"
```

回滚结果、备份编号和原因写入发布 PR。不要删除失败部署的日志，直到验收完成。
