# 发布成功后确认误报

- 用户截图：workbench-publish 返回「发布结果尚未确认」。已授权发布链路修复，按钮仍由用户手动点击。
- 基线：fetch 后 origin/main@895834297e3e49ebbf10b12074c08979931b6e01，main-baseline 通过。
- 实际远端：Release 386218038，draft=false；content.rvbpack 与 content-update.json 的 SHA-256 与本地 bundle.json 一致。
- 风险 Medium；只改编辑器 GitHub 确认请求与定向测试，不修改内容、引擎、签名、令牌或远端 Release。
- 根因候选：GitHub GET 响应 Cache-Control=max-age=60；相同 GET 在发布前后被 Electron HTTP 缓存复用，最后仍读到旧 draft=true。需用缓存响应测试复现，并在每次请求中禁用缓存。
- 验收：缓存 GET 的 mock 能复现旧误报；修复后一次发布、重复核对均通过，不增加 POST/PATCH；资产身份校验保持。定向回归、编译、独立审查。真实远端仅做无凭据只读核对，不自动重发。
- 回退：撤销单文件请求选项修复；已发布资源不变。
## 验证结果

- 缓存响应回归在修复前稳定复现同样的「发布结果尚未确认」，修复后通过。
- GitHub 发布协调器与资源发布回归共 12/12 通过；重复核对不增加 POST/PATCH。
- 编辑器 TypeScript 编译、定向 ESLint、git diff --check 通过。
- 独立审查通过；固定域名、禁止重定向、SHA-256/大小校验保持。
- 已重新编译本地编辑器候选。用户重启后，用相同内容点击发布并确认，会识别已存在的 Release、核对文件并补写本地发布记录。
- 本轮未读取令牌，未执行真实上传/PATCH，未改发布内容。
- 远端内容 hash：b5a757c67e1bfb78649ccea957cc086ef1f43ecaba1b4f2351c1b7540329e174。
- 远端 content.rvbpack：301241 字节，SHA-256 0d6b9998bba5f78ecc115d5a59093797b22774a3bc4c0df7ff922ddb4fa92a04。
- 远端 content-update.json：837 字节，SHA-256 e71cd7a4113bd6a14bc5885b53aae7b9443498b55560bd4e9411528c07e0e952。
