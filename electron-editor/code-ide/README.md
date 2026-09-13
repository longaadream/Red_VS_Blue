# 内置代码编辑器的构建依赖

此目录是编辑器专用的隔离构建包，不是用户的资源源码目录。
资源仍只保存在 JSON 中；不生成或要求维护配套 JS。

开发此组件时，在仓库根目录执行：

```powershell
npm.cmd ci --prefix electron-editor/code-ide --ignore-scripts
node scripts/build-code-ide.mjs
```

修改源码后应一并提交 `electron-editor/ui/code-ide.js` 和许可证文件。
普通编辑器启动与打包直接使用已提交的离线 bundle，无需安装此目录的依赖。
所有版本固定在 package-lock.json，不引用运行时 CDN。

CodeMirror 文档：https://codemirror.net/docs/ref/
Prettier standalone 文档：https://prettier.io/docs/browser
