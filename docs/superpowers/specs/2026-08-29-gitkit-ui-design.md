# gitkit UI 套件 — 设计文档

**日期**：2026-08-29
**状态**：设计已确认，待评审后进入实现计划
**前置**：[`2026-08-29-git-operation-package-design.md`](./2026-08-29-git-operation-package-design.md)（核心包设计与实现记录）

---

## 1. 目标与场景

给已完成的服务端核心包配一套**前端可直接引用**的 UI 与传输层，使浏览器里的用户可以
**编辑文件 → 提交 → 发起 PR**，并在冲突时以结构化方式解决。

### 首个使用者

**branchkinect-platform 的 platform console，skill 管理功能。**

现状是只读的：`apps/web/platform-console/src/components/agent-quality/skill-source-panel.tsx`
展示「这段提示词来自哪些文件」（路径、字节数、sha256、`uncommitted` 标记、原文）。
本设计要把它变成**可编辑并提交回 git**。

被编辑的内容：

```
prompts/agent-skills/
  catalog.yaml                    ← category → channel 启用矩阵，有强契约
  hvac/{category}/{channel}/*.md  ← skill 正文
  hvac/_base/*.md                 ← 非路由的基础提示词
  common/{category}/{channel}/*.md
```

### 为什么核心包适配这个场景

| 场景特征 | 核心包对应能力 |
| --- | --- |
| monorepo 巨大，只需 `prompts/agent-skills/` 一个目录 | partial clone + cone 模式 sparse checkout |
| `main` 受保护，改动必须走 PR | 主线即「建分支 → 改 → commit → push → 建 PR」 |
| 多个管理员可能同时编辑 | 每个 session 一个独立 worktree |
| `check:skills` 校验 `catalog.yaml` 契约 | `requireChecks` → `merge: 'auto'` 推导为等 CI |

### 技术栈（由使用者决定，不可协商）

- 前端：React 19 · Vite SPA · **shadcn** · **Tailwind v4** · TanStack Query 5 · Radix · lucide
- 后端：**NestJS on Express**，跑在 Bun 上
- 已有编辑器：`@lexical/react`（本设计**不**提供编辑器，只提供外壳与插槽）

### 关键取舍：编辑的是分支，不是线上生效的内容

运行中的 agent 从 `AGENT_PROMPTS_ROOT` 读取提示词；编辑发生在 gitkit 的 worktree 中。
两者分离，改动必须经 **PR → 合并 → 部署** 才生效。

这是**有意为之的审核闸口**，但 UI 必须显式表达，否则管理员会误以为"保存即生效"。
推论：「预览我改后的 skill」必须从 session 的 worktree 读取，而非从 `AGENT_PROMPTS_ROOT` 读。

### 非目标

- **不提供编辑器本体**。宿主通过插槽传入（Lexical / CodeMirror / textarea 均可）。
- **不提供 diff viewer 本体**。内置零依赖的轻量渲染，可通过插槽替换。
- **不做历史浏览**（任意历史 diff、提交历史浏览）。只做"当前这次改动"，理由见 §7.1。
- **不做重命名 API**。git 靠内容相似度自动识别重命名，"新建 + 删除"在历史中等价。
- **不在包内做鉴权与多租户判断**。全部由宿主通过 `resolveSession` 回调决定（§4.2）。
- **不提供 session 创建接口**（默认）。分支命名、author 身份、可编辑目录都是业务策略。
- **不支持多实例共享 session**。见 §4.6 与 §12。

---

## 2. 包划分与依赖方向

**核心包由 `@aaxis/git-operation` 更名为 `@aaxis/gitkit`**（尚未发布，改名零成本）。
理由：短名 `gitop` 与行业既有术语 **GitOps**（声明式基础设施持续交付）冲突，会造成误解。

```
浏览器                                        服务端
┌────────────────────────────┐               ┌──────────────────────────────┐
│ @aaxis/gitkit-ui           │               │ @aaxis/gitkit-server         │
│   /hooks       React hooks │               │   createHandler()            │
│   /components  React 组件   │               │   toExpress() 适配器          │
└──────────┬─────────────────┘               └──────────┬───────────────────┘
           │                                             │
┌──────────▼─────────────────┐   HTTP RPC    ┌──────────▼───────────────────┐
│ @aaxis/gitkit-client       │ ◄───────────► │ @aaxis/gitkit                │
│   框架无关 · 零运行时依赖    │               │  （已完成；本次仅新增 3 个 API） │
└────────────────────────────┘               └──────────────────────────────┘
```

