# 终局阻塞修复

base_branch: main
base_sha: 59aff06dcc5d296cd3a9f1f1ec8c53d773589d73

用户授权：优先处理 PVP/官方排位最后动作卡住、无法正常结算。范围：终局历史材料化、结果页面自动战报读取；保留其他待办。风险 High；不改变胜负、积分、持久化 barrier 或存档格式。

现场：ranked-c11263dd-fd7f-44c2-b0cc-bf9c1f24eaca，263 步；最终 transition JSON 57,351,369 字节，前一步 156,819 字节。终局 checkpoint 28,935,595 字节。事务 NOW 时间并非实际提交完成时间；不能据此精确拆分耗时。记录已 settled，不改结果、不重启当前服务。

修复：持久化 journal 的服务器不把完整历史重新放进最终 live state。历史仍由 transition journal 保存。终局依然等待 durable barrier；完整战报改为按需请求，旧的内存型 store 保持原 Trace 行为。

验收：journal 终局不得读取全量历史；最终状态、补丁、检查点及恢复哈希一致；记录可恢复。兼容旧材料化状态和旧客户端。回退：恢复原代码，不改既有数据库。

验证：battle-authority-v2、terminal、postgres-authority-journal 共 34 项通过；结果页 journal 状态测试 1 项通过；真实独立 PostgreSQL 持久化/恢复/战报完整性测试 1 项通过。全库类型检查受既有 electron-client/main.ts:779 request 可能 undefined 阻断，该文件本次未修改。
兼容边界：旧客户端仍可能自动请求完整战报；新端改为按需请求。完整战报读取仍包含同步完整链验证，本次不宣称已经隔离所有战报 CPU 成本。journal 终局不再提供内嵌 Trace v2，完整权威战报保留逐步 transition/replayFrames。

