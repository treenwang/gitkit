# @aaxis/git-operation — 设计文档

**日期**：2026-08-29
**状态**：设计已确认，待评审后进入实现计划

---

## 1. 目标与场景

提供一个可嵌入其他 Node 应用的 npm 包，用于在**远程服务器**上对 Git 仓库做程序化操作，核心能力：

1. 配置一个 Git 仓库的基础属性，可选指定 0 个或多个 folder path；指定后**只 checkout 这些目录**，其余代码不落盘。
2. 提供 git 基础操作：clone / pull / commit / push / merge / branch / log / diff。
3. 提供**程序化冲突解决 API**：merge 冲突以结构化数据返回，由宿主 app 决定如何解决。
4. 可选集成 GitHub：创建 PR，并可配置立即合并或等 CI 通过后合并。

### 运行环境假设

- Node.js ≥ 18（开发用 Bun，产物为 Node 兼容的 ESM + CJS）。
- 宿主机已安装 **`git ≥ 2.32`**（见 §3.3：worktree + sparse-checkout 组合在更早版本有缺陷）。
- 认证走 **HTTPS Personal Access Token**。
- **存储：每个进程独占自己的 `root` 目录**（K8s 下即 StatefulSet + ReadWriteOnce PV，或 ephemeral volume）。不支持多个进程共享同一个 `root`。
- **并发模型**：每个并发任务在自己的 **git worktree** 中工作，各自一个新分支，互不干扰（见 §3.2）。
- **外部写入**：其他人可能通过其他 git 客户端向同一远端 push，因此 push 被拒与 pull 冲突属于常规路径。
- 目标分支（如 `main`）通常受保护，**一切改动必须通过 PR**，包永不直接 push 到受保护分支。

### 非目标（明确不做）

- 不支持无 git 二进制的环境（isomorphic-git 无法实现 partial clone / sparse checkout）。
- **不支持多进程/多 Pod 共享同一个 `root` 目录**，因此不做跨进程文件锁、不做分布式锁。
- 不支持 SSH 认证（接口预留，第一版不实现）。
- 不支持 GitLab / Bitbucket（`ForgeProvider` 接口预留，只实现 GitHub）。
- 不做 `git mergetool` 这类需要交互式 TTY 的外部工具调用。
- 不做基于"改动了哪些文件"的通用规则引擎（`mergePolicy`）。
- 不支持 sparse-checkout 的 non-cone 模式（只支持目录前缀，即 cone 模式）。
- 不做 rename/rename 冲突的自动解决（只识别并上报）。
- 不支持在两个 worktree 中同时 checkout 同一分支（git 本身禁止；本包的"每任务一新分支"模型不受影响）。

---

## 2. 技术选型

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| Git 实现 | **simple-git**（包装系统 git CLI） | 唯一能做 partial clone + sparse checkout 的可行方案。isomorphic-git 不支持，nodegit 安装与 API 均不可行。 |
| 并发隔离 | **git worktree**（每任务一个） | 对象库只有一份（省磁盘），HEAD 与索引各自独立（真并发），无需跨进程锁。 |
| 开发工具 | **Bun**（`bun test`） | 快。源码不使用任何 `Bun.*` API。 |
| 打包 | **tsup**（ESM + CJS + `.d.ts`） | 宿主可能是 Node / Electron / Next.js。 |
| GitHub | **`@octokit/rest`**，optional peerDependency | 未安装时核心 git 功能完全可用。 |

---

## 3. 并发模型（本设计的核心）

### 3.1 为什么不能共享工作区

git 自带的 `index.lock` 只保护**单条命令**。真正的风险是**跨多条命令的逻辑竞态**：

```
任务 A: createBranch('feat/a')  →  writeFile  →  commit
任务 B:                    checkout('feat/b')  ↑
                                          A 在这里提交到了 feat/b
```

`HEAD`、索引、工作区文件是整个目录的共享可变状态。push 流程更长（`push → 被拒 → pull → 解冲突 → commit → 再 push`），中途被切分支会**静默产出错误的提交**，不报错。

### 3.2 采用的模型：Store + Worktree

```
{root}/github.com/acme/web/
  store/                    ← 共享：git clone --filter=blob:none --no-checkout
    .git/                     对象库、refs、remote 配置。工作区始终为空。
  wt/
    task-<id>-1/            ← 任务 1 的 worktree：独立 HEAD、独立索引、独立 sparse 配置
    task-<id>-2/            ← 任务 2 的 worktree
```

- **对象库只有一份**，clone 只发生一次，磁盘开销小。
- 每个 worktree **有自己的 HEAD 和索引**，任务之间零干扰。
- 每个 worktree **可以有自己的 sparsePaths**（写入 `.git/worktrees/<name>/info/sparse-checkout`）。
- **partial clone 的 filter 是对象库级属性**，在 store 创建时设置一次，所有 worktree 共享受益。

