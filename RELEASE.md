# RED vs BLUE 发布 SOP

本文只使用仓库相对路径和环境变量，任何机器都可以按同一流程执行。发布进度、功能改动和验收结果写在对应 PR。

## 0. 环境变量

在仓库根目录执行。私钥和访问令牌放在本机凭据管理器或受保护文件中，不提交到仓库。

```powershell
$env:RVB_REPO_ROOT = (Get-Location).Path
$env:RVB_CONTENT_SIGNING_KEY = "<path-to-protected-official-content.key>"
$env:RVB_GITHUB_REPO = "longaadream/Red_VS_Blue"
$env:RVB_RESOURCE_VERSION = "<resource-version>"
$env:RVB_TASK = "<task-id>"
```

签名私钥只通过 `$env:RVB_CONTENT_SIGNING_KEY` 传给工具。公开发布者 `keyId` 是：

```text
2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e
```

## 签名材料边界

三类签名材料都属于发布机密，不进入 GitHub：

| 用途 | 需要的材料 | 传入方式 | 是否应在仓库中出现 |
| --- | --- | --- | --- |
| 资源包 | 官方内容签名私钥 | `RVB_CONTENT_SIGNING_KEY` / `--key-file` | 只有公开 `keyId` |
| Windows 安装包 | 发布证书或证书链、证书口令 | Electron Builder 的 `CSC_LINK`、`CSC_KEY_PASSWORD` 或 CI secret | 只有签名配置和校验摘要 |
| Android APK | `red-vs-blue-release.p12`、对应 `password.clixml` | `scripts/build-android-release.ps1 -SigningDirectory <protected-dir>` | 只有签名证书 SHA-256 |

Android 发布目录至少包含：

```text
<protected-signing-dir>/red-vs-blue-release.p12
<protected-signing-dir>/password.clixml
```

本机已整理的资源包签名材料位于仓库外的 `.local-secrets` 目录；其他机器只需把同类文件放入自己的受保护目录，再设置变量：

```powershell
$env:RVB_CONTENT_SIGNING_KEY = "<protected-dir>\official-content.key"
$androidSigningDir = "<protected-dir>\android"
powershell.exe -NoProfile -File scripts\build-android-release.ps1 -SigningDirectory $androidSigningDir
```

Windows 发布时由 CI 或发布机注入证书：

```powershell
$env:CSC_LINK = "<protected-windows-certificate>"
$env:CSC_KEY_PASSWORD = "<secret-store-value>"
node scripts\build-client-release.cjs
Remove-Item Env:CSC_LINK,Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
```

Windows 和 Android 的私钥不会随源码、资源包、PR 或安装包发布。构建记录必须保存 `sourceCommit`、版本号、文件 SHA-256，以及 Android 的公开证书 SHA-256。没有这些材料时只能构建未签名或无法证明来源的候选包，不能标记为正式发布。

## 1. 构建、签名和验证资源包

资源包源目录必须只包含 `data` 和 `images`，不要把 `data/pages` 或客户端构建目录打进去：

```powershell
$stage = Join-Path $env:RVB_REPO_ROOT "output\pack-stage-$env:RVB_RESOURCE_VERSION"
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $env:RVB_REPO_ROOT "data") (Join-Path $stage "data") -Recurse -Force
Copy-Item (Join-Path $env:RVB_REPO_ROOT "public\images") (Join-Path $stage "images") -Recurse -Force
Remove-Item (Join-Path $stage "data\pages") -Recurse -Force -ErrorAction SilentlyContinue
```

```powershell
node scripts/rvb.mjs build $env:RVB_TASK snapshot `
  --source $stage `
  --output "output\unsigned-$env:RVB_RESOURCE_VERSION.rvbpack" `
  --package-id rvb.official-content `
  --version $env:RVB_RESOURCE_VERSION `
  --display-name "RED vs BLUE 资源更新" `
  --publisher-id rvb.official `
  --channel authoring
```

```powershell
node scripts/rvb.mjs sign $env:RVB_TASK `
  --input "output\unsigned-$env:RVB_RESOURCE_VERSION.rvbpack" `
  --key-file $env:RVB_CONTENT_SIGNING_KEY `
  --output "output\signed-$env:RVB_RESOURCE_VERSION.rvbpack" `
  --channel qa
```

```powershell
node scripts/rvb.mjs validate $env:RVB_TASK `
  --archive "output\signed-$env:RVB_RESOURCE_VERSION.rvbpack" `
  --channel qa `
  --confirm-stable `
  --trusted-key-id 2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e
```

记录工具输出的 `packageHash`。另计算归档文件摘要：

```powershell
Copy-Item "output\signed-$env:RVB_RESOURCE_VERSION.rvbpack" output\content.rvbpack -Force
Get-FileHash output\content.rvbpack -Algorithm SHA256
```

`packageHash` 和文件 SHA-256 是不同字段，分别填入清单中的 `contentHash` 和 `archiveSha256`。

## 2. 发布资源包

生成 `content-update.json` 时使用：

- tag：`content-test-<packageHash>`；稳定发布使用项目约定的 `content-stable-<packageHash>`。
- `contentHash`：验证输出的 `packageHash`。
- `archiveSha256`：`Get-FileHash` 输出。
- `browser_download_url`：GitHub release URL。

```powershell
gh auth status
gh release create "content-test-<packageHash>" `
  --repo $env:RVB_GITHUB_REPO `
  --title "资源包 $env:RVB_RESOURCE_VERSION" `
  --notes-file <release-notes.md> `
  output\content-update.json output\content.rvbpack
```

COS 只作为下载镜像。上传两个文件到 `resource/<resource-version>/`，再更新根目录 `latest.json`。清单中的文件大小和摘要必须与实际文件一致。

```powershell
curl.exe -fsSL https://updates.redvsblue.top/resource/latest.json
curl.exe -fsSL "https://updates.redvsblue.top/resource/<resource-version>/content-update.json"
curl.exe -I "https://updates.redvsblue.top/resource/<resource-version>/content.rvbpack"
```

## 3. 构建客户端

```powershell
npm ci
npm run build:game-engine
npm run build:practice-ai
npm run build:adventure
npm run build:colyseus-server
```

Windows 客户端和 Android 包使用项目已有构建脚本；版本号、签名和摘要写入发布 PR，不在文档中写死机器路径。

正式跨平台构建必须从干净提交开始，并记录来源提交：

```powershell
git status --short
$env:RVB_RELEASE_SOURCE_COMMIT = (git rev-parse HEAD)
```

构建完成后，使用发布脚本生成的 `release-bundle.json` 检查 `sourceCommit`、Windows 清单、Android 签名摘要和所有资产 SHA-256。`output/`、`dist/` 下的旧文件不能当作当前提交的构建结果。

## 4. 安全处理

- 私钥内容、口令、GitHub token、COS 密钥永远不进 Git、PR、日志或资源包。
- 只提交私钥路径变量名和公开 `keyId`。
- 发布前确认归档已经验证且没有未提交的源文件误入 staging 目录。
- 发现密钥泄露时立即撤销并轮换，再重新签名和发布。
- 不覆盖已发布归档；修复使用新的版本号和新的 hash。
