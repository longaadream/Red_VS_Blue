# Red VS Blue 发布 SOP

本文档描述资源包和客户端的完整发布流程。

---

## 资源包发布

### 前置条件

- 已修改的data目录内容
- 签名密钥文件：`C:\Users\lngsc\Documents\Red_VS_Blue\pr-tools\RED-202-IDE\user-data\signing\official-content.key`
- 腾讯云COS访问权限
- GitHub发布权限

### 步骤 0: 构建和签名资源包

#### 0.1 准备构建目录

```bash
# 创建临时构建目录
rm -rf /tmp/rvb-build-<version>
mkdir -p /tmp/rvb-build-<version>

# 复制data目录（排除pages子目录）
cp -r data /tmp/rvb-build-<version>/
rm -rf /tmp/rvb-build-<version>/data/pages

# 复制images目录
cp -r public/images /tmp/rvb-build-<version>/

# 验证目录结构
ls /tmp/rvb-build-<version>/
# 应显示: data  images
```

#### 0.2 构建unsigned资源包

```bash
node scripts/rvb.mjs build RED-<task> snapshot \
  --source /tmp/rvb-build-<version> \
  --output output/unsigned-<version>.rvbpack \
  --package-id "rvb.official-content" \
  --version "<version>" \
  --display-name "RED vs BLUE 资源更新" \
  --publisher-id "rvb.official" \
  --channel authoring
```

成功后会输出：
- `packageHash` - 未签名包的hash

#### 0.3 签名资源包

```bash
node scripts/rvb.mjs sign RED-<task> \
  --input output/unsigned-<version>.rvbpack \
  --key-file "C:\Users\lngsc\Documents\Red_VS_Blue\pr-tools\RED-202-IDE\user-data\signing\official-content.key" \
  --output output/signed-<version>.rvbpack \
  --channel qa
```

成功后会输出：
- `packageHash` - 签名后包的hash（用于验证和发布）

### 步骤 1: 验证资源包

```bash
node scripts/rvb.mjs validate RED-<task> \
  --archive output/signed-<version>.rvbpack \
  --channel qa \
  --confirm-stable \
  --trusted-key-id 2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e
```

成功后会输出：
- `packageHash` - 包内容hash（用于content-update.json）

**注意**: 对于snapshot类型的资源包，`contentHash` 等于 `packageHash`。

记录这些值，后续需要使用。

### 步骤 2: 准备发布文件

#### 2.1 复制资源包并计算SHA256

```bash
cd output
cp signed-<version>.rvbpack content.rvbpack
sha256sum content.rvbpack
```

记录输出的SHA256值。

#### 2.2 生成 content-update.json

使用步骤1的packageHash和步骤2.1的SHA256创建 `output/content-update.json`：

```json
{
  "schema": "rvb-content-release/v1",
  "channel": "test",
  "version": "<version>",
  "contentHash": "<packageHash>",
  "archive": "content.rvbpack",
  "archiveSha256": "<content.rvbpack的SHA256>",
  "identity": {
    "packageHash": "<packageHash>",
    "publisherKeyId": "2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e",
    "signature": "signed",
    "capabilities": [
      "game-data",
      "pve-content",
      "raster-assets",
      "trusted-executable-content"
    ],
    "resolvedProfileHash": "<步骤1的contentHash>",
    "authorityContentHash": null,
    "engineAbi": "rvb-engine/v1",
    "contentAbi": "rvb-content/v1"
  },
  "distribution": "full-snapshot",
  "automaticClientDiscovery": true,
  "minimumClientVersion": "0.1.4"
}
```

计算SHA256：
```bash
sha256sum content.rvbpack
```

#### 2.3 生成 latest.json

使用以下命令自动生成：