**store 必须用 `--no-checkout` 而非 `--bare`。** `git clone --bare` 不会写入 `remote.origin.fetch` refspec，后续 `git fetch` 不会更新 `refs/remotes/origin/*`，需要手工补配置。`--no-checkout` 得到的是配置完整的普通仓库，只是工作区为空，正是所需。

store 创建后立即执行一次：

```
git config extensions.worktreeConfig true
```

这是 sparse-checkout 配置能落到**各 worktree 专属 config**（而非污染共享 config）的前提。新版 git 会在需要时自动开启，但显式设置可消除版本差异。

### 3.3 版本要求 `git ≥ 2.32`

`git sparse-checkout` 命令自 2.25 引入，但**与 linked worktree 组合时**，早期版本会把 `core.sparseCheckout` 写到共享 config 而非 worktree 专属 config（需要 `extensions.worktreeConfig`），导致一个 worktree 的 sparse 设置污染其他 worktree。

**2.32 是保守下限，确切下限需在实现阶段用 CI 版本矩阵实测钉死**（见 §7.4）。preflight 检测到低于下限直接抛 `GIT_VERSION_TOO_OLD`。

### 3.4 仍然需要串行化的两件事（仅进程内）

worktree 之间共享对象库与 refs，因此以下 store 级操作需要**进程内 mutex（按 store 路径分键）**：

1. **`git fetch`** —— 写 refs 与对象。并发 fetch 可能因 ref lock 争用而失败。
2. **`git worktree add` / `remove` / `prune`** —— 写 `.git/worktrees/`。

**除此之外一律无锁。** worktree 内部的 `writeFile` / `commit` / `resolveConflicts` / `push` 全部可并发。

**`pull` 必须拆成两段**，否则会违反"`GitRepo` 永不加锁"的约束（§4 硬性约束 3）：

```
repo.pull()  ≡  store.fetch()            ← store 级，走 StoreMutex
              + repo.mergeFetchHead()    ← worktree 级，无锁
```

`push` **不需要**本地锁：它写的是远端 refs，不触碰本地对象库的共享可变状态；远端侧的竞态由 non-fast-forward 拒绝机制处理（§5.5）。

因为假设了单进程独占 `root`（§1），进程内 mutex 就足够，**不需要文件锁，也不需要 Redis/DB 分布式锁**。

### 3.5 worktree 的创建顺序（关键）

**必须先建空 worktree、再配 sparse、最后才 checkout。** 顺序错了会让"只下载指定目录"这个核心需求直接失效：

```
git worktree add --no-checkout -b <branch> <path> <base>
git -C <path> sparse-checkout init --cone
git -C <path> sparse-checkout set <paths...>
git -C <path> checkout
```

**原因**：`git worktree add` 默认会 checkout 完整工作树。在 partial clone（`--filter=blob:none`）中，这会触发 git 向 promisor remote **批量惰性拉取整个仓库的 blob** —— 既慢又把不该下载的代码全下下来了。`--no-checkout` 建立空 worktree，配好 sparse 之后再 checkout，才只拉取所需目录的 blob。

`sparsePaths` 为空（全量模式）时跳过中间两步，直接 `checkout`。

### 3.6 worktree 生命周期
- **释放**：`session.dispose()` → `git worktree remove --force <path>`。
- **提供 `withSession()` 保证释放**（见 §4.3），避免宿主忘记 dispose 造成磁盘泄漏。
- **崩溃残留**：进程被 kill 会留下孤儿 worktree 目录。`RepoManager` 启动时对每个 store 跑一次 `git worktree prune`，并按前缀清理 `wt/` 下无主目录。**这属于启动清理，不是运行时自动清理**（运行时的 merge 残留仍不自动处理，见 §6.3）。

---

## 4. 架构

依赖方向**严格单向向下**。Layer 2 不得 import Layer 3；Layer 1 不得 import Layer 2。

```
Layer 3 · API 层（对外唯一出口）
  RepoManager      store 生命周期、clone 去重、preflight、启动清理
  RepoStore        一个 URL 对应的共享对象库；创建 / 回收 worktree session
  GitRepo          绑定到单个 worktree 的门面，所有 git 操作方法
  GitHubProvider   ForgeProvider 的 GitHub 实现

Layer 2 · 领域层（纯逻辑，不碰 IO，可纯单测）
  ConflictParser   stage 表 + 冲突标记 → Conflict[]
  ConflictWriter   Resolution[] / HunkChoice[] → 文件内容
  MergeSession     merge 状态机（状态从磁盘实时推导）
  SparseManager    sparsePaths 规范化、cone 校验、requireChecks
  PushPolicy       push 重试决策 + merge 模式推导
  PathGuard        路径必须在 sparse 范围内、防目录穿越
  ErrorMapper      git stderr → 结构化错误码
  LayoutPlanner    url → store / worktree 目录路径（纯字符串计算）

Layer 1 · 执行层（唯一碰进程与文件的地方）
  GitExecutor      唯一 spawn git 的地方：认证注入、超时、onProgress、脱敏
  StoreMutex       按 store 路径分键的进程内 mutex（仅 fetch / worktree 变更）
  FsGateway        受 PathGuard 约束的 readFile / writeFile / listFiles
```