| 包 | 环境 | 运行时依赖 | 职责 |
| --- | --- | --- | --- |
| `@aaxis/gitkit` | 服务端 | 系统 git ≥ 2.32 | 已完成。本次新增 `deleteFile` / `readBuffer` / `getDiff`，**无破坏性改动** |
| `@aaxis/gitkit-server` | 服务端 | gitkit | 把核心暴露为 Web 标准 handler，附 Express 适配器 |
| `@aaxis/gitkit-client` | 浏览器 | **无** | 类型化 RPC client，只用 `fetch` |
| `@aaxis/gitkit-ui` | 浏览器 | client · React 19 · TanStack Query（peer） | hooks 与组件 |

### 硬性约束

1. **`client` 框架无关。** 不 import React。用 Vue/Svelte 或 Node 脚本的消费者只引 client。
2. **`ui` 分两个 subpath**：`@aaxis/gitkit-ui/hooks` 与 `/components`。只要 hooks 的消费者，
   组件代码不会进入 bundle。
3. **共享类型的唯一来源是 `@aaxis/gitkit`。** `client` 以 `import type` 复用 `Conflict`、
   `PushResult`、`HunkChoice` 等，**不产生运行时依赖**。服务端改类型 → 前端编译期报错。
4. **`ui` 不依赖任何 UI 组件库**，不打包 CSS-in-JS，不引 Radix。见 §9。

---

## 3. 仓库结构迁移

当前 `src/` 位于仓库根目录即核心包。需改为 bun workspaces：

```
packages/
  core/      @aaxis/gitkit          ← 由现有 src/ + tests/ 迁入
  server/    @aaxis/gitkit-server
  client/    @aaxis/gitkit-client
  ui/        @aaxis/gitkit-ui
```

- 用 `git mv` 迁移以保留历史。
- 现有 295 个测试**只改路径，不改逻辑**；迁移后必须全部通过，这是迁移完成的判据。
- 包名 `@aaxis/git-operation` → `@aaxis/gitkit`，同步更新 README、spec、CI。

---

## 4. 传输层协议与安全边界

**核心命题：浏览器是不可信输入源。** 服务端绝不能让前端决定"操作哪个仓库、哪个
worktree、用谁的身份"。

### 4.1 handler 形态

```ts
import { createHandler, toExpress } from '@aaxis/gitkit-server'

const handler = createHandler({
  resolveSession,                  // 必填，见 §4.2
  allow: ['status', 'files.list', 'files.read', 'files.write', 'files.delete',
          'changes.list', 'changes.diff', 'commit', 'push', 'sync.pull'],
  serialize: true,                 // 按 sessionId 串行化，默认 true
  maxContentBytes: 1_048_576,      // 默认 1 MB
  exposeDetail: false,             // 默认 false，见 §4.5
})
```

`handler` 的类型是 `(req: Request) => Promise<Response>`（Web 标准 Fetch API），
可直接用于 Hono / Bun / Deno / Cloudflare / Next.js App Router。

NestJS on Express 用附带的适配器：

```ts
@Controller('admin/skills/git')
export class SkillGitController {
  @All('*')
  handle(@Req() req: Request, @Res() res: Response) {
    return toExpress(handler)(req, res)
  }
}
```

### 4.2 安全边界：`resolveSession`

**协议中不存在 `url`、`root`、`worktreeDir`、`token` 字段。** 浏览器只发送一个不透明的
`sessionId`，由宿主解析：

```ts
async function resolveSession(req: Request, sessionId: string): Promise<GitRepo | null> {
  const user = await auth(req)                       // 宿主的鉴权
  const record = await db.skillSessions.find(sessionId)
  if (!record || record.ownerId !== user.id) return null   // 宿主的授权
  return store.attachSession(record.worktreeDir)
}
```

返回 `null` → HTTP 404（**不是 403** —— 不向调用方泄露"该 session 存在但你无权访问"）。

**前端无法枚举 session、无法越权、无法指定任意路径。**

### 4.3 session 创建不在本协议内

分支命名、author 身份、可编辑的 sparse 目录全是业务策略，由宿主自己的接口负责。

针对首个使用者（会话粒度 A：一次编辑提案 = 一个分支）：

