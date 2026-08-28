# @aaxis/git-operation

在服务端对 Git 仓库做程序化操作的可嵌入 npm 包：**只 checkout 指定目录**、
**并发安全**、**冲突以结构化数据返回**，并可选集成 GitHub PR。

## 它解决什么

- 只需要仓库里的 `docs/`，不想把整个仓库拉下来 → partial clone + cone 模式 sparse-checkout。
- 服务端要并发处理同一个仓库的多个任务 → 每个任务一个 git worktree，共享对象库，互不干扰。
- 别人随时可能从其他客户端 push → push 被拒与 merge 冲突是**返回值**，不是异常。
- 目标分支受保护 → 主线固定为「建分支 → 改 → commit → push → 建 PR」。

## 要求

- Node.js ≥ 18
- 宿主机安装 **git ≥ 2.32**（worktree + sparse-checkout 组合在更早版本有缺陷）
- 工作区位于**本地磁盘或 K8s PV**，且**单进程独占**（不支持多进程共享同一 `root`）
- HTTPS Personal Access Token 认证
- PR 功能需要 `@octokit/rest`（optional peerDependency，不装不影响核心 git 功能）

## 快速开始

```ts
import { RepoManager } from '@aaxis/git-operation'

const manager = new RepoManager({
  root: '/data/repos',
  auth: { token: process.env.GH_TOKEN! },
})

const store = await manager.store({
  url: 'https://github.com/acme/web',
  github: {},                        // 启用 PR 功能，token 复用上面的
})

const result = await store.publish({
  branch: 'feat/docs-update',
  sparsePaths: [
    { path: 'docs', requireChecks: false },   // 文档：可以直接合
    { path: 'src', requireChecks: true },     // 代码：必须等 CI
  ],
  author: { name: 'Bot', email: 'bot@acme.io' },
  message: 'docs: update getting started',
  files: [{ path: 'docs/getting-started.md', content: '# Hello\n' }],
  createPR: { title: 'Update docs', base: 'main' },
  merge: 'auto',
})
```

## 核心概念

### 三层对象

```
RepoManager   store 生命周期、clone 去重、preflight、磁盘回收
  └ RepoStore   一个 URL 一份共享对象库；开/收 session、fetch、分支
      └ GitRepo   绑定单个 worktree 的操作门面
```

### 并发模型

每个任务一个 `git worktree`：对象库只有一份（省磁盘），HEAD 与索引各自独立（真并发）。
只有 `fetch` 与 `worktree add/remove` 走进程内串行队列，worktree 内部的操作全部无锁。

因此**同一个 `root` 目录只能由一个进程使用**。K8s 下用 StatefulSet + ReadWriteOnce PV。

### sparse-checkout

只支持 **cone 模式**（目录前缀，不支持通配符）。worktree 的创建顺序固定为
`worktree add --no-checkout` → `sparse-checkout set` → `checkout`；顺序错了会让
partial clone 批量拉取全部 blob。

注意 cone 模式**总是包含仓库根目录的文件**（这是 git 的固有行为），但本包的
`PathGuard` 仍拒绝对根文件的写入，避免越出你声明的范围。

## push 状态机

```
push 分支
 ├─ 成功 ─────────────► createPR（若配置）─► 按 merge 模式处理 ─► ok: true
 └─ 被拒（non-fast-forward）
      └─ retryOnReject（默认 true）─► pull（默认 merge 策略）
            ├─ 无冲突 ─► 再 push 一次（只重试一次）
            └─ 有冲突 ─► 停在 merge 中，返回 reason: 'conflict'
```

```ts
const r = await repo.push({ createPR: { title, base: 'main' }, merge: 'auto' })

if (r.ok) {
  r.pr                  // PR 已创建
  r.autoMerge           // 合并结果；失败也不影响 r.ok 与 r.pr
} else if (r.reason === 'conflict') {
  r.conflicts           // 结构化冲突
  r.worktreeDir         // 冲突现场，可用 store.attachSession() 接管
}
```

### merge 模式