### 目录结构

```
src/
  index.ts                    # 只 re-export 公开 API 和类型
  api/        repo-manager.ts  repo-store.ts  git-repo.ts
  forge/      types.ts  github-provider.ts
  domain/     conflict-parser.ts  conflict-writer.ts  merge-session.ts
              sparse-manager.ts  push-policy.ts  path-guard.ts
              error-mapper.ts  layout-planner.ts
  exec/       git-executor.ts  store-mutex.ts  fs-gateway.ts
  types.ts                    # 公开类型
```

### 硬性约束

1. **`GitExecutor` 是唯一 spawn git 的地方。** 别处出现 `spawn` / `exec` 即为 bug。
2. **Layer 2 全部不碰 IO。** 输入输出均为字符串与普通对象。
3. **只有 `RepoStore` 可以调用 `StoreMutex`。** `GitRepo` 永远不加锁 —— 若某个 `GitRepo` 方法需要加锁，说明它操作了 store 级状态，应当上移到 `RepoStore`。
4. **`GitRepo` 不感知 `RepoManager`**，可由测试直接构造在任意 worktree 上。

---

## 5. 公开 API

### 5.1 配置

```ts
type SparsePath = { path: string; requireChecks?: boolean }   // requireChecks 默认 true

interface ManagerConfig {
  root: string                             // 本进程独占
  auth?: { token: string }                 // 全局默认
  gitPath?: string                         // 默认 'git'
  timeout?: number                         // 单条命令，默认 120_000 ms
  onProgress?: (e: ProgressEvent) => void
}

interface StoreConfig {
  url: string
  auth?: { token: string }                 // 覆盖全局
  depth?: number                           // 默认 undefined（完整历史）
  filter?: string | false                  // 默认 'blob:none'；false 关闭 partial clone
}

interface SessionConfig {
  branch: string                           // 本任务的分支名
  branchMode?: 'create' | 'reuse' | 'createOrReuse'   // 默认 'createOrReuse'
  base?: string                            // 默认远端 HEAD
  sparsePaths?: (string | SparsePath)[]    // 省略/空 = 全量 checkout
  author: { name: string; email: string }
  retryOnReject?: boolean                  // push 被拒后自动 pull 并重试一次，默认 true
}

type ProgressEvent = {
  phase: 'clone' | 'fetch' | 'pull' | 'push' | 'checkout' | 'worktree'
  message: string        // 已脱敏的 git stderr 行
  percent?: number
}
```

字符串简写 `'docs'` 等价于 `{ path: 'docs', requireChecks: true }`（保守默认）。

`branchMode` 语义：

| 值 | 分支已存在（本地或远端） | 分支不存在 |
| --- | --- | --- |
| `'create'` | 抛 `BRANCH_EXISTS` | 基于 `base` 新建 |
| `'reuse'` | checkout 并跟踪远端 | 抛 `BRANCH_NOT_FOUND` |
| `'createOrReuse'`（默认） | checkout 并跟踪远端 | 基于 `base` 新建 |

任一模式下，若该分支已在**另一个 worktree** 中 checkout，一律抛 `BRANCH_IN_USE`（git 本身禁止）。

### 5.2 RepoManager / RepoStore

```ts
const manager = new RepoManager({ root: '/data/repos', auth: { token: process.env.GH_TOKEN } })

const store = await manager.store({ url: 'https://github.com/acme/web' })
// 幂等：不存在则 clone（--filter=blob:none --no-checkout --sparse），存在则复用
```

`RepoManager` 职责（**不含任何业务 git 操作**）：

1. **目录布局**：委托 `LayoutPlanner`，`https://github.com/acme/web` → `{root}/github.com/acme/web/`。
2. **clone 去重**：in-flight Promise map，并发首次请求只 clone 一次。
3. **preflight**：首次使用跑一次 `git --version`（结果缓存），低于 2.32 抛 `GIT_VERSION_TOO_OLD`，未找到抛 `GIT_NOT_FOUND`。
4. **启动清理**：对每个已存在的 store 跑 `git worktree prune` + 清理 `wt/` 下孤儿目录。
5. **磁盘回收**：`manager.evict(url)`、`manager.gc({ maxAgeDays, maxTotalBytes })`。
   **store 需维护活跃 session 引用计数**：`evict` / `gc` 遇到仍有活跃 session 的 store 时跳过并在返回值中报告，绝不删除正在使用的对象库。

### 5.3 主工作流

目标分支受保护，主线固定为「开 session → 建分支 → 改 → commit → push → 建 PR → 释放 session」：