```
① 管理员点「编辑 skill」
   → 宿主后端：store.createSession({
       branch: `skills/${user.login}-${ulid()}`,
       sparsePaths: [{ path: 'prompts/agent-skills', requireChecks: true }],
       author: { name: user.name, email: user.email },
     })
   → 记录 sessionId → worktreeDir 到数据库
   → 返回 { sessionId } 给浏览器

② 之后所有编辑/提交请求走本协议，只带 sessionId

③ PR 合并（或放弃）后，宿主调用 repo.dispose() 并删除数据库记录
```

宿主确有需要时，可提供 `createSession(req, params)` 回调由包代为路由，**参数仍由宿主校验**。

### 4.4 RPC 形状

`POST {mount}/{op}`，body 为 JSON `{ sessionId, ...params }`。

用路径而非单一端点，是为了让日志、devtools、APM 能直接看出在做什么。

| op | params | 返回 |
| --- | --- | --- |
| `status` | — | `{ branch, operation, clean, staged, modified, untracked, conflicted }` |
| `files.list` | `dir?` | `{ entries: FileEntry[] }` |
| `files.read` | `path` | `{ content, etag, binary: false }` 或 `{ binary: true, size }` |
| `files.write` | `path, content, baseEtag?, ifNotExists?` | `{ etag }` |
| `files.delete` | `path` | `{ deleted: true }` |
| `changes.list` | — | `{ files: ChangeEntry[] }` |
| `changes.diff` | `path?, against?` | `{ patch, truncated }` |
| `commit` | `message, paths?` | `{ sha, changed }` |
| `push` | `createPR?, merge?, method?` | `PushResult`（**剥除 `worktreeDir`**，见 §4.5） |
| `sync.pull` | `strategy?` | `{ conflicted }` |
| `conflicts.list` | — | `{ conflicts: Conflict[] }` |
| `conflicts.resolve` | `resolutions` | `{ remaining }` |
| `conflicts.resolveByHunks` | `path, choices` | `{ remaining }` |
| `conflicts.continue` | — | `{ done, conflicted }` |
| `conflicts.abort` | — | `{ ok: true }` |

涉及的两个自有类型（其余类型均从 `@aaxis/gitkit` 复用）：

```ts
type FileEntry = {
  path: string
  type: 'file' | 'dir'
  status: 'clean' | 'modified' | 'added' | 'deleted' | 'conflicted'
  binary?: boolean
  size?: number
}

type ChangeEntry = {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'conflicted'
  staged: boolean
}
```

`allow` 未列出的 op 一律 404（**不是 405** —— 未开启的能力不应暴露其存在）。
宿主还可提供 `can(ctx, op)` 做逐请求的细粒度判断。

### 4.5 三条必须做的信息过滤

以下都是会向浏览器泄露服务端信息的位置：

1. **`GitOpError.detail` 与 `command` 默认不返回。** 它们含服务端文件系统绝对路径
   （`/data/repos/github.com/acme/web/wt/s-a3f9…`）。默认响应体只有 `{ code, message }`；
   `exposeDetail: true` 时才带 `detail`，仅供内部工具使用。
2. **`PushResult` 冲突分支中的 `worktreeDir` 必须剥除。** 那是服务端绝对路径，而前端只持有
   `sessionId`，本就用不上。
3. **响应体积上限 `maxContentBytes`（默认 1 MB）。** 冲突的 `ours`/`theirs`/`base` 内容与
   diff 都可能很大。超限则不带 `content`、只给 `oid`/`size` 并置 `truncated: true`，
   由 UI 显示"文件过大，无法在线编辑"。

### 4.6 并发：同一 session 的多个请求

核心包按"一个 session 一个所有者"设计，worktree 内部无锁。但浏览器里用户可能开两个标签页，
或连续快速触发自动保存 —— 两个请求同时写同一个索引会撞 `index.lock`。

**`serialize: true` 时，server 包按 `sessionId` 在进程内串行化请求**（复用核心包的
`StoreMutex` 模式）。这些操作都是毫秒级的，排队代价可忽略。

**多实例部署时进程内队列不足。** 宿主需要把同一 session 路由到同一实例（sticky session），
或自行引入分布式锁。本包**不假装解决这个问题**，只在文档中写明前提。

### 4.7 错误码到 HTTP 状态的映射