```bash
cd output
CONTENT_HASH="<packageHash>"
VERSION="<version>"

cat > latest.json <<EOF
[
  {
    "tag_name": "content-test-${CONTENT_HASH}",
    "draft": false,
    "published_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "rvb_version": "${VERSION}",
    "assets": [
      {
        "name": "content-update.json",
        "size": $(wc -c < content-update.json),
        "digest": "sha256:$(sha256sum content-update.json | awk '{print $1}')",
        "state": "uploaded",
        "browser_download_url": "https://github.com/longaadream/Red_VS_Blue/releases/download/content-test-${CONTENT_HASH}/content-update.json"
      },
      {
        "name": "content.rvbpack",
        "size": $(wc -c < content.rvbpack),
        "digest": "sha256:$(sha256sum content.rvbpack | awk '{print $1}')",
        "state": "uploaded",
        "browser_download_url": "https://github.com/longaadream/Red_VS_Blue/releases/download/content-test-${CONTENT_HASH}/content.rvbpack"
      }
    ]
  }
]
EOF
```

**重要**：
- `browser_download_url` 必须使用 GitHub URL（用于验证）
- 实际下载会从 COS 镜像
- `size` 和 `digest` 会自动计算

### 步骤 3: 创建 GitHub Release

使用gh CLI创建release并上传文件：

```bash
cd output
TAG="content-test-<contentHash>"

C:\Users\lngsc\AppData\Local\Temp\red187-gh-cli\bin\gh.exe release create "$TAG" \
  --repo longaadream/Red_VS_Blue \
  --title "资源包 v<version>" \
  --notes "发布说明：
- 修改内容描述

contentHash: <contentHash>" \
  content-update.json \
  content.rvbpack
```

**注意**：
- Tag格式必须为 `content-test-<contentHash>`
- 不要添加 `--prerelease` 标志（资源包release不影响客户端更新）
- contentHash使用步骤1的packageHash值

验证release创建成功后，会输出GitHub URL。

### 步骤 4: 上传到 COS

登录腾讯云COS控制台：https://console.cloud.tencent.com/cos

#### 4.1 创建版本目录

在存储桶中创建：`resource/<version>/`

#### 4.2 上传资源文件

上传以下文件到 `resource/<version>/`：
- `content-update.json`
- `content.rvbpack`

#### 4.3 更新 latest.json

上传 `latest.json` 到 `resource/latest.json`（覆盖旧版本）

#### 4.4 设置权限

确保所有文件权限为"公有读"。

### 步骤 5: 验证发布

#### 5.1 测试 COS 访问

```bash
# 测试 latest.json
curl -s https://updates.redvsblue.top/resource/latest.json | jq

# 测试 content-update.json
curl -s https://updates.redvsblue.top/resource/<version>/content-update.json | jq

# 测试资源包（只检查header）
curl -sI https://updates.redvsblue.top/resource/<version>/content.rvbpack
```

#### 5.2 测试客户端更新

1. 打开游戏客户端
2. 设置 → 更新源 → COS
3. 检查更新
4. 应该看到新版本资源包

#### 5.3 验证 GitHub latest

```bash
curl -s https://api.github.com/repos/longaadream/Red_VS_Blue/releases/latest | jq '.tag_name'
```

应该返回客户端版本（如 `v0.1.10`），而不是资源包版本。

---

## 客户端发布

### 前置条件

- 已构建的客户端安装包
- 客户端已通过测试
- GitHub 发布权限

### 步骤 1: 准备发布文件

客户端构建后应该生成以下文件：
- `RED-vs-BLUE-<version>-Setup.exe` - Windows安装包
- `RED-vs-BLUE-<version>-Setup.exe.blockmap` - 差分更新文件
- `RED-vs-BLUE-<version>-Android.apk` - Android安装包
- `RED-vs-BLUE-<version>-Linux-Server.tar.gz` - Linux服务器
- `latest.yml` - Windows更新元数据
- `android-latest.json` - Android更新元数据

### 步骤 2: 创建 GitHub Release

```bash
gh release create v<version> \
  --title "RED vs BLUE v<version>" \
  --notes "<发布说明>" \
  RED-vs-BLUE-<version>-Setup.exe \
  RED-vs-BLUE-<version>-Setup.exe.blockmap \
  RED-vs-BLUE-<version>-Android.apk \
  RED-vs-BLUE-<version>-Linux-Server.tar.gz \
  latest.yml \
  android-latest.json
```

**关键**：
- **不要**添加 `--prerelease` 标志（这是正式客户端release）
- 必须包含 `latest.yml` 以支持 Windows 自动更新
- 必须包含 `android-latest.json` 以支持 Android 更新