```ts
await store.withSession(sessionConfig, async (repo) => {
  await repo.writeFile('docs/a.md', content)     // 经 PathGuard，越界抛错
  await repo.commit({ message })
  const r = await repo.push({ createPR: { title, body, base: 'main' }, merge: 'auto' })
  if (!r.ok && r.reason === 'conflict') {
    await repo.resolveConflicts(decide(r.conflicts))   // 在回调内解决
    await repo.commit({ message: 'merge' })
    return repo.push({ createPR: false })
  }
  return r
})
```

**`withSession` 的退出契约（这是本包最容易被误用的地方）：**

- 回调正常返回或抛错 → **一律 `worktree remove`**。
- 但退出时若 worktree **仍处于 merge 中**（有未解冲突或未提交的 merge），**不删除 worktree**，改抛 `MERGE_IN_PROGRESS`，`detail` 中带上 worktree 路径。
  理由：静默删除等于丢掉冲突现场和宿主已解了一半的工作；而静默保留又会让宿主以为已清理干净。**报错是唯一诚实的选择。**

因此**程序化解冲突应当发生在回调内部** —— 这也是自然的位置，`push()` 正是在那里返回 `conflicts`。

若确实需要让冲突现场跨越调用边界存活（例如交给人工 UI 异步处理），用手动生命周期：

```ts
const repo = await store.createSession(sessionConfig)
try { /* ... */ } finally { await repo.dispose() }   // 冲突态下由宿主决定何时 dispose

// 进程重启后重新接管一个被保留的 worktree：
const repo2 = await store.attachSession(worktreePath)
```

一站式便利方法：

```ts
await store.publish({
  ...sessionConfig,
  message: string,
  files?: { path: string; content: string }[],   // 省略则使用 worktree 当前改动
  createPR?: CreatePRInput,
  merge?: MergeMode,
}): Promise<PushResult>
// 内部即 withSession + writeFile* + commit + push，全程自动释放 worktree
```

### 5.4 push 的返回值

**预期结局用返回值表达，不用 throw。**

```ts
type PushResult =
  | { ok: true;  pushed: true; pr?: PullRequest
      autoMerge?: { ok: true; merged: true }
                | { ok: false
                    reason: 'blocked_by_checks' | 'not_allowed' | 'conflict'
                    detail: string } }
  | { ok: false; pushed: false; reason: 'conflict'; conflicts: Conflict[] }
  | { ok: false; pushed: false; reason: 'rejected' | 'auth' | 'network'; detail: string }
```

**PR 已创建这一事实不受 auto-merge 失败影响** —— auto-merge 失败时仍返回 `ok: true` 与 `pr`，只是 `autoMerge.ok: false`。

**返回 `reason: 'conflict'` 时，worktree 停留在 merge 中状态，不会被 `withSession` 自动清理** —— 见 §6.3。

### 5.5 push 状态机

```
push 分支
 ├─ 成功 ─────────────────► createPR（若配置）─► 按 merge 模式处理 ─► ok:true
 └─ 被拒（non-fast-forward）
      └─ retryOnReject（默认 true）─► pull（默认 merge 策略）
            ├─ 无冲突 ─► 再 push 一次
            │              ├─ 成功 ─► 同上
            │              └─ 再被拒 ─► ok:false, reason:'rejected'
            └─ 有冲突 ─► 停在 merge 中 ─► ok:false, reason:'conflict', conflicts
```

**只重试一次。** 不做无限循环——远端持续被他人 push 时会一直转。

### 5.6 merge 模式

```ts
merge: 'auto'        // 按 sparsePaths 的 requireChecks 推导（默认）
     | 'now'         // 立即合并：PUT /pulls/{n}/merge
     | 'checksPass'  // GitHub 原生 auto-merge：enablePullRequestAutoMerge
     | false         // 只建 PR，人工合
```

`'auto'` 的推导规则（**取最保守**）：

```
git diff --name-only <base>...<head>     ← 三点：相对 merge-base
 → 匹配 sparsePaths
 → 任一命中路径 requireChecks: true  ⇒ 'checksPass'
 → 全部 false                        ⇒ 'now'
 → 未配置 sparsePaths（全量模式）    ⇒ 'checksPass'
```

这是包内唯一一处"看本次改了什么"的逻辑。

**必须用 `--name-only`**：在 partial clone 中，任何需要文件**内容**的 diff（`--stat`、`-p`）都会触发向 promisor remote 惰性拉取 blob。`--name-only` 只读 tree 对象，无额外网络开销。

`method` 可选 `'squash' | 'merge' | 'rebase'`，默认 `'squash'`。

### 5.7 pull / merge 策略

- `pull` 默认 **merge**（非 rebase），因为一次性冲突比 rebase 的多轮冲突状态机更易程序化处理。
- 两种均可通过 `pull({ strategy: 'merge' | 'rebase' })` 指定。

### 5.8 冲突 API

```ts
const conflicts = await repo.getConflicts()
await repo.resolveConflicts([{ path, content }, ...])
await repo.resolveByHunks(path, ['ours', 'theirs', { content: '...' }])
await repo.commit({ message })     // 完成 merge commit
await repo.abortMerge()            // git merge --abort
```

