# RED-207：准备 COS 更新目录

本工具只准备本地上传文件，不上传、不公开新版，也不更改既有 GitHub Release。
目标桶固定为 `rvb-updates-hk-1321590994`，地域 `ap-hongkong`。

```powershell
node scripts/prepare-cos-update-source.mjs dist/client-releases/v0.1.3 dist/red206-resource-release-v3 dist/red207-cos-upload dist/client-releases/v0.1.2
```

最后一个参数可选：复制上一客户端版本经过校验的 blockmap，供 Windows 差量更新获取旧块表。
保留服务器已有旧版本 blockmap，不需要为差量下载再上传旧安装器。
输入客户端目录必须通过 `synchronized-release.mjs` 的完整双端资产校验。
资源目录必须包含正式发布时的 `public-verification.json`（官方 tag、版本、公开字节哈希）和
`verification.json`（已通过原签名验证的凭据）。工具重新计算两个资源文件的大小、SHA256，
逐项对照公开发行凭据；不重新签名，不把任意目录称为经过验证的资源发行。
这些凭据只作为本地可信发布工作流输入，不上传；玩家安装时仍由原资源安装器验证签名及发行者。

输出中只有公开分发文件：

```text
0.1.2/RED-vs-BLUE-0.1.2-Setup.exe.blockmap
0.1.3/RED-vs-BLUE-0.1.3-Setup.exe
0.1.3/RED-vs-BLUE-0.1.3-Setup.exe.blockmap
resource/0.0.1789313922816/content.rvbpack
resource/0.0.1789313922816/content-update.json
resource/latest.json
latest.yml
```

资源索引、归档保持原字节；`resource/latest.json` 保存官方 GitHub asset URL、摘要和状态，
额外 `rvb_version` 只用于定位 COS 版本目录。客户端仍校验官方身份后再映射实际下载地址。
根 `latest.yml` 仅将安装器路径调整为版本目录，保留 SHA512、大小和版本。
RED-208 起使用正式域名 `https://updates.redvsblue.top`，同时输出版本目录 APK、清单引用的全部 `.rvbdelta` 和根 `android-latest.json`。安卓清单保留正式 GitHub URL 与原字节，客户端在验证后映射实际下载位置。

上传顺序：先上传所有版本目录文件，匿名读取并核对大小、SHA256、Range 206，
再上传 `resource/latest.json`、`android-latest.json`，最后上传根 `latest.yml`。三份可变清单建议设置
`Cache-Control: no-cache`。上传失败时不要更新清单；已发版本目录文件不覆盖、不提前删除。
此脚本不提供 COS 登录和自动上传，也不代表现有 0.1.3 客户端自动改源。

回退：客户端选择 GitHub；必要时将 COS 两份清单恢复为之前经过验证的清单。
恢复清单不强制降级已安装客户端或资源。源站故障不得改写哈希、跳过签名或绕过 APK 限制。

自动测试：`node --test tests/build/prepare-cos-update-source.test.mjs`。
