# RED-245 官网构建与 0.1.13 元数据

本次实现范围是官网静态构建器、官网版本与下载说明、图鉴描述展示、官网构建回归测试及本 QA 记录。未上传资源包、未部署官网、未修改 Secrets、客户端规则或网页游戏内容。

- `base_branch`: `main`
- `base_sha`: `9d1b0c30801cd733ec4cede37ce1ef0889a2313a`（本轮已执行 `git fetch origin --prune`）
- 分支：`codex/RED-245-release-0.1.13`
- 风险：Medium。官网清单和安装链接指向 0.1.13，资源链接指向本次 1.0.12 候选；本次未执行外部发布动作。
- 资源来源：`output/RED245/resource/source-1.0.12-safe`
- 资源版本：`1.0.12`
- 最低客户端：`0.1.13`
- `contentHash`: `25b673f202e1b9eeace0fce32398439c3178c7b128b23a32b3710e5c7e6d2346`
- 资源包归档 SHA-256：`1b9f3625476ff0c9df1f12b7c66a0ae7c2e4cae6d4583299b33b1ee39d25e760`

## 构建行为

构建器要求显式传入 `--source` 与 `--output`，不再读取旧的 `release-018` 路径。输出目录存在时会在复制前失败；构建使用当前快照读取棋子、技能、卡牌和关键词，并为全部公开棋子要求图像。资源快照中未进入关键词词典的通用效果标签仍保留在技能描述中，避免丢失规则说明。

实际构建命令：

```powershell
node scripts/build-official-site.mjs --source output/RED245/resource/source-1.0.12-safe --output output/RED245/official-site
```

实际产物目录：`output/RED245/official-site`（本地生成目录受 `.gitignore` 保护）。图鉴包含 45 位公开棋子；每位均有非空描述与可访问图像，标签为 `资源 1.0.12 · 配套客户端 0.1.13`。

## 验证结果

- `npm.cmd run check:main-baseline`：通过；当前分支相对已刷新 `origin/main` 为 ahead 36 / behind 0。工作树存在兄弟任务的本地改动，未触碰其路径。
- `node --test tests/build/official-site.test.mjs`：5 项通过，覆盖显式 source/output、资源标签、缺图失败且不留输出、拒绝覆盖已有输出、0.1.13 版本链接和资源 hash。
- `node --check scripts/build-official-site.mjs`、`node --check website/atlas.js`、`node --check website/site.js`：通过。
- 官网构建：通过，输出 45 位公开棋子。
- 产物检查：`atlas.json` 的版本标签、棋子描述、图像路径、Windows/Android fallback 链接和资源 content hash 均与本次发行元数据一致。

人工验收时可在 `output/RED245/official-site` 启动静态服务器，打开首页和 `atlas.html`，确认下载按钮显示 0.1.13，图鉴显示 1.0.12 / 0.1.13 标签，搜索棋子描述并展开技能与卡牌信息。回退时恢复官网构建脚本、`website/` 版本元数据和图鉴展示文件；不需要删除资源候选或触碰客户端产物。
