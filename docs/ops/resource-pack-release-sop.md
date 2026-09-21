# 资源包构建、签名与发布 SOP

本文只记录可重复执行的命令、密钥位置和安全处理规则。具体角色进度、测试结果和变更范围写在对应 PR。

## 环境

在仓库根目录执行。Windows PowerShell 示例：

```powershell
Set-Location C:\Users\lngsc\Documents\Red_VS_Blue\release-018-build
```

签名私钥只从本机受保护位置读取：

```text
C:\Users\lngsc\Documents\Red_VS_Blue\pr-tools\RED-202-IDE\user-data\signing\official-content.key
```

公开发布者 `keyId`：

```text
2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e
```

私钥内容、口令和访问令牌不得写入 Git、PR、日志、资源包或聊天消息。命令行只传 `--key-file` 路径；运行结束后不要复制终端中的私密输出。

## 构建、签名、验证

准备一个临时源目录，只放要发布的 `data` 和资源文件：

```powershell
New-Item -ItemType Directory -Force output\pack-stage-<version> | Out-Null
Copy-Item data,images -Destination output\pack-stage-<version> -Recurse -Force
```

构建未签名包：

```powershell
node scripts/rvb.mjs build RED-<task> snapshot `
  --source output\pack-stage-<version> `
  --output output\unsigned-<version>.rvbpack `
  --package-id rvb.official-content `
  --version <version> `
  --display-name "RED vs BLUE 资源更新" `
  --publisher-id rvb.official `
  --channel authoring
```

签名：

```powershell
node scripts/rvb.mjs sign RED-<task> `
  --input output\unsigned-<version>.rvbpack `
  --key-file C:\Users\lngsc\Documents\Red_VS_Blue\pr-tools\RED-202-IDE\user-data\signing\official-content.key `
  --output output\signed-<version>.rvbpack `
  --channel qa
```

验证签名、发布者和能力：

```powershell
node scripts/rvb.mjs validate RED-<task> `
  --archive output\signed-<version>.rvbpack `
  --channel qa `
  --confirm-stable `
  --trusted-key-id 2e4c9045bf25982b105297bdde208d501010af1009203eab1f7ca77f6e26839e
```

复制发布文件并计算摘要：

```powershell
Copy-Item output\signed-<version>.rvbpack output\content.rvbpack -Force
Get-FileHash output\content.rvbpack -Algorithm SHA256
```

`packageHash` 来自构建/验证输出；`content.rvbpack` 的 SHA-256 来自 `Get-FileHash`。两者用途不同，不能互换。

## 发布处理

- GitHub 资源包 tag：`content-test-<packageHash>`；资源包 release 不使用 `--prerelease`。
- `content-update.json` 的 `contentHash` 使用 `packageHash`。
- 清单中的 `browser_download_url` 使用 GitHub release URL；COS 只作为实际下载镜像。
- 上传 COS 时将 `content-update.json` 和 `content.rvbpack` 放入 `resource/<version>/`，再更新根目录 `latest.json`。
- 发布后检查 GitHub URL、COS URL、文件大小、SHA-256 和 `keyId`；客户端分别测试 GitHub/COS 更新源。

禁止：覆盖旧签名包、用整份旧资源包覆盖新改动、把私钥提交到仓库、把未验证包上传到正式目录。

