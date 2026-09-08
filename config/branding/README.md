# RED VS BLUE 程序图标

2026-09-07 用户最终选择：仅使用全大写 RED VS BLUE 字标替换 Electron 默认程序图标。沿用主菜单标题的红色 #ef4444、蓝色 #3b82f6，浅色 VS 居中，深色圆角底。字母采用原创随意手写的 SVG 笔画，圆润收笔、粗细变化、轻微倾斜与错落基线，不依赖系统字体或外部资源。

- icon.svg：可维护的矢量源文件。
- icon.ico：Windows EXE 和窗口图标，16 / 20 / 24 / 32 / 40 / 48 / 64 / 128 / 256px。
- icon.png：512px，Linux 和开发态 macOS 图标。
- icon.icns：macOS 打包图标，16 / 32 / 64 / 128 / 256 / 512 / 1024px。

运行 node scripts/build-app-icons.mjs 可从 SVG 重建输出，使用项目已有依赖 sharp。资源已入库，普通打包无需重新生成。最终方案为代码原生矢量字标，不使用 ImageGen。

config/electron-builder.client.json 指定各平台程序图标，将 ICO/PNG 复制到 resources/branding/。electron-client/main.ts 为游戏、服务器连接及管理窗口读取同一图标；Windows AppUserModelID 与客户端 appId 一致。开发态从本目录加载。

已安装程序的 EXE 和现有快捷方式不会随源码自动更新，需要从此工作区重新构建客户端并使用新程序。主菜单、战斗图标、编辑器和移动端未修改。
