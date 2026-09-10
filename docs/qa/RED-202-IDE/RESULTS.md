# 内置代码 IDE 验证结果

## 2026-09-10：补齐 JSON 脚本包发布

实现范围及授权见 [打包发布合同](PACK-PUBLISH-TASK.md)，设计边界见 [ADR-0033](../../decisions/ADR-0033-trusted-script-resource-publication.md)。

- 当前原包已实际构建为 `pr-tools/RED-202-IDE/rvb-current-authoring.rvbpack`：299785 字节，344 个内容文件及 manifest。文件 SHA-256：`74c1494894579936b368aea5ac90aa2abbba1b98cec76348eccbe47e2485cadc`。仍为原始攻击4、回血2，供用户亲自修改。
- 原包导入建立独立基线，JSON 技能/规则代码原样保留。authoring 仅供编辑，不具备联网资格且拒绝 smoke 执行；玩家安装仍需签名及宿主发行者信任。
- 完整资源集集成测试使用临时副本：蓝染攻击4→5、小乌描述及两条规则heal2→1；接受、导出、实际签名、Release协调器模拟上传、安装、激活、重启检查、真实技能行为、第二版自动补丁、回滚、篡改拒绝和发行者撤销恢复。
- 真实玩法验证：造成伤害后HP6→7，受到1伤害后仍HP7，再造成伤害后HP8；归刃进度3、归刃后攻击5/移动4保持不变。执行来源是已安装并激活的 Profile，不是作者目录。
- 单独覆盖 data-only Base → 添加脚本 → 删除最后脚本，以及缓存重试；输入链的脚本能力仍需获宿主信任。补丁能力包含被替换或删除的父文件。
- `code-ide-smoke.mjs` 已在真实 Electron 中通过原 IDE 验收，并通过实际 preload/主进程/utility worker 将接受后的 skill/rule JSON 导出为 `.rvbpack`，解包逐一比对代码。见 [smoke.json](smoke.json)。
- 编辑器与游戏运行时的 TypeScript 检查、定向 ESLint 通过；最终 17 个测试文件、344/344 项测试通过（131.51 秒），明细见 [pack-publish-tests.json](pack-publish-tests.json)。
- 独立 AI 三轮只读审查完成，修复信任名单不一致、开发客户端误用 unsigned 策略、启动与回滚重验、Smoke兼容、已删除脚本链检查和 metadata 自报能力绕过；最终无剩余阻断。

本机发布仓库已设为 `longaadream/Red_VS_Blue`，签名身份已准备且公钥 ID 同时纳入编辑器/客户端构建。私钥仅在候选编辑器用户目录，未加入代码或资源包；GitHub 凭据由用户在编辑器中填写。

**交付边界：**当前是已构建可启动的本地编辑器候选及共享安装运行时源码；未构建或发布新的游戏客户端二进制，也没有向真实 GitHub 创建 Release。旧客户端需要一次兼容升级；资源自动发现/下载尚未接通，当前发布后玩家下载、导入、激活。用户亲自发布第一版。操作见 [资源包发布步骤](../../technical/RESOURCE_PACK_PUBLICATION.md)。

以下为前一阶段 IDE 的验证记录。

本地候选分支：`codex/RED-202-inline-code-ide`，继承 RED-202 的现有编辑器功能。
验收前 main-baseline 通过，origin/main 为 `895834297e3e49ebbf10b12074c08979931b6e01`。

## 已验证

- `node --test tests/electron/code-ide.test.mjs`：18/18 通过。覆盖 JSON 转义往返、注释和模板字符串、格式化幂等、受控样例语义、规则同步函数上下文、全部现役顶层代码字段兼容以及文件导入预算/编码。
- Vitest：`content-project`、`source-flow`、`skill-graph`、`ipc-trust`，共 39/39 通过。
- 编辑器 TypeScript 检查及本轮代码 ESLint 检查通过。
- `code-ide-smoke.mjs`：实际隐藏 Electron 窗口中粘贴、格式化、撤销/重做、Ctrl+S、JSON 保存重开、语法失败保留草稿、规则/JSON 模式同步、导入预览、保存锁与外部 revision 冲突检查均通过。见 [smoke.json](smoke.json) 与 [实际截图](builtin-code-ide.png)。
- 原 `skill-graph-smoke.mjs` 回归通过，已把旧 textarea 断言更新为共享 JSON 和 CodeMirror 只读断言；原流程图生成及保存流程保持正常。新证据写入本地 pr-tools/RED-202-IDE/graph-regression，不覆盖旧验收图片。
- 独立 AI 审查完成，发现的前导注释、规则 module/await 上下文、尾部注释分号三个 P2 均修复并增加回归用例，最终复核无剩余阻断问题。

## 试用

本机启动入口：`pr-tools/RED-202-IDE/open-editor.cmd`（位于共享工作区根目录）。
对应资源副本：`content-workspaces/rvb-content-00db513d`，通过官方内容模板复制，JSON 是唯一持久化源码。
游戏数据原件、旧的独立 JS 工程及现有编辑器用户目录均未改写。

## 验证边界

- 导入 UI 测试使用固定的文件选择结果；文件读取器另外完成真实文件系统测试。未自动操作操作系统文件选择对话框。
- 未发布新安装包，当前提供本地源码候选启动入口。
- 语法解析不是完整 Helper 类型检查或玩法验证；未实现运行时调试器、AI 服务或全仓库代码迁移。
- 新建技能不再生成 previewCode；已有资源保留原字段兼容。本次没有批量删除旧 message/previewCode。
- 新增编辑器库独立锁定并编译为随程序分发的离线 bundle，不改变游戏的依赖或游戏客户端主进程。