响应体统一为 `{ error: { code, message } }`。`code` 的取值是 **`GitErrorCode` 的全集
再并上 server 包自有的几个**（`SESSION_NOT_FOUND`、`OP_NOT_ALLOWED`、`STALE_ETAG`、
`ALREADY_EXISTS`）—— 后者描述的是传输层自身的失败，核心包里不存在对应概念。

| 错误码 | HTTP | 说明 |
| --- | --- | --- |
| `SESSION_NOT_FOUND` | 404 | 不区分"不存在"与"无权限" |
| `OP_NOT_ALLOWED` | 404 | 不暴露未开启能力的存在 |
| `INVALID_ARGUMENT` · `PATH_OUTSIDE_SPARSE` · `PATH_TRAVERSAL` | 400 | |
| `STALE_ETAG` | 409 | 响应带服务端当前 `content` 与 `etag` |
| `ALREADY_EXISTS` | 409 | `ifNotExists: true` 但路径已存在 |
| `BRANCH_IN_USE` · `BRANCH_EXISTS` · `BRANCH_NOT_FOUND` · `MERGE_IN_PROGRESS` · `DIRTY_WORKTREE` | 409 | |
| `WORKTREE_DISPOSED` | 410 | session 已销毁，UI 应引导重新开始 |
| `AUTH_FAILED` | 502 | **上游** git 认证失败，不是浏览器用户未登录 |
| `NETWORK` · `TIMEOUT` | 504 | |
| `FORGE_NOT_INSTALLED` | 501 | |
| 其余 | 500 | |

**`AUTH_FAILED` 映射为 502 而非 401 至关重要**：401 会让前端的拦截器误判为用户会话过期
并触发重新登录，而实际问题是服务端的 GitHub token 失效。

---

## 5. 编辑与保存

### 5.1 自动保存策略

工作区（worktree）是唯一真相。用户的每次编辑最终都落到服务端磁盘，因此换设备、刷新页面、
进程重启都能续上 —— 这是"worktree 挂在 PV 上"相对纯浏览器编辑器的固有优势。

| 触发 | 时机 |
| --- | --- |
| 防抖保存 | 停止输入 **800 ms** |
| 强制保存 | 连续输入时每 **5 s** 至少落一次（防抖 maxWait） |
| 失焦保存 | 编辑器 blur |
| 切换文件前 | 必须先落盘，否则拒绝切换 |
| 页面隐藏 | `visibilitychange → hidden` 时 `fetch(..., { keepalive: true })` |

状态机（对外暴露供 UI 显示）：

```
clean ──输入──► dirty ──防抖到期──► saving ──成功──► saved ──► clean
                  ▲                     │
                  └──────── error ◄─────┘     内容保留在浏览器，可重试
```

### 5.2 乐观并发控制（必须有，否则静默丢数据）

用户正在编辑 `hvac/pricing/voice/core.md` 时，服务端该文件可能被改动 —— 另一个标签页保存了，
或触发了一次 `sync.pull` 把远端改动合了进来。此时直接写入会**无声覆盖**那些改动。

```
files.read   → { content, etag }              etag = 内容 UTF-8 字节的 sha256（hex）
files.write  → { path, content, baseEtag }
               服务端读取当前内容并计算 etag
               ├─ 与 baseEtag 一致 → 写入，返回新 etag
               └─ 不一致 → 409 { code: 'STALE_ETAG', etag, content }
```

`baseEtag` 省略时**跳过检查**（用于明知要覆盖的场景），但 `ui` 的 `useFile` 始终传。

409 时 UI 给三个选项：**覆盖** / **查看差异** / **放弃我的改动**。
不做自动三方合并 —— 那属于阶段 2，复用冲突解决那套。

etag 由 `gitkit-server` 计算，**核心包不需要改动**。

### 5.3 新建与删除

- **新建**：`files.write` 到不存在的路径即可，中间目录自动创建（`FsGateway` 已实现）。
  带 `ifNotExists: true` 时若路径已存在返回 409，防止误覆盖。
- **删除**：`files.delete`。删除工作区文件；`commit` 时核心包的 `git add -A` 会记录为删除。
- **范围**：全部经 `PathGuard`。越出声明的 sparse 目录返回 400 + `PATH_OUTSIDE_SPARSE`，
  前端得到明确错误码而非神秘失败。

### 5.4 二进制文件