### 5.9 其余方法

**`RepoStore` 上**（store 级共享状态：refs、对象库）：
`fetch(opts?)` `listBranches()` `deleteBranch(name)` `attachSession(path)` `listSessions()`

**`GitRepo` 上**（worktree 级）：
`status()` `pull(opts?)` `merge(ref, opts?)` `log(opts?)` `diffSummary(opts?)`
`readFile(path)` `writeFile(path, content)` `listFiles(dir?)`
`setSparsePaths(paths)` `abortMerge()` `dispose()`

**不提供 `checkout()`。** 每个 session 绑定一个分支，切分支等于破坏并发模型 —— 需要另一个分支就开另一个 session。

**partial clone 的惰性拉取要写进文档。** `log -p`、`diffSummary` 等需要文件内容的操作会向 promisor remote 请求 blob，产生隐式网络延迟。`log()` 默认 `--name-only`，需要内容时由调用方显式开启并自担开销。

### 5.10 ForgeProvider

```ts
interface ForgeProvider {
  createPR(input): Promise<PullRequest>
  listPRs(query): Promise<PullRequest[]>
  getPR(number): Promise<PullRequest>
  mergePR(number, method): Promise<MergeOutcome>
  enableAutoMerge(number, method): Promise<MergeOutcome>
}
```

`GitHubProvider` 支持 `baseUrl` 以兼容 GitHub Enterprise。token 默认复用 git 的 token，可单独覆盖。
`@octokit/rest` 未安装时，调用 PR 相关方法抛 `FORGE_NOT_INSTALLED`，核心 git 功能不受影响。

---

## 6. 冲突模型

**核心认知：不是所有冲突都有 `<<<<<<<` 标记。** 只有双方都修改了同一文本文件才有。其余类型必须靠 `git ls-files -u` 的 stage 位判定。

```
stage 1 = base（共同祖先）   stage 2 = ours   stage 3 = theirs
```

| stage 1 | 2 | 3 | type | 工作区表现 |
| --- | --- | --- | --- | --- |
| ✓ | ✓ | ✓ | `both_modified` | 有冲突标记（文本时） |
| ✓ | ✓ | ✗ | `deleted_by_them` | 保留 ours 完整内容，**无标记** |
| ✓ | ✗ | ✓ | `deleted_by_us` | 保留 theirs 完整内容，**无标记** |
| ✗ | ✓ | ✓ | `both_added` | 有冲突标记（文本时） |
| — | — | — | `rename` | 路径不同，需 `-M` 检测 |

### 6.1 类型定义

```ts
type Conflict = {
  path: string
  type: 'both_modified' | 'both_added' | 'deleted_by_them' | 'deleted_by_us' | 'rename'
  binary: boolean
  base?:   { oid: string; content?: string }   // content 仅文本时填充
  ours?:   { oid: string; content?: string }
  theirs?: { oid: string; content?: string }
  ourPath?: string; theirPath?: string          // 仅 rename
  hunks?: ConflictHunk[]                        // 仅 both_modified / both_added 且为文本
}

type ConflictHunk = {
  index: number
  ourLines: string[]
  theirLines: string[]
  baseLines?: string[]
  startLine: number
  endLine: number
}

type Resolution =
  | { path: string; take: 'ours' | 'theirs' | 'base' }
  | { path: string; take: 'delete' }
  | { path: string; content: string }

type HunkChoice = 'ours' | 'theirs' | 'base' | 'both' | { content: string }
```

`'both'` 表示 ours 内容后接 theirs 内容。

### 6.2 纯函数

```ts
buildResolvedContent(conflict: Conflict, choices: HunkChoice[]): string
```

`choices.length` 必须等于 `hunks.length`，否则抛 `INVALID_ARGUMENT`。**不做"省略即 ours"的默认**，避免宿主漏传导致静默丢改动。

### 6.3 实现要点

1. **三方内容必须用 `git cat-file blob <oid>` 按 stage 取**，不能读工作区 —— 工作区文件是带标记的混合体。
2. **统一注入 `-c merge.conflictStyle=diff3`**，否则拿不到 base 段。
3. **二进制判定**用 `git check-attr` + NUL 字节探测；二进制文件不填 `content`，只给 `oid`。
4. **`resolveConflicts` 校验完整性**：传入 path 必须都在当前冲突集合内；解完后若仍有未解冲突，返回剩余列表，而不是留给 `commit` 报错。
5. **`rename` 只识别不自动解**，返回 `ourPath` / `theirPath` 由宿主决策。

### 6.4 MergeSession 状态机

```
IDLE ──pull/merge──► CLEAN ──► IDLE
  │                     │
  └──────────────► CONFLICTED ──resolveConflicts(全解完)──► RESOLVED ──commit──► IDLE
                        │
                        └──abortMerge──► IDLE
```

**状态不存内存**，每次实时推导：`git rev-parse --git-path MERGE_HEAD` 指向的文件是否存在 + `git ls-files -u` 是否为空。