### 步骤 3: 验证发布

#### 3.1 验证 latest.yml

```bash
curl -s https://github.com/longaadream/Red_VS_Blue/releases/download/v<version>/latest.yml
```

应该包含：
```yaml
version: <version>
files:
  - url: RED-vs-BLUE-<version>-Setup.exe
    sha512: <hash>
    size: <bytes>
path: RED-vs-BLUE-<version>-Setup.exe
sha512: <hash>
releaseDate: '<ISO8601时间戳>'
```

#### 3.2 验证 GitHub latest

```bash
curl -s https://api.github.com/repos/longaadream/Red_VS_Blue/releases/latest | jq '.tag_name'
```

应该返回刚发布的客户端版本（如 `v<version>`）。

#### 3.3 测试客户端更新

1. 安装旧版本客户端
2. 打开游戏
3. 设置 → 更新源 → GitHub
4. 检查更新
5. 应该看到新版本并能下载安装

### 步骤 4: 上传到 COS（可选）

如果需要支持 COS 客户端更新源：

#### 4.1 创建版本目录

在 COS 存储桶中创建：`<version>/`

#### 4.2 上传文件

上传到 `<version>/`：
- `RED-vs-BLUE-<version>-Setup.exe`
- `RED-vs-BLUE-<version>-Setup.exe.blockmap`
- `RED-vs-BLUE-<version>-Android.apk`
- Android delta 文件（如有）

#### 4.3 更新 latest.yml

修改 `latest.yml`：
```yaml
version: <version>
files:
  - url: <version>/RED-vs-BLUE-<version>-Setup.exe
    sha512: <hash>
    size: <bytes>
path: <version>/RED-vs-BLUE-<version>-Setup.exe
sha512: <hash>
releaseDate: '<ISO8601时间戳>'
```

上传到 COS 根目录：`latest.yml`

#### 4.4 更新 android-latest.json

上传到 COS 根目录：`android-latest.json`

---

## 常见问题

### 资源包问题

**Q: COS 显示"官方资源文件缺失或身份无效"**

A: 检查：
1. `latest.json` 中的 `browser_download_url` 是否使用 GitHub URL
2. `size` 和 `digest` 是否与实际文件匹配
3. COS 文件路径是否正确（`resource/<version>/`）
4. 文件权限是否为"公有读"

**Q: GitHub 源资源包更新正常，但 COS 源失败**

A: 检查：
1. COS URL 是否可访问
2. `latest.json` 中的 `rvb_version` 是否与 `content-update.json` 的 `version` 匹配
3. 域名 `updates.redvsblue.top` 是否正确解析到 COS

### 客户端问题

**Q: GitHub 显示"暂时无法获取客户端更新"**

A: 检查：
1. 最新的资源包 release 是否标记为 `prerelease`
2. GitHub API `/releases/latest` 是否返回客户端版本而非资源包版本
3. 客户端 release 是否包含 `latest.yml`

**Q: 客户端更新后显示的还是旧版本**

A: 可能是：
1. `latest.yml` 中的 `version` 字段不正确
2. 客户端缓存，尝试清除更新缓存
3. release 被标记为 draft 或 prerelease

---

## 发布检查清单

### 资源包发布前

- [ ] 资源包已通过验证（`node scripts/rvb.mjs validate`）
- [ ] 记录了 `contentHash` 和 `packageHash`
- [ ] 生成了正确的 `content-update.json`
- [ ] 生成了正确的 `latest.json`
- [ ] 所有文件的 size 和 digest 已验证

### 资源包发布后

- [ ] GitHub release 已标记为 prerelease
- [ ] COS 文件已上传到正确路径
- [ ] COS 文件权限设置为公有读
- [ ] `curl` 测试 COS URL 可访问
- [ ] 客户端能检测到新版本资源包
- [ ] GitHub `/releases/latest` 返回客户端版本

### 客户端发布前

- [ ] 所有平台安装包已构建
- [ ] `latest.yml` 已生成且格式正确
- [ ] `android-latest.json` 已生成
- [ ] 版本号已更新（`package.json`, `AndroidManifest.xml` 等）

### 客户端发布后

