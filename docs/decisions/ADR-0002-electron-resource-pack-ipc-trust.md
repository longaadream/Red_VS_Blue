# ADR-0002：收紧 Electron 资源包与 IPC sender 信任边界

状态：已接受
日期：2026-08-14
关联任务：RED-24、RED-19

## 背景

三个 Electron 主进程原先按字符串 channel 全局注册 handler，没有把调用绑定到创建该页面
的窗口、主 frame 或可信 URL。客户端资源包还会把 ZIP 内容直接写入随应用分发的 HTML 根
目录，使资源包中的脚本或页面可能与内置代码处于同一信任域。路径检查、解压预算和导入
事务也不完整。

RED-19 已完成 Electron 运行时升级。项目负责人批准 RED-24 的其余安全方案，同时明确
`adm-zip` 不在本任务升级、替换或移除。

## 决策

1. 每个 IPC handler 在处理参数前，必须确认 sender 是 channel 允许的精确
   `BrowserWindow.webContents`，`senderFrame` 是该 WebContents 的 `mainFrame`，且 frame URL
   位于该窗口的受信 origin。客户端按 game、admin、connect 三种窗口角色分配 channel。
2. 所有窗口拒绝新窗口请求、越界主 frame 导航和全部子 frame 导航。iframe 即使加载受信
   URL，也不能获得主进程能力。
3. 客户端游戏页由只读 `rvb-client://app/` 协议提供。内置 HTML、JS、CSS、SVG 和未知类型
   永远从随应用分发的根目录读取；资源包只能覆盖 data JSON 和 jpg/jpeg/png/webp 图片。
4. 资源包保存在 `userData/resource-pack/versions/<archive-sha256>/`。ZIP 中央目录必须在任何
   entry 解压前完成路径、重复/大小写冲突、符号链接/类型、加密状态和声明大小预检。限制为
   压缩体 32 MiB、声明解压总量 128 MiB、单文件 16 MiB、2048 entries。
5. `pack.json` 及所有待激活 JSON 必须通过解析与 schema 检查。内容写入随机 staging；只有
   全部验证成功后才把 staging 重命名为不可变版本，并原子替换 `active.json`。失败保持原指针。
6. 清除资源包写入 `version: null`，让协议回到内置资源；保留旧版本和 `previousVersion`，支持
   人工运行时回退。旧固定 `resource-pack/data` 仅在没有 `active.json` 时作为读取兼容路径。

## 备选方案

- 继续覆盖内置 HTML 根目录：不采用；无法把可更新数据和可执行应用代码分离。
- 仅依赖 preload 不暴露危险 channel：不采用；同一 preload 被多个窗口复用，且页面或 iframe
  被攻陷后仍需要主进程独立验证 sender。
- 分批把 renderer 已解压文件写入主进程：不采用；中途失败会留下半更新状态，也无法在内容
  解压前统一执行 ZIP 目录预算。
- 在 RED-24 中更换 ZIP 库：不采用；RED-19 已完成，项目负责人明确本任务保持 `adm-zip`
  合同不变。

## 影响

- 资源包不能再热更新 HTML/JS/CSS/SVG；已有包中的这些文件会被验证预算但不会写入或提供。
- 客户端相对资源 URL 改由自定义只读协议解析，合法 data/图片仍可按原路径读取。
- 导入会保留不可变旧版本，占用空间可能增加；自动垃圾回收不在本任务范围。
- 三个 Electron TypeScript 编译根目录各有一份小型 sender 判定模块，避免扩大 tsconfig/产物
  布局；同一测试矩阵约束其行为一致。

## 验证方式

运行 Electron sender、资源包安全和静态边界测试，以及根工程和三个 Electron TypeScript
检查。候选构建还需完成 server/client/editor 打包和 Windows 冒烟；人工导入混合合法资源与
活动内容的包，再导入失败包并清除，观察活动指针和实际读取结果。

## 回退方式

代码回退使用 RED-24 PR revert。仅回退运行时资源时，把 `active.json.version` 原子切回
`previousVersion`；失败导入本身不会改变指针。不要删除 `versions/`，除非另有明确清理任务。

## 相关资料

- [RED-24](https://linear.app/redvsblue/issue/RED-24/收紧-electron-客户端资源包与-ipc-sender-信任边界)
- [RED-19](https://linear.app/redvsblue/issue/RED-19)
- [Windows 构建与安全验证](../technical/BUILD_AND_RUN.md#9-red-24-ipc-与资源包信任边界)