**必须用 `git rev-parse --git-path`**，不得硬编码 `.git/worktrees/<name>/…` —— linked worktree 的 git 目录布局不应由本包假设。进程可能重启，内存状态必然与磁盘不一致。

---

## 7. 错误处理与安全

### 7.1 两类错误

- **预期结局 → 返回值**：push 被拒、有冲突、PR 被保护规则挡住、分支已存在。
- **真异常 → throw**：git 未安装 / 版本过低、目录非 git 仓库、认证失败、网络不通、磁盘满、超时、参数非法。

```ts
class GitOpError extends Error {
  code: GitErrorCode
  detail: string        // git 原始 stderr（已脱敏）
  command?: string      // 执行的命令（已脱敏）
  cause?: unknown
}

type GitErrorCode =
  | 'GIT_NOT_FOUND' | 'GIT_VERSION_TOO_OLD'
  | 'AUTH_FAILED' | 'NETWORK' | 'TIMEOUT'
  | 'NOT_A_REPO' | 'DIRTY_WORKTREE' | 'MERGE_IN_PROGRESS'
  | 'BRANCH_IN_USE'                       // 该分支已在另一 worktree 中 checkout
  | 'BRANCH_EXISTS' | 'BRANCH_NOT_FOUND'  // branchMode 约束未满足
  | 'WORKTREE_DISPOSED'                   // 对已释放的 session 调方法
  | 'PATH_OUTSIDE_SPARSE' | 'PATH_TRAVERSAL'
  | 'INVALID_ARGUMENT'
  | 'FORGE_NOT_INSTALLED' | 'FORGE_API_ERROR'
  | 'UNKNOWN'
```

`ErrorMapper` 用 stderr 正则表映射。**映射不中即 `UNKNOWN` + 原始 stderr，绝不猜测** —— 错误的错误码比没有更有害。

### 7.2 认证安全（硬性要求）

1. **token 绝不写入 URL**（会落入 `.git/config` 与 reflog）。改用单次进程注入：
   ```
   git -c http.extraheader="AUTHORIZATION: basic <base64(x-access-token:TOKEN)>" ...
   ```
2. **token 绝不出现在日志、错误信息、`command` 字段中。** `GitExecutor` 在返回任何 stderr / command 前统一脱敏为 `***`。**必须有专门单测。**
3. **`onProgress` 的 stderr 同样脱敏**后再向外抛。
4. **包内不读环境变量**，token 由宿主通过配置传入。

### 7.3 中断与恢复

- **启动清理**（`RepoManager` 构造后首次使用 store 时）：`git worktree prune` + 清理 `wt/` 下的孤儿目录。这是安全的，因为孤儿 worktree 的持有进程已经不存在。
- **运行时不自动清理 merge 残留。** 见 §5.3 的退出契约：`withSession` 退出时若仍在 merge 中，保留 worktree 并抛 `MERGE_IN_PROGRESS`（`detail` 带路径），由宿主用 `store.attachSession(path)` 接管，或显式 `abortMerge()` + `dispose()`。
  自动 `merge --abort` 可能丢掉已解了一半的冲突，绝不自动执行。
- **`store.listSessions()`** 报告所有存活 worktree 及其状态（`clean` / `conflicted` / `orphaned`），供宿主与 `gc()` 决策。
- **`dispose()` 幂等**；对已 dispose 的 session 调用任何方法抛 `WORKTREE_DISPOSED`。

---

## 8. 测试策略

比例大致 **70 / 25 / 5**。

### 8.1 纯单测（无 IO）— Layer 2

- **ConflictParser**：覆盖每一种 stage 组合（both_modified / both_added / deleted_by_them / deleted_by_us / binary / rename）。边界：文件末尾无换行、CRLF、内容本身含 `<<<<<<<` 的伪标记、连续多个 hunk。
- **buildResolvedContent**：每种 `HunkChoice` × 多 hunk 组合，逐字节断言；`choices` 长度不匹配必须抛。
- **PushPolicy**：`'auto'` 推导三种情形；重试决策（被拒→pull 无冲突→重试；再被拒→不再重试）。
- **PathGuard**：`../` 穿越、绝对路径、符号链接、超出 sparse 范围、大小写差异。
- **LayoutPlanner**：各种 URL 形态 → 目录路径；含特殊字符、大小写、带 `.git` 后缀。
- **ErrorMapper**：真实 stderr 样本 → 错误码，含"映射不中返回 UNKNOWN"用例。
- **脱敏**：含 token 的 command / stderr，断言输出中搜不到 token。

**样本必须从真 git 导出**（写脚本造各类冲突并 dump 输出），不得手写臆造 —— 手写样本会导致测试全绿而生产全崩。

### 8.2 集成测试（真 git，本地 bare 仓库作 remote，不联网）