- [ ] GitHub release 创建成功（不是 prerelease）
- [ ] GitHub `/releases/latest` 返回新客户端版本
- [ ] 旧版本客户端能检测到更新
- [ ] Windows 自动更新正常工作
- [ ] Android 更新检测正常

---

## 回滚

### 回滚资源包

1. 删除 GitHub release（可选）：
   ```bash
   gh release delete content-test-<contentHash> --yes
   ```

2. 在 COS 上传旧版本的 `latest.json`

3. 客户端重新检查更新会看到旧版本

### 回滚客户端

1. 在 GitHub 上将旧版本重新标记为 latest（删除新版本或标记为 prerelease）

2. 如果使用 COS，恢复旧版本的 `latest.yml`

3. 用户可以手动下载旧版本安装包重新安装

---

## 自动化脚本

### 生成 content-update.json

```bash
#!/bin/bash
VERSION="$1"
ARCHIVE="output/signed-${VERSION}.rvbpack"

# 验证资源包
REPORT=$(node scripts/rvb.mjs validate RED-XXX \
  --archive "$ARCHIVE" \
  --channel test \
  --confirm-stable \
  --trusted-key-id 2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e)

# 提取hash
PACKAGE_HASH=$(echo "$REPORT" | grep -oP 'packageHash=\K[a-f0-9]+')
CONTENT_HASH=$(echo "$REPORT" | grep -oP 'contentHash=\K[a-f0-9]+')

# 复制并计算SHA256
cp "$ARCHIVE" output/content.rvbpack
ARCHIVE_SHA256=$(sha256sum output/content.rvbpack | awk '{print $1}')

# 生成JSON
cat > output/content-update.json <<EOF
{
  "schema": "rvb-content-release/v1",
  "channel": "test",
  "version": "$VERSION",
  "contentHash": "$CONTENT_HASH",
  "archive": "content.rvbpack",
  "archiveSha256": "$ARCHIVE_SHA256",
  "identity": {
    "packageHash": "$PACKAGE_HASH",
    "publisherKeyId": "2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e",
    "signature": "signed",
    "capabilities": [
      "game-data",
      "pve-content",
      "raster-assets",
      "trusted-executable-content"
    ],
    "resolvedProfileHash": "$CONTENT_HASH",
    "authorityContentHash": null,
    "engineAbi": "rvb-engine/v1",
    "contentAbi": "rvb-content/v1"
  },
  "distribution": "full-snapshot",
  "automaticClientDiscovery": true,
  "minimumClientVersion": "0.1.4"
}
EOF

echo "Generated content-update.json"
echo "Content Hash: $CONTENT_HASH"
```

### 生成 latest.json

```bash
#!/bin/bash
VERSION="$1"
CONTENT_HASH="$2"

UPDATE_SIZE=$(wc -c < output/content-update.json)
UPDATE_SHA256=$(sha256sum output/content-update.json | awk '{print $1}')
PACK_SIZE=$(wc -c < output/content.rvbpack)
PACK_SHA256=$(sha256sum output/content.rvbpack | awk '{print $1}')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat > output/latest.json <<EOF
[
  {
    "tag_name": "content-test-${CONTENT_HASH}",
    "draft": false,
    "published_at": "${TIMESTAMP}",
    "rvb_version": "${VERSION}",
    "assets": [
      {
        "name": "content-update.json",
        "size": ${UPDATE_SIZE},
        "digest": "sha256:${UPDATE_SHA256}",
        "state": "uploaded",
        "browser_download_url": "https://github.com/longaadream/Red_VS_Blue/releases/download/content-test-${CONTENT_HASH}/content-update.json"
      },
      {
        "name": "content.rvbpack",
        "size": ${PACK_SIZE},
        "digest": "sha256:${PACK_SHA256}",
        "state": "uploaded",
        "browser_download_url": "https://github.com/longaadream/Red_VS_Blue/releases/download/content-test-${CONTENT_HASH}/content.rvbpack"
      }
    ]
  }
]
EOF

echo "Generated latest.json"
```

---

## 联系方式

如有问题请参考：
- GitHub Issues: https://github.com/longaadream/Red_VS_Blue/issues
- 部署文档: DEPLOY.md