`files.read` 先用 `readBuffer` 探测 NUL 字节。是二进制则返回 `{ binary: true, size }` 且
**不带 content**，UI 显示"二进制文件，不可编辑"，只允许删除。

---

## 6. 核心包的增补

仅新增三个 API，**不改动任何现有公开接口**：

| API | 用途 |
| --- | --- |
| `GitRepo.deleteFile(path)` | 删除文件，经 `PathGuard` |
| `GitRepo.readBuffer(path)` | 二进制探测（`FsGateway.readBuffer` 已实现，仅需暴露） |
| `GitRepo.getDiff(opts)` | 当前改动的 diff |

`getDiff` 的签名与约束：

```ts
getDiff(opts?: {
  paths?: string[]        // 省略则用 session 的 sparsePaths
  against?: string        // 省略 = 工作区 vs HEAD；传 base 则为 base...HEAD
  context?: number        // 上下文行数，默认 3
}): Promise<{ patch: string; truncated: boolean }>
```

**`paths` 强制经 `PathGuard` 校验，越界直接抛错。** 这条使得"UI 在物理上无法 diff 声明范围
之外的内容"成为不变量，而非依赖调用方自觉。

---

## 7. Diff 与历史：范围与理由

### 7.1 只做"当前改动"，不做历史浏览

在 partial clone 中，任何需要文件**内容**的 diff 都会向 promisor remote **惰性拉取 blob**。
实测（3 次提交，`docs/` 与 `src/` 各有改动）：

| 操作 | 缺失 blob 数 |
| --- | --- |
| `clone --filter=blob:none` | 9 |
| `git diff HEAD~2 HEAD -- docs/` | 9 → **7**（只取了 docs/ 下的 2 个） |
| `git diff HEAD~2 HEAD`（不限 pathspec） | 7 → **3**（又取了 src/ 下 4 个，含大文件） |

**结论：pathspec 限制有效，diff 只拉取该路径下的 blob。** 因此 §6 强制 `paths` 经 `PathGuard`。

但还有三个残留问题，它们**只在浏览任意历史时成立**：

1. **diff 变成网络操作且会硬失败。** promisor remote 不可达时实测报
   `fatal: Could not read from remote repository.`。完整 clone 里 diff 是纯本地的、不可能失败。
2. **取回的 blob 永久累积**在本地对象库中。
3. **`depth` 浅克隆直接截断历史**，历史面板会撞墙。

**只做"当前改动"就让这三个问题全部消失：**

| 保留的场景 | 网络成本 |
| --- | --- |
| 工作区 vs HEAD（我改了什么还没提交） | **零** —— blob 本就在工作区 |
| `base...HEAD`（本次 PR 的完整 diff） | **极小** —— 三点 diff 只取 merge-base 侧、且只取改动过的文件 |
| 本次 session 的提交列表（`log base..HEAD`） | **零** —— 只读 commit 对象 |
| 文件树 / 文件内容 | **零** —— 就是 sparse 范围内的工作区 |

真要看完整历史，GitHub 网页版即可，无需在宿主 app 中重做。

### 7.2 Diff 渲染可插拔

内置一个**零依赖的轻量统一 diff 渲染器**（git 已输出统一 diff 格式，渲染带 +/- 着色的视图
约 100 行代码），同时暴露 `renderDiff` 插槽：

```tsx
<DiffView path="…" />                                   // 开箱即用，零额外依赖
<DiffView path="…" renderDiff={(patch) => <Monaco …/>} />  // 换成任意实现
```

三条理由：**开箱可用**（不装任何东西就能跑）、**bundle 小**（`monaco-editor` 2 MB+ 不该由本包
替消费者决定）、**有逃生口**。

已核实可用的替换候选（均为 MIT，2026 年内有更新）：
`react-diff-viewer-continued@4.4.0` · `@git-diff-view/react@0.1.7` · `diff2html@3.4.56` ·
`@codemirror/merge@6.12.2` · `monaco-editor@0.56.0`。

---

## 8. 组件与 hooks API

### 8.1 分层

```
@aaxis/gitkit-ui/hooks        逻辑，基于 TanStack Query，无任何 UI
@aaxis/gitkit-ui/components   组件，依赖 hooks
```

**hooks 基于 `@tanstack/react-query`（peer dependency，^5）**，而非自建缓存 —— 首个使用者已在用
5.90，自建缓存会产生两套并存的请求状态与失效逻辑。