```
建 bare remote → manager.store()（sparse partial clone）
 → withSession(建分支) → 改文件 → commit → push
另起一个 clone 模拟他人先 push → 本地 push 被拒 → 验证自动 pull + 重试
两边改同一行 → 验证冲突解析 → resolve → commit → push 成功
```

必测项：

- sparse checkout 后 **worktree 中其他目录确实不存在**。
- **两个 worktree 配置不同 sparsePaths，互不污染**（这是 §3.3 版本要求的直接验证）。
- partial clone 确实未拉取全部 blob，且 filter 对所有 worktree 生效。
- `setSparsePaths` 增量生效。
- **并发测试**：同一 store 上并发开 10 个 session，各自建分支、改文件、commit、push，全部成功且互不干扰。这是本设计的核心主张，必须有。
- **同分支冲突**：两个 session 用同一分支名 → 抛 `BRANCH_IN_USE`。
- **worktree 泄漏**：session 抛错后 `withSession` 仍完成 remove；冲突态下**不** remove 且抛 `MERGE_IN_PROGRESS`。
- **`attachSession`**：对保留下来的冲突态 worktree 重新接管，`getConflicts()` 结果与中断前一致。
- **`branchMode`** 三种取值 × 分支存在/不存在 共 6 种组合。
- **创建顺序**：断言 worktree 创建过程中**未**发生全量 blob 拉取（用带 `--filter` 的 remote + `GIT_TRACE_PACKET` 或对象计数验证）。
- **`gc` 引用计数**：有活跃 session 的 store 不被回收。
- **启动清理**：手工造孤儿 worktree 目录 → 验证被 prune。
- `dispose()` 幂等；已 dispose 后调方法抛 `WORKTREE_DISPOSED`。

### 8.3 GitHub 层（全部 mock，不打真 API）

`nock` 或注入 fake octokit。覆盖：createPR 成功；`merge: 'now'` 成功与 405 被保护规则挡；`checksPass` 的 GraphQL 调用；**PR 建成但 auto-merge 失败时仍返回 `ok: true` + `autoMerge.ok: false`**。

可选：`E2E_GITHUB_TOKEN` 存在时才跑的真实冒烟测试，CI 默认跳过。

### 8.4 CI 矩阵

Node 18 / 20 / 22 × git **2.32（声明下限）/ 2.37 / 最新**。

**git 版本矩阵是必需的**：sparse-checkout 与 worktree 组合的行为随版本变化，§3.3 的 2.32 是保守估计，需用矩阵实测出真实下限并回填到 preflight 与本文档。

### 8.5 TDD 顺序

先写 `ConflictParser` 的测试样本，再写实现。冲突模型不应期望一次设计正确，靠真实仓库导出的样本逼出遗漏的类型。

---

## 9. 已识别的风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 冲突类型覆盖不全（delete/modify、rename、binary） | 解冲突产出错误内容 | 样本从真 git 导出；TDD；rename 只识别不自动解 |
| worktree + sparse-checkout 的 git 版本下限不确定 | 低版本上 sparse 配置跨 worktree 污染 | CI 版本矩阵实测下限；preflight 硬性拦截 |
| worktree 泄漏（进程 kill / 冲突态滞留） | 磁盘增长 | `withSession` 保证释放；启动 `worktree prune`；`gc()` 按时间/容量回收 |
| 多进程共享同一 `root` | 并发损坏对象库 | 设计上明确不支持；部署要求 StatefulSet + RWO PV。如未来必须共享，需引入外部锁并重新评估 git-on-NFS 风险 |
| partial clone 惰性拉取 blob | `log -p` / `diffSummary` 产生隐式网络延迟甚至大量下载 | 默认 `--name-only`；`merge:'auto'` 的 diff 强制 `--name-only`；文档明示 |
| worktree 创建顺序写错 | 全量拉取 blob，"只下载指定目录"失效 | §3.5 固定顺序；集成测试断言对象数量 |
| token 泄露到日志或 `.git/config` | 安全事故 | 只用 `-c http.extraheader` 注入；统一脱敏 + 专项单测 |
| 冲突态 worktree 长期滞留 | 占磁盘、语义不清 | 不自动清理（避免丢改动），但 `gc()` 需能报告这类 worktree 供宿主处置 |

---

## 附录 A：实现记录（2026-08-29）

本节记录实现过程中相对上文设计的**实际偏离**与**新发现**。上文保留原设计以便对照；
以本节为准。

### A.1 技术选型偏离

| 项 | 设计 | 实际 | 原因 |
| --- | --- | --- | --- |
| git 进程层 | simple-git | `node:child_process.execFile` | simple-git 的 `timeout` 是**无输出超时**而非总时长超时，无法实现 §5.1 要求的单条命令总超时；且在 `GitExecutor` 这套设计下参数传递、并发队列、进度解析、错误映射全部自理，simple-git 只会被当作 `.raw()` 透传使用，价值接近于零。 |
| 类型声明产物 | tsup `dts: true` | `tsc -p tsconfig.build.json` | tsup 的 rollup-plugin-dts 在 TypeScript 5.9 下崩溃（`useCaseSensitiveFileNames`）。ESM/CJS 仍由 tsup 产出。 |

