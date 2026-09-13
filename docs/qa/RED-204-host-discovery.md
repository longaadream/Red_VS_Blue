# RED-204 主机发现与可识别名称

日期：2026-09-13。风险 Medium。基线 main@53c2c9ca3eef73d2158645b93138e242c225c604。

## 行为与协议

- “我当主机”可保存 1–32 Unicode 字符的名称；显示固定的 12 位短编号。
- Windows userData、Android filesDir 下的 `host-discovery.json` 保存公开元数据：`schemaVersion: 1`、`serverId`（随机 UUID 去掉连字符，32 位十六进制）、`serverName`。正常重启、改名、应用升级保持 ID；清除应用数据会产生新 ID。不要将该文件复制给其他玩家。
- `/api/ping`、`/healthz` 返回可选 `serverId` / `serverName`；本机原生接口返回相同信息。名称保存后健康接口立即更新，Windows 下次 UDP 广播也采用新名称。未配置发现文件的独立服务器保持原健康响应。
- HTTP 和 UDP 共用过滤与去重：排除本地 IPv4（包括其他网卡）、loopback 和自身完整 ID；URL 或完整 ID 去重，不按名称去重。编号用于展示和去重，不参与身份认证，也不是公网直连码。
- UDP IPC 带扫描标识；关闭/重开搜索停止旧 socket，并拒绝已排队的旧标识消息。旧 Android RvBBridge 路径无法关联 UDP 会话，使用 HTTP 搜索；新 Android RvBHost 原本使用 HTTP 搜索。旧主机没有元数据时仍按地址显示。
- 控制字符和双向格式字符不允许保存；Android 与 Node 使用同一空白裁剪范围。显示用 HTML 转义/textContent。Android AtomicFile 先恢复备份，避免恢复时换 ID；损坏配置不会静默重建身份。

## 验证记录

修复前新增 `excludes every local interface while preserving a same-name peer` 回归稳定失败：本机 `.24` / `.25` 被加入列表。

修复后以下命令 8 文件、30 测试通过：

```powershell
node node_modules/vitest/vitest.mjs run tests/electron/host-discovery-ipc.test.ts tests/game/lan-discovery.test.ts tests/ui/lan-entry.test.ts tests/ui/main-menu-layout.test.ts tests/electron/host-discovery.test.ts tests/colyseus/host-discovery.test.ts tests/colyseus/host-relay.test.ts tests/eslint-config.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p electron-client/tsconfig.json --noEmit
npm.cmd run lint
```

类型、全仓库 lint 通过。仅删除本任务旧扫描代码的失效 ESLint 抑制，未增加抑制。

- 真实 Colyseus HTTP `/api/ping` / `/healthz` 测试验证改名即时生效、ID 不变。
- `stage-android-ui-acceptance.mjs` 生成成功；`:app:compileUiAcceptanceJavaWithJavac -x stageUiAcceptance --no-daemon --max-workers=1` 编译通过，使用现有 JDK/SDK/运行时缓存。
- `tests/android/HostDiscoveryProbe.java` 与生产 `HostDiscoveryInfo.java` 用 Android 36 android.jar 编译，D8 转 dex 后在已有 emulator-5554 的 `app_process` 执行。覆盖改名、Unicode 空白/控制字符、只有 `.bak` 时恢复。连续两次独立进程输出相同 ID `d7107b9f7b3c494384300c4be12a58d9`，均为 `RED204_ANDROID_PASS`。Node `readHostDiscovery` 读取 Android 输出的同一文件成功。探针只用 `/data/local/tmp/RED204-*`，未替换游戏 APK。
- 浏览器组件验证使用原菜单 HTML 与主机/搜索脚本、模拟原生接口及探测结果，验证保存名称、短 ID、本机排除、同名不同 ID、HTML 字符安全显示和搜索重开。证据位于本工作树 `dist/RED204-ui-results.json`、`dist/RED204-host-name.png`、`dist/RED204-discovery.png`。这些是组件证据，不是两台物理设备网络实测。
- 独立 AI 审查指出的旧 UDP 会话污染、Unicode 空白不一致、AtomicFile 恢复更换 ID 均已修复；复核无剩余阻断。

## 人工验收

1. 两台同一 Wi-Fi 的设备运行包含此修复的客户端；各自进入“我当主机”，保存一个名称，并记下短 ID。
2. 在本机“连接主机”搜索：应只出现另一台设备，名称与短 ID 应与对方一致；点击后可继续既有连接流程。
3. 把双方名称改为相同，重新搜索仍能通过编号区分；有第三台设备时搜索应同时保留两个同名主机。
4. 关闭搜索后立刻重开，结果不能重复或出现旧一轮独有地址；重启客户端后编号及名称保持。
5. 与旧版本主机混用，旧主机仍可按 IP 找到，没有编号不应被过滤掉。

尚未进行两台物理设备的 Windows ↔ Android 联合验收，也没有为此任务发布安装包。Android 接线位于现有 uiAcceptance 主机实现，公开 APK 构建仍由既有 Android 发布任务处理。

## 回退

回退本 PR 提交即可撤销发现/显示接口；保留本地元数据文件，不删除玩家账号、存档或资源包。旧客户端忽略新增健康字段。无需数据库迁移。
