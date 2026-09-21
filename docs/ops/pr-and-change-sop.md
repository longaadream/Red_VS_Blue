# PR 与改动归档 SOP

本文只记录如何把工作收进 PR。功能进度、验收结果和截图全部写在 PR 描述，不另建进度文档。

## 开始工作

```powershell
git status --short
git log -8 --oneline --decorate
git switch -c codex/<task-name>
```

只提交当前任务文件；先用 `git diff --stat` 和 `git diff --check` 检查范围与空白错误。

## 验证与提交

```powershell
node node_modules/vitest/vitest.mjs run <relevant-tests> --maxWorkers=1
node node_modules/eslint/bin/eslint.js <changed-files> --max-warnings 0
git diff --check
git add <task-files>
git commit -m "fix(<scope>): <summary>"
```

提交前检查：

```powershell
git status --short
git show --stat --oneline HEAD
```

## 推送和创建 PR

```powershell
git push -u origin codex/<task-name>
gh pr create --base main --head codex/<task-name> `
  --title "<问题和结果>" `
  --body-file <pr-description.md>
```

PR 描述固定包含：问题、最终行为、涉及文件、验证命令及结果、已知限制、资源包/安装包路径（如有）。不要把私钥、令牌、完整环境变量或本机绝对密钥内容放进 PR。

## 密钥和令牌处理

- GitHub：使用 `gh auth status` 检查已有登录态；不要把 token 写入命令参数、脚本或 PR。
- 资源包：只引用受保护的 `--key-file` 路径；私钥内容永不复制。
- COS：使用本机凭据管理器或临时环境变量；发布后清理临时变量和日志。
- 发现密钥进入 Git 后立即停止发布，撤销/轮换密钥，再清理历史并重新验证。

