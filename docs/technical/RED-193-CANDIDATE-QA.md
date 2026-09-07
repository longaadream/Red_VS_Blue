# RED-193 联机候选验证记录

日期：2026-09-07。Windows、Node 24.13.1；玩家主机为 Colyseus/PostgreSQL 权威。目标为首个可分发联机测试候选，不代表已通过真实中国公网大批量验收。

## 已执行的验证

- 同步 `main@e9b6918080010f30f5b2fe5f535548f80c90a257` 后，团队规则/效果、浏览器规则差分和教程运行时共 43 项通过。
- `npm.cmd run test:multiplayer`：16 个文件、41 项通过。覆盖1v1/2v2、身份签名/重放拒绝、私有信息、重连/命令去重、转发边界与容量。
- 随后新增真实 relay 原生断线重连：原会话恢复且版本/状态哈希保持；连同团队效果共8项通过。主动离开超时后 AI 推进权威，再次认证加入收回控制。
- `npm.cmd run build:electron:client`：构建通过，320个页面资产、339个离线数据资产、46个图片资产校验通过，内嵌 PostgreSQL 16.15-2 校验通过。
- `npm.cmd run smoke:multiplayer:windows`：隔离复制 Windows 包，在独立用户目录启动；真实内嵌 PostgreSQL、本机权威、生产身份签名建房/加入、自动重试耗尽与手动恢复、拒绝无效TLS证书、退出进程清理通过。该入口单独标明跳过教程验收。
- 浏览器实际点击验证：公网页错误提示、HTTP直连→大厅→四人房间、模式对应地图、四席位显示；诊断接口成功返回主机协议与耗时。
- TypeScript 检查通过；修改的入口/转发/打包/冒烟代码 ESLint 通过；编码、Windows Colyseus 边界检查通过。边界检查仅允许固定目标的 `lib/server/relay/host-tunnel.ts` 使用原始 WebSocket；游戏权威仍只使用 Colyseus。
- Docker Compose 配置解析通过；未执行 Linux 容器构建和实际公网部署。
- 独立审查后已修复重连与AI竞态、身份绑定、队友信息/规则归属和候选构建溯源问题。

## 容量证据的范围

最近一次本机测试：4个主机隧道、100条真实转发连接、2000次1KB往返、3000次目录请求，P50约72ms、P95约119ms，进程RSS约209MiB。客户端、主机和relay在同一进程/机器上测量，数字包含测试负载影响，不能作为中国公网时延或100人完整对局容量保证。原始报告：`dist/multiplayer-qa/relay-capacity.json`；每次测试会刷新。

## 已知问题与未通过项

- 同步前扩大规则/Colyseus回归：1246通过、6失败。五项在独立main源码抽取中复现：AI admission manifest/语义元数据陈旧、静态审计触发器计数与技能计数陈旧、Sonic描述断言、targeting冻结哈希。另一个依赖未生成的Android bundle；Android迁移不在本任务范围。未更新任何失败快照。基线抽取自身另有一个缺失页面文件错误，不计入这五项复现结论。
- 完整 Windows `client` 冒烟在新合入教程页导航等待失败，未进入后面的联机检查；联机专用入口单独执行，不能用其通过声称完整教程验收通过。
- 尚未验证：用户的第三方frp实际公网IP端口、跨Windows设备、跨运营商重连、连续完整实战、80–100人分批试玩、Linux Docker运行、正式证书及公网带宽。主机迁移未实现，主机退出会中断连接。

## 可复现候选产出

先在 `data/pages/config/multiplayer.json` 设候选编号并提交源码，再依次执行：

```powershell
npm.cmd run check:main-baseline
npm.cmd run test:multiplayer
npm.cmd run build:multiplayer
npm.cmd run smoke:multiplayer:windows
npm.cmd run package:multiplayer -- RED-193-rc1
```

构建要求干净提交，完成后记录 `resources/candidate-build.json`；打包核对已构建客户端编号、提交和源码一致，拒绝复用旧编号覆盖ZIP。产物位于 `dist/multiplayer/RED-193-rc1`，含Windows ZIP、纯转发服务ZIP、SHA256、release.json和玩家指南。新候选须改编号并重新提交、构建和验证。

首次测试流程和回退见 [玩家与组织者指南](RED-193-FIRST-PLAYTEST.md)。保留旧包及主机数据库，不自行合并或公开发布。