| 值 | 含义 |
| --- | --- |
| `'auto'`（默认） | 按改动文件命中的 `sparsePaths.requireChecks` 推导，**取最保守** |
| `'now'` | 立即合并（`PUT /pulls/{n}/merge`） |
| `'checksPass'` | GitHub 原生 auto-merge，等必需检查通过后由 GitHub 自己合 |
| `false` | 只建 PR，人工合 |

`'auto'` 用 `git diff --name-only base...HEAD` 判断影响面 —— 只读 tree，不会触发
partial clone 的惰性 blob 拉取。

## 冲突处理

**不是所有冲突都有 `<<<<<<<` 标记。** 只有双方都改了同一个文本文件才有；
delete/modify、rename、binary 冲突在工作区里根本没有标记，本包统一从
`git ls-files -u` 的 stage 位判定，三方内容一律用 `cat-file blob` 按 stage 取。

```ts
const conflicts = await repo.getConflicts()
// { path, type, binary, base?, ours?, theirs?, hunks?, raw?, sidesSwapped? }

// 整文件选边
await repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])
// 删除（解 delete/modify 必须用这个）
await repo.resolveConflicts([{ path: 'docs/b.md', take: 'delete' }])
// 手改
await repo.resolveConflicts([{ path: 'docs/c.md', content: merged }])
// 逐块选边
await repo.resolveByHunks('docs/a.md', ['ours', 'theirs', { content: '...' }])

await repo.commit({ message: 'resolve conflicts' })   // merge
await repo.continueRebase()                           // rebase
```

`type` 有五种：`both_modified`、`both_added`、`deleted_by_them`、`deleted_by_us`、`rename`。
rename 只识别不自动解，通过 `ourPath` / `theirPath` 交给你决策。

**rebase 的方向归一化**：git 在 rebase 期间 stage 2/3 是反的（stage 2 是被 rebase 到的
上游，stage 3 才是你正在重放的提交）。本包统一归一化，`ours` 永远表示**你这条分支的
改动**，发生过交换时 `sidesSwapped: true`。

## session 生命周期

```ts
// 自动释放。退出时若仍在 merge/rebase 中，则保留 worktree 并抛 MERGE_IN_PROGRESS
await store.withSession(cfg, async (repo) => { /* ... */ })

// 手动管理
const repo = await store.createSession(cfg)
try { /* ... */ } finally { await repo.dispose() }

// 接管已保留的 worktree（进程重启后恢复冲突现场）
const repo = await store.attachSession(worktreeDir)

// 巡检
await store.listSessions()   // [{ dir, branch, state: 'clean'|'conflicted'|'merging' }]
```

**残留的 merge/rebase 状态绝不自动清理** —— 自动 abort 可能丢掉已解了一半的冲突。
用 `repo.recover({ abortOperation: true })` 显式处理。

## 错误处理

预期结局用返回值表达（push 被拒、有冲突、PR 被保护规则挡住）；真异常才抛
`GitOpError`，带 `code` 与已脱敏的 `detail` / `command`。

```
GIT_NOT_FOUND · GIT_VERSION_TOO_OLD · AUTH_FAILED · NETWORK · TIMEOUT
NOT_A_REPO · DIRTY_WORKTREE · MERGE_IN_PROGRESS
BRANCH_IN_USE · BRANCH_EXISTS · BRANCH_NOT_FOUND · WORKTREE_DISPOSED
PATH_OUTSIDE_SPARSE · PATH_TRAVERSAL · INVALID_ARGUMENT
FORGE_NOT_INSTALLED · FORGE_API_ERROR · UNKNOWN
```

映射不中的 stderr 一律是 `UNKNOWN` + 原始输出，绝不猜测。

## 安全

- **token 绝不写入 URL**（会落入 `.git/config` 与 reflog），只用
  `-c http.extraheader` 单次注入。
- token 绝不出现在日志、错误信息或 `command` 字段中，统一脱敏为 `***`。
- 文件访问受 `PathGuard` 约束：拒绝目录穿越、`.git` 访问、越出 sparse 范围，
  并在真正读写前用 `realpath` 复核，堵住经符号链接的逃逸。

## 开发

```bash
bun install
bun test          # 295 个测试，集成测试用本地 bare 仓库，不联网
bun run typecheck
bun run build
```

设计文档见 [`docs/superpowers/specs/`](docs/superpowers/specs/)。