### A.2 实现中发现的缺陷（设计未覆盖）

1. **rebase 冲突没有 `MERGE_HEAD`。**
   原设计的 merge 状态判定只看 `MERGE_HEAD`，会把停在 rebase 冲突中的 worktree 误判为
   干净，`withSession` 随即将其删除，丢失冲突现场。
   → 新增 `operationInProgress(): 'merge' | 'rebase' | 'cherry-pick' | null`，同时检查
   `MERGE_HEAD`、`rebase-merge` / `rebase-apply` 目录与 `CHERRY_PICK_HEAD`。

2. **rebase 中 `git commit` 会静默出错。**
   它"成功"提交，但把 rebase 卡在未完成状态与游离 HEAD 上。
   → `commit()` 在 rebase 进行中直接抛 `INVALID_ARGUMENT` 并指向新增的
   `continueRebase()`；`abortMerge()` 按当前操作分派到 `merge/rebase/cherry-pick --abort`。

3. **rebase 期间 git 的 stage 2/3 语义是反的。**
   stage 2 是被 rebase 到的上游，stage 3 才是正在重放的提交。原样透传会让宿主
   `take: 'ours'` 拿到对方的内容 —— 这是会静默产出错误结果的一类缺陷。
   → 统一归一化：`ours` 永远表示**当前分支的改动**，发生交换时置
   `Conflict.sidesSwapped = true`（`raw` 保持 git 原始顺序），`resolveByHunks` 在套用前
   把 choices 换回去。`deleted_by_them` / `deleted_by_us` 同样对调。

4. **session 的 author 写进了共享 `.git/config`。**
   并发创建 20 个 session 时争抢 `config.lock`（间歇性失败），且所有 session 共用同一个
   身份。
   → 改用 `git config --worktree`（`extensions.worktreeConfig` 正为此而设）。

5. **CRLF 文件的冲突标记解析失败。**
   `=======\r` 不匹配 `/^=======$/`，导致整个冲突块解析崩溃。
   → 标记检测前统一去掉行尾 `\r`；内容行保留原样以保证写回字节一致。

6. **`SessionConfig.retryOnReject` 未被传递给 `GitRepo`**，session 级配置静默失效。
   → 已修复并补回归测试。

7. **`publish` 无法返回冲突。**
   原设计让它走 `withSession`，而 `withSession` 在冲突时抛 `MERGE_IN_PROGRESS`，
   把 `PushResult` 的 conflict 分支吞掉。
   → `publish` 自行管理 session：冲突时**返回**结果并保留 worktree，其余情况释放。
   `PushResult` 的 conflict 分支新增 `worktreeDir` 字段供 `attachSession` 接管。
   → 新增 `dispose({ keepWorktree })`，让保留 worktree 的同时能释放 store 引用计数
   （否则 `activeSessions` 永远降不回来，`gc` 会被永久阻塞）。

### A.3 git 行为确认

- **cone 模式的 sparse-checkout 总是包含仓库根目录的文件**（如 `README.md`）。
  这是 git 的固有行为，无法关闭。本包的 `PathGuard` 仍拒绝对根文件的写入，
  使实际可写范围严格等于声明的 `sparsePaths`。
- **rename/rename 冲突在索引中是三条各只有一个 stage 的记录**
  （base 在旧路径、ours 在我方新路径、theirs 在对方新路径），而非同一路径上的多 stage。
  归组依赖 `git diff --name-status -M`；映射缺失时退化为按单条上报，不抛错阻塞。

### A.4 API 增补

`exists()` · `merge(ref, opts)` · `continueRebase()` · `operationInProgress()` ·
`recover({ abortOperation, clearIndexLock })` · `RepoStore.forge` getter ·
`dispose({ keepWorktree })` · `gc({ maxAgeDays | maxAgeMs })`

`setSparsePaths` 接受 `SparsePathInput[]`（字符串简写与对象混用）而非要求完整的
`SparsePath[]`。

### A.5 未实现

- `gc({ maxTotalBytes })` —— 需要递归统计目录体积，当前只按空闲时长回收。
- SSH 认证、GitLab/Bitbucket：按原设计不在第一版范围内，接口已预留。

### A.6 验证状态

- **288 个测试全部通过**（`bun test`），其中集成测试用本地 bare 仓库，不联网。
  包含 20 个 session 的并发压力测试、五类冲突的真 git 覆盖、二进制字节一致性、
  以及"创建 sparse worktree 期间不发生全量 blob 拉取"的对象计数断言。
- 本地实测 git 版本为 **2.50.1**。**声明下限 2.32 尚未在本地验证**，
  由 CI 矩阵（`.github/workflows/ci.yml`，node 18/20/22 × git 2.32/system）实测钉死；
  若 2.32 不成立需上调 `MIN_GIT` 并同步本文档。
