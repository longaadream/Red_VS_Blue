# Git 开发基线与 PR 新鲜度门禁

状态：有效
适用范围：所有基于 `main` 的 Linear 开发任务
基线检查：`npm.cmd run check:main-baseline`

## 1. 目标

每个任务必须从当时最新的 `origin/main` 开始，并在开发期间持续证明任务分支仍包含最新主线。该证明由同一个 Node 脚本在本地和 GitHub Actions 中执行，避免依赖开发者记忆，也避免只验证 GitHub 生成的临时 merge commit。

检查器只会查询仓库状态并精确获取远端 `main`。它不会执行 rebase、merge、stash、commit、reset、checkout、switch 或 push，也不会修改工作区文件。

## 2. 建立任务基线

开始任务前，在可访问远端的仓库中执行：

```powershell
git fetch origin --prune
git rev-parse origin/main
```

把结果写入 Linear 任务合同：

```text
base_branch: main
base_sha: <git rev-parse origin/main 的完整 40 位 SHA>
```

任务必须使用包含 Linear 编号的独立分支，例如：

```powershell
git switch -c codex/RED-123-short-description origin/main
```

也可以从同一基线创建独立 worktree；目录位置由本机工作区约定决定：

```powershell
git worktree add -b codex/RED-123-short-description <worktree-path> origin/main
```

不要从未合并的功能分支隐式派生新任务。存在真实依赖时，在 Linear 中显式记录 `blockedBy`/`relatedTo`，并在 PR 中说明基线关系。

## 3. 三个强制检查点

在任务 worktree 根目录运行：

```powershell
npm.cmd run check:main-baseline
```

以下三个时点必须检查：

1. 创建任务分支并完成独立 worktree 初始化后。
2. 每天第一次继续该任务时。
3. 提交 PR、请求 QA、独立审查或人工验收前。

如果同步了 `main`，必须重新运行任务合同中的聚焦测试、静态检查和受影响测试；之前基于旧 SHA 的结果不能代表同步后的分支。

## 4. 检查结果

成功输出包括：

- 当前仓库绝对路径；
- 任务分支名；
- HEAD 与 `origin/main` 的完整 SHA；
- ahead/behind 数量。

检查器在判断 ancestry 前执行以下精确 fetch：

```text
git fetch --prune --no-tags origin +refs/heads/main:refs/remotes/origin/main
```

因此网络失败、缺少 `origin`、远端没有 `main`、fetch 失败、浅历史不足或无法证明共同祖先都会失败关闭，不会退回陈旧缓存。常见稳定错误代码包括：

| 错误代码 | 含义 |
| --- | --- |
| `MISSING_REMOTE` | 当前仓库没有可用的 `origin` |
| `MISSING_BASE_BRANCH` | `origin` 未发布 `refs/heads/main` |
| `REMOTE_UNREACHABLE` | 无法查询远端 main |
| `FETCH_FAILED` | 已确认远端 main，但无法刷新 remote-tracking ref |
| `DETACHED_HEAD` | 本地模式不在命名任务分支；CI 通过显式 PR head ref 处理 detached HEAD |
| `INVALID_BRANCH_NAME` | 分支名不包含 `RED-###` |
| `SHALLOW_HISTORY_INSUFFICIENT` | 浅克隆缺少证明 ancestry 所需历史 |
| `NO_COMMON_ANCESTOR` | HEAD 与主线没有可验证的共同祖先 |
| `BEHIND_MAIN` | 当前 HEAD 未包含最新 `origin/main` |

脏工作区会产生警告，但检查器不会保存、隐藏、清理或提交修改。同步主线前由开发者先处理自己的本地修改。

## 5. 分支同步策略

个人独占、短生命周期且没有下游依赖的任务分支，通常使用：

```powershell
git fetch origin
git rebase origin/main
```

已经由多人共享、已被其他分支依赖，或重写历史会影响协作者的分支，不得擅自 rebase 或 force-push。由分支负责人明确选择合并策略，例如：

```powershell
git fetch origin
git merge origin/main
```

基线检查器不会替开发者选择或执行任何同步策略。发生冲突时按独立的冲突解决流程处理，不得使用破坏性 Git 操作覆盖他人工作。

## 6. Worktree 边界

同一仓库的 worktree 共享 Git 对象库和 remote-tracking refs，但每个 worktree 有独立 HEAD、索引与工作区。一次 fetch 可能更新共享的 `origin/main`，却不会让其他任务分支自动包含该提交；每个任务仍需在自己的 worktree 中运行基线检查。

依赖安装仍遵守 [`BUILD_AND_RUN.md`](./BUILD_AND_RUN.md) 的隔离规则：每个 worktree 使用自己的 `node_modules`，不得回退到父仓库或其他任务的依赖。

## 7. GitHub PR 门禁

`.github/workflows/main-baseline.yml` 在 `pull_request` 上：

1. 以 `github.event.pull_request.head.sha` 检出真实 PR head；
2. 使用 `fetch-depth: 0` 获取足够历史；
3. 通过 `RVB_BASELINE_HEAD_REF` 传入真实 head 分支名；
4. 复用 `node scripts/check-main-baseline.mjs --ci`。

workflow job/status 名称为 `main-baseline`。仓库管理员必须在 main 的 branch protection 或 ruleset 中把该状态设置为 required，并在实施 PR 中保存设置页面截图或等价审计证据。若实施者没有仓库设置权限，必须把该项记录为阻塞并建立后续任务；workflow 文件存在本身不代表 required gate 已生效。

## 8. 人工验证

在已包含最新 main 的真实 `RED-###` 分支运行：

```powershell
npm.cmd run check:main-baseline
```

期望退出码为 0，`Behind: 0`，HEAD/base/ahead/behind 信息完整。然后确认：

1. 对测试远端推进 main 后，旧任务分支返回 `BEHIND_MAIN` 和非零退出码；
2. 脏工作区只得到警告，本地文件内容与 `git status` 不变；
3. PR 页面运行的 `main-baseline` 对应真实 head SHA；
4. 同步 main 后该检查重新变绿，并重新执行任务合同测试。

自动 fixture 入口：

```powershell
npx.cmd vitest run tests/scripts/check-main-baseline.test.ts
```

## 9. 回退

回退 RED-92 的脚本、测试、package 命令、workflow 和文档后，还必须由仓库管理员移除或改名 ruleset 中对应的 `main-baseline` required status；否则所有 PR 会等待一个已不存在的检查。回退不修改现有分支、worktree、提交历史或玩家数据。
