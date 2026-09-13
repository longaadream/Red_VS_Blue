# RED-205 Windows 房间与发现回归

base_branch: main
base_sha: 53c2c9ca3eef73d2158645b93138e242c225c604

2026-09-13 已 fetch；独立分支由 main 创建后整合已交付 ab04a575。延续 RED-205 候选验收，Linear 写入此前被自动审批拒绝，本次合同保留在仓库。

目标：修复两台 Windows 中 A 开主机变慢、B 入房失败及搜索缺失。允许路径：data/pages/js/colyseus-client.js、lan-discover.js，data/pages/room.html、electron-client 网络发现相关实现、lib/content-pipeline/runtime 运行时读取、相应 tests 与本文档。不改玩法、存档、依赖、其他 UI 工作区，不合并或公开发布。

连接清理与发现属于 Medium；资源校验时机属于 High。用户回复“无需重复扫描”同意调整：启动及切换完整验证，运行中复用已验证身份，保留重启/切换验证和资源身份隔离。回退使用原候选和回退本任务提交，不删除玩家数据。

验收：延迟加入在调用超时后到达时必须退出，不遗留玩家席位；同一候选、已安装资源下两独立身份建房、加入、操作成功；发现保留本机排除且覆盖有效网卡；资源损坏/签名校验回归仍通过。先建立失败测试，再运行相关 Vitest、类型、ESLint、隔离候选场景和独立审查。双物理 Windows 最终需人工验证。

初步证据：玩家 authority.log 反复 Player is already connected 与身份失败；内置资源双浏览器建房入房成功，同流程换为当前资源包副本后 admission/challenge 超时。正在运行的服务器 healthz 87 ms、catalog/identity 1058 ms、rooms 3 ms（单次诊断样本，非基准）。原有 verifyReference 每次读取同步扫描所有文件、散列并重验签名。

## 实现与验证

- 只缓存运行期已完整验证的冻结 Profile 引用；按运行时 context、active.json 内容及绑定环境失效。验证前后指针不同拒绝缓存，避免把旧资源挂到新身份。启动、新 context、绑定、健康报告、显式快照验证仍执行完整验证；本次没有改成后台 worker，也未缓存显式快照读取。
- 临时创建、加入、观战和删除请求超时后，迟到的 SDK Room 被主动 leave 并禁用自动重连，避免占住身份。
- 本机 Radmin 实际为 /8，旧逻辑既排除 VPN，又硬编码 /24 广播。现在包含虚拟网卡，按实际 netmask 广播并绑定对应地址；优先探测界面保存的 rvb_lan_server_url，探测超时从 900 ms 调为 2000 ms。不会扫描整个 /8，VPN 不传广播时首次陌生主机仍需直连。
- 新增超时清理测试修复前 4 项失败；重复校验计数测试修复前失败。定向 49 项通过，覆盖指针竞态、显式验证失败后缓存失效、绑定变化与磁盘损坏拒绝。Electron tsc 和修改文件 ESLint 通过。
- 两独立浏览器使用已安装资源副本、隔离内存服务器：建房/加入/准备/取消成功，准备同步单次 29 ms。
- 实际候选 Windows EXE（隔离 userData，原资源只读复制）+ 内置 PostgreSQL + 真实身份签名 + 第二独立浏览器：建房、加入、准备/取消通过，准备同步单次 59 ms。证据 pr-tools/RED-205-room-fix/smoke/result.json 与 room-host.png、room-guest.png。最终追加的 LAN 地址读取只经组件测试，双物理 Radmin 首次广播仍需用户验收。