### 8.2 Provider 与 hooks

```tsx
<GitkitProvider client={createClient({ baseUrl: '/api/admin/skills/git' })} sessionId={id}>
  …
</GitkitProvider>
```

| hook | 返回 |
| --- | --- |
| `useSessionStatus()` | 分支、进行中的操作、是否干净、各类文件计数 |
| `useFileTree(dir?)` | 目录树 + 每个条目的 `modified / added / deleted / conflicted` 标记 |
| `useFile(path)` | `{ content, etag, binary, state, setContent, save, saveState, staleConflict }` |
| `useChanges()` | 本次改动的文件列表 |
| `useDiff({ path?, against? })` | `{ patch, isLoading, error }` |
| `useCommit()` | `mutate({ message, paths? })` |
| `usePush()` | `mutate({ createPR?, merge?, method? })` → `PushResult` |
| `useConflicts()` | 阶段 2 |

`useFile` 内部实现 §5.1 的自动保存状态机与 §5.2 的 etag 检查；`staleConflict` 非空时组件应
呈现"覆盖 / 查看差异 / 放弃"三选一。

### 8.3 组件

| 组件 | 说明 |
| --- | --- |
| `FileTree` | sparse 范围内的目录树，带改动标记；支持新建/删除 |
| `FileEditor` | **外壳，不含编辑器**。负责加载、脏标记、自动保存、etag 冲突提示；编辑器经 render prop 传入 |
| `ChangeList` | 本次改动的文件列表，点击定位 |
| `DiffView` | 当前改动的 diff，内置轻量渲染 + `renderDiff` 插槽 |
| `CommitPanel` | commit message → push → 建 PR → 选合并模式 → 展示结果 |
| `SyncStatus` | ahead/behind、触发 `sync.pull` |
| `ConflictResolver` | 阶段 2：逐块选边 / 整文件选边 / 手改 |

`FileEditor` 的插槽形态：

```tsx
<FileEditor path="prompts/agent-skills/hvac/pricing/voice/core.md">
  {({ content, onChange, saveState, binary }) =>
    binary
      ? <BinaryNotice />
      : <YourLexicalEditor value={content} onChange={onChange} />}
</FileEditor>
```

### 8.4 合并模式在 UI 中的呈现

`CommitPanel` 默认发送 `merge: 'auto'`，由核心包按 `sparsePaths` 的 `requireChecks` 推导。

**针对首个使用者的取舍：`prompts/agent-skills` 整体设为 `requireChecks: true`。**

原因是 sparse path 的粒度是**目录级**（cone 模式的固有限制），而 `catalog.yaml` 与 skill 正文
`.md` 同处 `prompts/agent-skills/` 之下，无法表达"改正文免检、改 catalog 必须等 CI"。
`check:skills` 很快，全部等 CI 是安全且可接受的默认。

`CommitPanel` 同时提供一个显式的"立即合并"选项（发送 `merge: 'now'`），供宿主在明确只改了
正文时使用。**判断"改了什么"的知识在宿主的业务层，不放进包内** —— 与核心设计中砍掉
`mergePolicy` 规则引擎是同一条理由。

---

## 9. 样式与主题

**shadcn/ui 不是一个可依赖的 npm 包** —— 它是复制进消费者仓库的源码，底层是 Radix + Tailwind。
因此本包不能 `import { Button } from 'shadcn'`。

采用的方案：

1. **只使用 shadcn 的语义 token 类名** —— `bg-background`、`text-muted-foreground`、
   `border-border`、`bg-muted/20` 等。shadcn 的主题全靠 CSS 变量，因此组件会**自动跟随消费者的
   主题**（含暗色模式），而本包**零 UI 依赖、不打包任何 CSS、不引 Radix**。

2. **消费者需在 Tailwind v4 配置中加一行**扫描本包产物：

   ```css
   @source "../node_modules/@aaxis/gitkit-ui/dist";
   ```

3. **`components` 注入插槽**，可替换为消费者自己的 shadcn 组件：

   ```tsx
   <GitkitProvider components={{ Button, Dialog, ScrollArea, Badge }}>
   ```

   不传则退化为带正确 token 类名的原生元素，仍然开箱可用且视觉一致。

