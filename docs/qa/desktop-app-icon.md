# 桌面手写字标验收

## 目标与基线

用全大写手写 RED VS BLUE 字标替换客户端的 Electron 默认程序图标。用户已确认字形和红蓝配色，并授权创建 PR。关联美术工作：RED-186。

风险：Low。base_branch: main；base_sha: e9b6918080010f30f5b2fe5f535548f80c90a257。提交前已执行 git fetch origin --prune 和 npm.cmd run check:main-baseline，基线无落后。

## 最终实现

- config/branding/icon.svg：原创手写路径，圆润收笔、轻微倾斜、错落基线；无字体或外部资源依赖。
- Windows ICO 九档尺寸、macOS ICNS 七档尺寸、512px PNG 及重建脚本 scripts/build-app-icons.mjs。
- 客户端游戏、服务器连接、管理窗口读取统一图标。Windows AppUserModelID 与打包 appId 一致。
- 打包配置包含平台程序图标与 resources/branding 的运行时资源。

## 检查结果

- npx.cmd eslint electron-client/main.ts scripts/build-app-icons.mjs --max-warnings 0：通过。脚本采用项目 ESLint 已覆盖的 ESM 扩展名，未修改检查配置。
- npx.cmd tsc -p electron-client/tsconfig.json --noEmit：通过。
- npm.cmd test -- tests/electron/windows-client-runtime.test.ts tests/electron/client-package-verifier.test.ts：2 文件、17 项通过。
- node --check scripts/build-app-icons.mjs：通过。
- ICO 九档 PNG 帧的尺寸、透明通道、文件偏移逐帧校验通过；深浅背景的 16/24/32/48/64/128px 预览见 [图标尺寸预览](archive/app-icon/sizes.png)。
- 最终手写版 ICO 经 Electron nativeImage 解码为 256×256，成功创建带图标的隐藏 BrowserWindow。[原生图标验收记录](archive/app-icon/native-smoke.json) 包含图标 SHA-256 与结果。存在 GPU 子进程退出日志，未将该检查视为完整游戏渲染验收。
- git diff --check：通过。

## 限制、人工验证与回退

未制作完整 Windows 发行包；macOS/Linux 仅准备资源和配置，未在相应系统运行。现有安装版 EXE 和固定快捷方式需使用新构建，源码修改不会自动替换已安装程序。

从此分支启动或重新打包客户端，检查程序文件、窗口、任务栏和服务器连接窗口图标。主菜单、战斗图标、规则、编辑器和移动端未修改。回退本次图标文件、脚本和客户端引用即可，无数据迁移。
