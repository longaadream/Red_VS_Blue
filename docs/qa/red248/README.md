# RED-248 候选验证

日期：2026-10-09。基线：`00df31f8bd35b34200d507fd83853bf5ac99ba94`。
实现者自检加独立 AI 代码审查；不代表人工验收或生产部署。

## 自动验证

- `npx.cmd vitest run tests/ui/server-admin.test.ts tests/ui/server-admin-panel-ui.test.ts tests/colyseus/official-panel.test.ts`：18 项通过。覆盖 BOM/CRLF 经 execute 发送给 Bash、失败传播、连接配置重启恢复、鉴权/Origin、社区代理、并行读取及旧接口 404。
- `npx.cmd vitest run tests/game/map-selection.test.ts tests/colyseus/official-ranked-map.test.ts`：动态地图目录、普通房间边界与实际官方 Colyseus 开局通过；最终相关组合45项通过。
- `npx.cmd vitest run tests/colyseus/official-ranked-map.test.ts -t "keeps the ranked gate" --maxWorkers=1`：真实 PostgreSQL 重启持久确认测试1项通过，另1项因名称过滤未运行；`tests/colyseus/official-ranked.test.ts`：14项通过。
- PostgreSQL integration 全目录：7 个文件、15 项通过（隔离数据库）；社区子集4项通过。
- `npm.cmd run typecheck`、受影响文件 ESLint、`npm.cmd run check:encoding`、`git diff --check`、`npm.cmd run check:main-baseline` 通过。
- 独立审查发现旧 snapshot 可能在成功保存后重新锁住排位。getter 改为只读；审查复查无剩余明确 P1/P2。

## 浏览器操作

使用 `node --import tsx tests/ui/server-admin-candidate.mjs` 创建独立临时 PostgreSQL 和实际服务器/面板。仅 SSH 传输及状态文本为明确标注的模拟；没有访问生产或发送邮件。

1. 未连接初始页面为中性状态，填写虚构 SSH 地址、私钥路径后可连接统一总览；工具版本 RED-248.1 可见。
2. 点击状态按钮显示模拟传输结果；脚本实际 Bash 解析另由自动测试验证。
3. 当前资源目录8张地图全部显示：4张可用于1v1，3张剧情及1张2v2显示中文不可用原因。
4. 取消勾选一张地图后刷新，未保存勾选状态保留。没有改动生产地图池。
5. 公告保存成功；社区测试帖隐藏后显示“已隐藏”，恢复后显示“可见”；关键词筛选返回目标帖。并行总览/社区读取不再产生409连接错误。
6. 1440×1000桌面及390×844窄屏检查通过。窄屏表格横向滚动，正文不逐字挤压。
7. 使用同一fixture的 `--legacy` 模式移除 snapshot 能力/地图目录并令社区返回404：地图和社区各自提示升级，账号页仍显示两个测试账号，总览保持运行状态。

截图：

- [地图管理桌面](maps-dashboard.jpg)
- [窄屏社区审核](mobile-community.jpg)
- [旧接口功能级降级](legacy-community.jpg)

## 限制与人工验收

真实 SSH 主机、实际历史服务器二进制、生产资源包切换尚未运行；旧版兼容使用接口fixture。请在实际服务器更新前备份并确认版本，关闭旧管理工具再启动新工具，核对状态/版本、地图池以及公告审核。风险 High；回退前保存旧版本支持的至少3张地图，再按技术文档回退服务/工具，不删除数据库记录。不自行合并或发布。