4. **开发期缺失检测**：`NODE_ENV !== 'production'` 时检查 `--background` 等 CSS 变量是否存在，
   缺失则 `console.warn` 提示第 2 步未配置。这是本方案最容易踩的坑（忘记加 `@source` 会让组件
   完全没有样式却不报错），必须主动提示。

---

## 10. 阶段划分

每个阶段独立可用、独立发版。

**阶段 1 —— 主链路：编辑 → 提交 → PR**

- 仓库迁移为 monorepo 并更名（§3）
- 核心包新增 3 个 API（§6）
- `gitkit-server`：`status` · `files.*` · `changes.*` · `commit` · `push` · `sync.pull`
- `gitkit-client`：全部 op 的类型化封装
- `gitkit-ui`：`FileTree` · `FileEditor` · `ChangeList` · `DiffView` · `CommitPanel` · `SyncStatus`
- 冲突只做**最小处理**：`push` 返回冲突时提示并提供"放弃合并"，保证主链路不被卡死

**阶段 2 —— 冲突解决**

- `conflicts.*` 全部 op
- `ConflictResolver` 组件：整文件选边 / 逐块选边 / 手改 / rename 与二进制的特殊呈现
- §5.2 的 etag 409 支持"自动三方合并"选项，复用同一套

**阶段 3 —— 按需**

- PR 向导细化（模板、reviewer、label）
- 与 `@lexical/react` 的深度集成示例
- 更强的 diff viewer 适配器

---

## 11. 测试策略

延续核心包的分层原则：**能纯单测的一律纯单测**。

**`gitkit-server`**

- *纯单测（无 git、无网络）*：op 路由与参数校验、`allow` 收窄、错误码 → HTTP 映射、
  **`detail`/`command`/`worktreeDir` 的剥除**、`maxContentBytes` 截断、etag 计算与比对。
  用 fake `GitRepo` 注入。**信息过滤必须有专门用例**，逐条断言响应体中搜不到服务端路径。
- *集成测试*：真 git + 本地 bare 仓库（复用核心包的 `tests/helpers/fixtures.ts`），
  跑通 read → write → commit → push 全链路。
- *并发*：同一 sessionId 并发 10 个写请求，断言全部成功且无 `index.lock` 错误。

**`gitkit-client`**：`fetch` 打桩，断言请求形状、错误反序列化、超时与中止。

**`gitkit-ui`**

- hooks：React Testing Library + 注入 fake client。**重点覆盖自动保存状态机**
  （防抖、maxWait、blur、切换文件、`visibilitychange`）与 **etag 409 的三条分支**。
  时间用假时钟，不用真实 `setTimeout` 等待。
- 组件：渲染 + 交互断言，不做像素级快照。
- **不在 `ui` 包里跑真 git**。所有 git 行为由 fake client 提供。

**跨包契约**：`client` 与 `server` 共享一份 op 定义表，`bun run typecheck` 即为契约测试 ——
op 名称、参数、返回类型任一不一致都在编译期失败。

**CI**：沿用核心包的矩阵（node 18/20/22 × git 2.32/system），新增浏览器侧的 happy-dom 环境。

---

## 12. 已识别的风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 消费者忘记配置 Tailwind `@source` | 组件完全没有样式且不报错 | 开发期检测 CSS 变量并 `console.warn`（§9.4） |
| 多实例部署下 per-session 串行化失效 | 并发写撞 `index.lock` | 文档明确要求 sticky session；包内不假装解决 |
| session 生命周期与 PR 状态脱节 | PR 合并后 session 仍在，用户继续编辑一个已过时的分支 | `WORKTREE_DISPOSED` → 410，UI 引导重新开始；宿主负责在 PR 合并后 `dispose()` |
| `requireChecks` 粒度不足（目录级） | 无法表达"正文免检、catalog 等 CI" | 默认全部等 CI；提供显式 `merge: 'now'` 逃生口 |
| shadcn token 名称随版本变化 | 组件视觉错位 | 只使用最稳定的一组核心 token；在文档中列出依赖的变量清单 |
| 自动保存产生的请求量 | 服务端压力 | 800 ms 防抖 + 5 s maxWait；写入是普通文件写，成本极低 |
| 大文件 / 大 diff | 浏览器卡顿或 OOM | `maxContentBytes` 截断 + `truncated` 标记，UI 显式降级 |
| monorepo 迁移引入回归 | 已有 295 个测试失效 | 迁移只改路径不改逻辑；全部通过是迁移完成的判据 |
