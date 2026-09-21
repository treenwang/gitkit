# @treenwang/git-operation — design document

**Date**: 2026-08-29
**Status**: design confirmed, pending review before the implementation plan

---

## 1. Goals and scenario

An npm package, embeddable in other Node applications, for operating on Git
repositories programmatically on a **remote server**. Its core capabilities:

1. Configure the basic properties of a Git repository, optionally naming zero or
   more folder paths. Once named, **only those directories are checked out** and
   the rest of the code never reaches disk.
2. Offer the basic git operations: clone, pull, commit, push, merge, branch,
   log, diff.
3. Offer a **programmatic conflict resolution API**: merge conflicts come back
   as structured data and the host application decides how to resolve them.
4. Optionally integrate with GitHub: open a pull request, and configure whether
   to merge immediately or wait for CI.

### Runtime assumptions

- Node.js >= 18; the build output is Node-compatible ESM and CJS.
- **`git >= 2.32`** installed on the host (see §3.3: the worktree plus
  sparse-checkout combination is defective in earlier versions).
- Authentication through an **HTTPS personal access token**.
- **Storage: each process owns its own `root` directory** - under Kubernetes
  that is a StatefulSet with a ReadWriteOnce PV, or an ephemeral volume.
  Several processes sharing one `root` is not supported.
- **Concurrency model**: every concurrent task works in its own **git
  worktree** on its own new branch, without interfering (see §3.2).
- **External writes**: other people may push to the same remote through other
  git clients, so a rejected push and a conflicting pull are normal paths.
- The target branch, `main` typically, is usually protected, so **every change
  has to go through a pull request**. The package never pushes to a protected
  branch directly.

### Non-goals, stated explicitly

- No support for environments without a git binary - isomorphic-git cannot do
  partial clone or sparse checkout.
- **No support for several processes or pods sharing one `root` directory**, so
  no cross-process file locks and no distributed locks.
- No SSH authentication; the interface leaves room for it but the first version
  does not implement it.
- No GitLab or Bitbucket; the `ForgeProvider` interface leaves room for them,
  only GitHub is implemented.
- No calls into external tools that need an interactive TTY, such as
  `git mergetool`.
- No general rule engine over "which files changed" (a `mergePolicy`).
- No non-cone sparse-checkout; directory prefixes only, which is cone mode.
- No automatic resolution of rename/rename conflicts; they are detected and
  reported only.
- No checking out one branch in two worktrees at once - git forbids it, and this
  package's one-branch-per-task model is unaffected.

---

## 2. Technology choices

| Decision | Choice | Reasoning |
| --- | --- | --- |
| Git implementation | **simple-git**, wrapping the system git CLI | The only viable way to do partial clone plus sparse checkout. isomorphic-git does not support it; nodegit is unworkable both to install and to use. |
| Concurrency isolation | **git worktree**, one per task | A single object database, which saves disk, with an independent HEAD and index, which makes it genuinely concurrent, and no cross-process locks. |
| Development tooling | **npm workspaces** and **Vitest** (`npm test`) | Source and tests use standard Node APIs only and are not tied to any particular runtime. |
| Bundling | **tsup**: ESM, CJS and `.d.ts` | The host may be Node, Electron or Next.js. |
| GitHub | **`@octokit/rest`** as an optional peerDependency | Without it, the core git features remain fully available. |

---

## 3. The concurrency model, the heart of this design

### 3.1 Why a shared working tree does not work

git's own `index.lock` protects **a single command**. The real risk is a
**logical race across several commands**:

```
task A: createBranch('feat/a')  →  writeFile  →  commit
task B:                    checkout('feat/b')  ↑
                                          A commits onto feat/b here
```

`HEAD`, the index and the working tree files are shared mutable state across the
whole directory. The push flow is longer still (`push`, rejected, `pull`,
resolve, `commit`, push again), and having the branch switched underneath it
**silently produces the wrong commit** without raising anything.

### 3.2 The chosen model: store plus worktree

```
{root}/github.com/acme/web/
  store/                    ← shared: git clone --filter=blob:none --no-checkout
    .git/                     object database, refs, remote config. Working tree always empty.
  wt/
    task-<id>-1/            ← task 1's worktree: its own HEAD, index and sparse config
    task-<id>-2/            ← task 2's worktree
```

- **One object database**, cloned once, so disk cost stays low.
- Each worktree **has its own HEAD and index**, so tasks never interfere.
- Each worktree **can have its own sparsePaths**, written to
  `.git/worktrees/<name>/info/sparse-checkout`.
- **The partial clone filter is a property of the object database**, set once
  when the store is created, and every worktree benefits.

**The store has to use `--no-checkout`, not `--bare`.** `git clone --bare` does
not write a `remote.origin.fetch` refspec, so later `git fetch` calls do not
update `refs/remotes/origin/*` and the configuration has to be patched by hand.
`--no-checkout` gives a fully configured ordinary repository whose working tree
happens to be empty, which is exactly what is wanted.

Immediately after creating the store:

```
git config extensions.worktreeConfig true
```

This is the prerequisite for sparse-checkout settings landing in **each
worktree's own config** rather than polluting the shared one. Recent git
versions turn it on when needed, but setting it explicitly removes the version
difference.

### 3.3 The `git >= 2.32` requirement

The `git sparse-checkout` command arrived in 2.25, but **combined with a linked
worktree**, early versions write `core.sparseCheckout` into the shared config
rather than the worktree's own (which needs `extensions.worktreeConfig`), so one
worktree's sparse settings contaminate the others.

**2.32 is a conservative floor; the exact floor has to be pinned down during
implementation with a CI version matrix** (see §7.4). Preflight throws
`GIT_VERSION_TOO_OLD` for anything below it.

### 3.4 The two things that still need serializing, in-process only

Worktrees share an object database and refs, so these store-level operations
need an **in-process mutex keyed by store path**:

1. **`git fetch`** - writes refs and objects. Concurrent fetches can fail on ref
   lock contention.
2. **`git worktree add` / `remove` / `prune`** - writes `.git/worktrees/`.

**Everything else is unlocked.** `writeFile`, `commit`, `resolveConflicts` and
`push` inside a worktree are all safe to run concurrently.

**`pull` has to be split in two**, or it would violate the "`GitRepo` never
locks" constraint (§4, hard constraint 3):

```
repo.pull()  ≡  store.fetch()            ← store level, through StoreMutex
              + repo.mergeFetchHead()    ← worktree level, unlocked
```

`push` needs **no** local lock: it writes remote refs and never touches shared
mutable state in the local object database, and races on the remote side are
handled by the non-fast-forward rejection mechanism (§5.5).

Because a single process owns `root` by assumption (§1), an in-process mutex is
enough. **No file locks and no Redis or database distributed locks.**

### 3.5 The worktree creation order, which matters

**Create the empty worktree first, configure sparse second, check out last.**
Getting the order wrong defeats the central requirement of downloading only the
named directories:

```
git worktree add --no-checkout -b <branch> <path> <base>
git -C <path> sparse-checkout init --cone
git -C <path> sparse-checkout set <paths...>
git -C <path> checkout
```

**Why**: `git worktree add` checks out the full working tree by default. Under a
partial clone (`--filter=blob:none`) that makes git **lazily fetch every blob in
the repository** from the promisor remote - slow, and it downloads exactly the
code that was supposed to stay away. `--no-checkout` creates an empty worktree;
checking out after sparse is configured fetches only the blobs the named
directories need.

With `sparsePaths` empty (full mode), skip the two middle steps and check out
directly.

### 3.6 Worktree lifecycle

- **Release**: `session.dispose()` runs `git worktree remove --force <path>`.
- **`withSession()` guarantees the release** (see §4.3), so a host that forgets
  to dispose does not leak disk.
- **Crash residue**: a killed process leaves orphaned worktree directories.
  `RepoManager` runs `git worktree prune` once per store at startup and clears
  unowned directories under `wt/` by prefix. **This is startup cleanup, not
  runtime cleanup** - leftover merge state at runtime is still never handled
  automatically (see §6.3).

---

## 4. Architecture

Dependencies point **strictly downward**. Layer 2 may not import Layer 3;
Layer 1 may not import Layer 2.

```
Layer 3 · API (the only way out)
  RepoManager      store lifecycle, clone dedup, preflight, startup cleanup
  RepoStore        the shared object database for one URL; creates and reclaims worktree sessions
  GitRepo          the facade bound to a single worktree, holding every git operation
  GitHubProvider   the GitHub implementation of ForgeProvider

Layer 2 · domain (pure logic, no IO, unit-testable on its own)
  ConflictParser   stage table plus conflict markers to Conflict[]
  ConflictWriter   Resolution[] / HunkChoice[] to file contents
  MergeSession     the merge state machine, with state derived from disk on demand
  SparseManager    sparsePaths normalization, cone validation, requireChecks
  PushPolicy       push retry decisions and merge mode derivation
  PathGuard        paths must stay inside the sparse range; guards against traversal
  ErrorMapper      git stderr to a structured error code
  LayoutPlanner    url to store and worktree paths (pure string computation)

Layer 1 · execution (the only place that touches processes and files)
  GitExecutor      the only place that spawns git: auth injection, timeouts, onProgress, scrubbing
  StoreMutex       an in-process mutex keyed by store path, for fetch and worktree changes only
  FsGateway        readFile / writeFile / listFiles, constrained by PathGuard
```

### Directory structure

```
src/
  index.ts                    # re-exports the public API and types, nothing else
  api/        repo-manager.ts  repo-store.ts  git-repo.ts
  forge/      types.ts  github-provider.ts
  domain/     conflict-parser.ts  conflict-writer.ts  merge-session.ts
              sparse-manager.ts  push-policy.ts  path-guard.ts
              error-mapper.ts  layout-planner.ts
  exec/       git-executor.ts  store-mutex.ts  fs-gateway.ts
  types.ts                    # public types
```

### Hard constraints

1. **`GitExecutor` is the only place that spawns git.** `spawn` or `exec`
   anywhere else is a bug.
2. **Nothing in Layer 2 touches IO.** Its inputs and outputs are strings and
   plain objects.
3. **Only `RepoStore` may call `StoreMutex`.** `GitRepo` never locks - if a
   `GitRepo` method needs a lock, it is operating on store-level state and
   belongs on `RepoStore`.
4. **`GitRepo` knows nothing of `RepoManager`**, so a test can construct one
   directly on any worktree.

---

## 5. Public API

### 5.1 Configuration

```ts
type SparsePath = { path: string; requireChecks?: boolean }   // requireChecks defaults to true

interface ManagerConfig {
  root: string                             // owned by this process
  auth?: { token: string }                 // global default
  gitPath?: string                         // 'git' by default
  timeout?: number                         // per command, 120_000 ms by default
  onProgress?: (e: ProgressEvent) => void
}

interface StoreConfig {
  url: string
  auth?: { token: string }                 // overrides the global one
  depth?: number                           // undefined by default, meaning full history
  filter?: string | false                  // 'blob:none' by default; false disables partial clone
}

interface SessionConfig {
  branch: string                           // this task's branch name
  branchMode?: 'create' | 'reuse' | 'createOrReuse'   // 'createOrReuse' by default
  base?: string                            // the remote HEAD by default
  sparsePaths?: (string | SparsePath)[]    // omitted or empty means a full checkout
  author: { name: string; email: string }
  retryOnReject?: boolean                  // after a rejected push, pull and retry once; true by default
}

type ProgressEvent = {
  phase: 'clone' | 'fetch' | 'pull' | 'push' | 'checkout' | 'worktree'
  message: string        // a scrubbed line of git stderr
  percent?: number
}
```

The string shorthand `'docs'` is equivalent to
`{ path: 'docs', requireChecks: true }`, the conservative default.

`branchMode` semantics:

| Value | Branch exists, locally or on the remote | Branch does not exist |
| --- | --- | --- |
| `'create'` | throws `BRANCH_EXISTS` | created from `base` |
| `'reuse'` | checked out and tracking the remote | throws `BRANCH_NOT_FOUND` |
| `'createOrReuse'` (default) | checked out and tracking the remote | created from `base` |

In any mode, if that branch is already checked out in **another worktree**, the
result is `BRANCH_IN_USE` - git forbids it.

### 5.2 RepoManager and RepoStore

```ts
const manager = new RepoManager({ root: '/data/repos', auth: { token: process.env.GH_TOKEN } })

const store = await manager.store({ url: 'https://github.com/acme/web' })
// Idempotent: clones if absent (--filter=blob:none --no-checkout --sparse), reuses if present
```

What `RepoManager` is responsible for - **no business git operations at all**:

1. **Directory layout**: delegated to `LayoutPlanner`;
   `https://github.com/acme/web` becomes `{root}/github.com/acme/web/`.
2. **Clone dedup**: an in-flight Promise map, so concurrent first requests clone
   exactly once.
3. **Preflight**: `git --version` once on first use, with the result cached;
   below 2.32 throws `GIT_VERSION_TOO_OLD`, and a missing binary throws
   `GIT_NOT_FOUND`.
4. **Startup cleanup**: `git worktree prune` for every existing store, plus
   clearing orphaned directories under `wt/`.
5. **Disk reclamation**: `manager.evict(url)` and
   `manager.gc({ maxAgeDays, maxTotalBytes })`.
   **A store has to keep a refcount of active sessions**: `evict` and `gc` skip
   a store that still has active sessions and report it in their result. An
   object database in use is never deleted.

### 5.3 The main workflow

The target branch is protected, so the main path is fixed as open a session,
create a branch, edit, commit, push, open a pull request, release the session:

```ts
await store.withSession(sessionConfig, async (repo) => {
  await repo.writeFile('docs/a.md', content)     // through PathGuard; out of range throws
  await repo.commit({ message })
  const r = await repo.push({ createPR: { title, body, base: 'main' }, merge: 'auto' })
  if (!r.ok && r.reason === 'conflict') {
    await repo.resolveConflicts(decide(r.conflicts))   // resolve inside the callback
    await repo.commit({ message: 'merge' })
    return repo.push({ createPR: false })
  }
  return r
})
```

**The `withSession` exit contract, the easiest thing in this package to misuse:**

- The callback returning or throwing both lead to **`worktree remove`**.
- Except that if the worktree is **still mid-merge** on exit, with unresolved
  conflicts or an uncommitted merge, **the worktree is not deleted**;
  `MERGE_IN_PROGRESS` is thrown instead, with the worktree path in `detail`.
  The reasoning: deleting silently discards the conflict state and any work the
  host had half finished, while keeping it silently lets the host believe
  everything was cleaned up. **Failing loudly is the only honest option.**

So **programmatic conflict resolution belongs inside the callback**, which is
also its natural home - `push()` returns the `conflicts` right there.

When the conflict state genuinely has to outlive the call - handed to a human UI
asynchronously, say - use the manual lifecycle:

```ts
const repo = await store.createSession(sessionConfig)
try { /* ... */ } finally { await repo.dispose() }   // in a conflict state, the host decides when to dispose

// Take a kept worktree back over after a restart:
const repo2 = await store.attachSession(worktreePath)
```

A one-call convenience:

```ts
await store.publish({
  ...sessionConfig,
  message: string,
  files?: { path: string; content: string }[],   // omitted, the worktree's current changes are used
  createPR?: CreatePRInput,
  merge?: MergeMode,
}): Promise<PushResult>
// Internally withSession plus writeFile*, commit and push, releasing the worktree throughout
```

### 5.4 What push returns

**Expected outcomes are return values, not throws.**

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

**A failed auto-merge does not change the fact that the pull request exists** -
the result is still `ok: true` with `pr`, just with `autoMerge.ok: false`.

**When `reason: 'conflict'` comes back, the worktree stays mid-merge and
`withSession` does not clean it up** - see §6.3.

### 5.5 The push state machine

```
push the branch
 ├─ succeeded ─────────────────► createPR, if configured ─► handle the merge mode ─► ok:true
 └─ rejected (non-fast-forward)
      └─ retryOnReject, true by default ─► pull, merge strategy by default
            ├─ no conflict ─► push once more
            │                    ├─ succeeded ─► as above
            │                    └─ rejected again ─► ok:false, reason:'rejected'
            └─ conflict ───► stop mid-merge ─► ok:false, reason:'conflict', conflicts
```

**One retry only.** No infinite loop - a remote that other people keep pushing to
would spin forever.

### 5.6 Merge modes

```ts
merge: 'auto'        // derived from requireChecks on the sparsePaths (default)
     | 'now'         // merge immediately: PUT /pulls/{n}/merge
     | 'checksPass'  // GitHub's native auto-merge: enablePullRequestAutoMerge
     | false         // open the pull request only and merge by hand
```

How `'auto'` derives its answer, **taking the most conservative**:

```
git diff --name-only <base>...<head>     ← three dots: relative to the merge base
 → match against sparsePaths
 → any matched path with requireChecks: true  ⇒ 'checksPass'
 → all false                                  ⇒ 'now'
 → no sparsePaths configured (full mode)      ⇒ 'checksPass'
```

This is the one place in the package that looks at what actually changed.

**`--name-only` is required**: under a partial clone, any diff that needs file
**content** (`--stat`, `-p`) triggers lazy blob fetching from the promisor
remote. `--name-only` reads tree objects only, at no network cost.

`method` is `'squash' | 'merge' | 'rebase'`, `'squash'` by default.

### 5.7 pull and merge strategy

- `pull` defaults to **merge**, not rebase, because one round of conflicts is
  easier to handle programmatically than rebase's multi-round state machine.
- Either is available through `pull({ strategy: 'merge' | 'rebase' })`.

### 5.8 The conflict API

```ts
const conflicts = await repo.getConflicts()
await repo.resolveConflicts([{ path, content }, ...])
await repo.resolveByHunks(path, ['ours', 'theirs', { content: '...' }])
await repo.commit({ message })     // completes the merge commit
await repo.abortMerge()            // git merge --abort
```

### 5.9 The remaining methods

**On `RepoStore`**, for store-level shared state - refs and the object database:
`fetch(opts?)` `listBranches()` `deleteBranch(name)` `attachSession(path)` `listSessions()`

**On `GitRepo`**, at the worktree level:
`status()` `pull(opts?)` `merge(ref, opts?)` `log(opts?)` `diffSummary(opts?)`
`readFile(path)` `writeFile(path, content)` `listFiles(dir?)`
`setSparsePaths(paths)` `abortMerge()` `dispose()`

**There is no `checkout()`.** A session is bound to one branch, and switching
branches would break the concurrency model - if you want another branch, open
another session.

**A partial clone's lazy fetching has to be documented.** `log -p`,
`diffSummary` and anything else that needs file content will request blobs from
the promisor remote, with implicit network latency. `log()` defaults to
`--name-only`; a caller who wants content turns it on explicitly and accepts the
cost.

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

`GitHubProvider` accepts a `baseUrl` for GitHub Enterprise. Its token reuses
git's by default and can be overridden separately.
When `@octokit/rest` is absent, the pull request methods throw
`FORGE_NOT_INSTALLED` and the core git features are unaffected.

---

## 6. The conflict model

**The key realization: not every conflict has `<<<<<<<` markers.** Only a text
file both sides modified does. Every other kind has to be identified from the
stage bits of `git ls-files -u`.

```
stage 1 = base (the common ancestor)   stage 2 = ours   stage 3 = theirs
```

| stage 1 | 2 | 3 | type | In the working tree |
| --- | --- | --- | --- | --- |
| yes | yes | yes | `both_modified` | markers, for text |
| yes | yes | no | `deleted_by_them` | our content in full, **no markers** |
| yes | no | yes | `deleted_by_us` | their content in full, **no markers** |
| no | yes | yes | `both_added` | markers, for text |
| — | — | — | `rename` | different paths; needs `-M` to detect |

### 6.1 Type definitions

```ts
type Conflict = {
  path: string
  type: 'both_modified' | 'both_added' | 'deleted_by_them' | 'deleted_by_us' | 'rename'
  binary: boolean
  base?:   { oid: string; content?: string }   // content is filled in for text only
  ours?:   { oid: string; content?: string }
  theirs?: { oid: string; content?: string }
  ourPath?: string; theirPath?: string          // rename only
  hunks?: ConflictHunk[]                        // both_modified / both_added, and text only
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

`'both'` means our content followed by theirs.

### 6.2 The pure function

```ts
buildResolvedContent(conflict: Conflict, choices: HunkChoice[]): string
```

`choices.length` has to equal `hunks.length` or it throws `INVALID_ARGUMENT`.
There is deliberately **no "omitted means ours" default**, which would let a
host silently drop a change by forgetting an entry.

### 6.3 Implementation notes

1. **All three sides have to be read per stage with `git cat-file blob <oid>`**,
   never from the working tree - the file there is a marker-laden mixture.
2. **Always inject `-c merge.conflictStyle=diff3`**, or the base section is
   unavailable.
3. **Binary detection** uses `git check-attr` plus NUL-byte probing; a binary
   file gets no `content`, only its `oid`.
4. **`resolveConflicts` validates completeness**: every path passed in has to be
   in the current conflict set, and if conflicts remain afterwards it returns
   the list rather than leaving `commit` to complain.
5. **`rename` is detected but never resolved**; `ourPath` and `theirPath` hand
   the decision to the host.

### 6.4 The MergeSession state machine

```
IDLE ──pull/merge──► CLEAN ──► IDLE
  │                     │
  └──────────────► CONFLICTED ──resolveConflicts, all resolved──► RESOLVED ──commit──► IDLE
                        │
                        └──abortMerge──► IDLE
```

**The state is not kept in memory**; it is derived every time from whether the
file `git rev-parse --git-path MERGE_HEAD` points at exists, and whether
`git ls-files -u` is empty.

**`git rev-parse --git-path` is required**; `.git/worktrees/<name>/...` must
never be hard-coded - this package should not assume the git directory layout of
a linked worktree. The process may restart, at which point in-memory state is
guaranteed to disagree with disk.

---

## 7. Error handling and security

### 7.1 Two kinds of error

- **Expected outcomes become return values**: a rejected push, a conflict, a
  pull request blocked by protection rules, a branch that already exists.
- **Genuine failures throw**: git missing or too old, a directory that is not a
  git repository, an authentication failure, no network, a full disk, a timeout,
  invalid arguments.

```ts
class GitOpError extends Error {
  code: GitErrorCode
  detail: string        // git's raw stderr, scrubbed
  command?: string      // the command that ran, scrubbed
  cause?: unknown
}

type GitErrorCode =
  | 'GIT_NOT_FOUND' | 'GIT_VERSION_TOO_OLD'
  | 'AUTH_FAILED' | 'NETWORK' | 'TIMEOUT'
  | 'NOT_A_REPO' | 'DIRTY_WORKTREE' | 'MERGE_IN_PROGRESS'
  | 'BRANCH_IN_USE'                       // already checked out in another worktree
  | 'BRANCH_EXISTS' | 'BRANCH_NOT_FOUND'  // the branchMode constraint was not met
  | 'WORKTREE_DISPOSED'                   // a method called on a released session
  | 'PATH_OUTSIDE_SPARSE' | 'PATH_TRAVERSAL'
  | 'INVALID_ARGUMENT'
  | 'FORGE_NOT_INSTALLED' | 'FORGE_API_ERROR'
  | 'UNKNOWN'
```

`ErrorMapper` maps stderr through a table of regular expressions. **Anything
unmatched is `UNKNOWN` plus the raw stderr, never a guess** - a wrong error code
is worse than none.

### 7.2 Authentication security, non-negotiable

1. **The token is never written into the URL**, where it would land in
   `.git/config` and the reflog. It is injected per process instead:
   ```
   git -c http.extraheader="AUTHORIZATION: basic <base64(x-access-token:TOKEN)>" ...
   ```
2. **The token never appears in logs, error messages or the `command` field.**
   `GitExecutor` scrubs it to `***` before returning any stderr or command.
   **This needs a dedicated unit test.**
3. **stderr reaching `onProgress` is scrubbed too** before it goes out.
4. **The package reads no environment variables**; the host passes the token in
   through configuration.

### 7.3 Interruption and recovery

- **Startup cleanup**, on first use of a store after `RepoManager` is
  constructed: `git worktree prune` plus clearing orphaned directories under
  `wt/`. This is safe, because the process that held an orphaned worktree no
  longer exists.
- **Leftover merge state is never cleaned up at runtime.** See the exit contract
  in §5.3: a `withSession` that exits mid-merge keeps the worktree and throws
  `MERGE_IN_PROGRESS` with the path in `detail`, leaving the host to take it
  over with `store.attachSession(path)` or to `abortMerge()` and `dispose()`
  explicitly.
  An automatic `merge --abort` could discard a half-finished resolution and is
  never performed.
- **`store.listSessions()`** reports every live worktree and its state -
  `clean`, `conflicted` or `orphaned` - for the host and `gc()` to act on.
- **`dispose()` is idempotent**; any method called on a disposed session throws
  `WORKTREE_DISPOSED`.

---

## 8. Test strategy

Roughly **70 / 25 / 5**.

### 8.1 Pure unit tests, no IO - Layer 2

- **ConflictParser**: every stage combination (both_modified, both_added,
  deleted_by_them, deleted_by_us, binary, rename). Edge cases: no trailing
  newline, CRLF, content that itself contains a fake `<<<<<<<`, several
  consecutive hunks.
- **buildResolvedContent**: every `HunkChoice` across multi-hunk combinations,
  asserted byte for byte; a mismatched `choices` length has to throw.
- **PushPolicy**: the three `'auto'` cases; the retry decision (rejected, pull
  without conflict, retry; rejected again, no further retry).
- **PathGuard**: `../` traversal, absolute paths, symlinks, outside the sparse
  range, case differences.
- **LayoutPlanner**: various URL shapes to directory paths, including special
  characters, case, and a `.git` suffix.
- **Scrubbing**: a command and stderr containing a token, asserting the token
  cannot be found in the output.
- **ErrorMapper**: real stderr samples to error codes, including the
  "unmatched returns UNKNOWN" case.

**The samples have to be exported from real git** - write a script that
manufactures each kind of conflict and dumps the output. Hand-invented samples
make the tests pass while production breaks.

### 8.2 Integration tests, against real git with a local bare repo as the remote, offline

```
create a bare remote → manager.store() (sparse partial clone)
 → withSession(create a branch) → edit → commit → push
another clone pushes first → the local push is rejected → verify the automatic pull and retry
both sides change the same line → verify conflict parsing → resolve → commit → push succeeds
```

Required coverage:

- After a sparse checkout, **the other directories really are absent from the
  worktree**.
- **Two worktrees with different sparsePaths do not contaminate each other** -
  the direct verification of the version requirement in §3.3.
- The partial clone really did not fetch every blob, and the filter applies to
  every worktree.
- `setSparsePaths` takes effect incrementally.
- **Concurrency**: ten sessions on one store, each creating a branch, editing,
  committing and pushing, all succeeding without interfering. This is the
  central claim of the design and has to be tested.
- **Branch collision**: two sessions with the same branch name throw
  `BRANCH_IN_USE`.
- **Worktree leaks**: `withSession` still removes after the session throws; in a
  conflict state it does **not** remove and throws `MERGE_IN_PROGRESS`.
- **`attachSession`**: taking a kept, conflicted worktree back over gives a
  `getConflicts()` result identical to the one before the interruption.
- **`branchMode`**: three values against branch present or absent, six
  combinations.
- **Creation order**: assert that **no** full blob fetch happened while the
  worktree was created, using a remote with `--filter` plus `GIT_TRACE_PACKET`
  or an object count.
- **`gc` refcounting**: a store with active sessions is not reclaimed.
- **Startup cleanup**: manufacture an orphaned worktree directory and verify it
  is pruned.
- `dispose()` is idempotent; a method called after dispose throws
  `WORKTREE_DISPOSED`.

### 8.3 The GitHub layer, entirely mocked, never hitting the real API

`nock` or an injected fake octokit. Coverage: createPR succeeding; `merge: 'now'`
succeeding and being blocked by protection rules with 405; the GraphQL call for
`checksPass`; **a pull request that opened while auto-merge failed still
returning `ok: true` with `autoMerge.ok: false`**.

Optionally, a real smoke test that only runs when `E2E_GITHUB_TOKEN` is present,
skipped by default in CI.

### 8.4 The CI matrix

Node 18 / 20 / 22 against git **2.32 (the declared floor) / 2.37 / latest**.

**The git version matrix is necessary**: the behaviour of sparse-checkout
combined with worktrees changes between versions, the 2.32 in §3.3 is an
estimate, and the matrix has to establish the real floor and feed it back into
preflight and this document.

### 8.5 TDD order

Write the `ConflictParser` samples before the implementation. The conflict model
should not be expected to come out right first time; samples exported from a
real repository are what force the missing types out into the open.

---

## 9. Identified risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Incomplete conflict-type coverage (delete/modify, rename, binary) | Resolution produces the wrong content | Samples exported from real git; TDD; renames detected but not resolved |
| The git version floor for worktree plus sparse-checkout is uncertain | On older versions, sparse settings contaminate other worktrees | A CI version matrix establishes the floor; preflight blocks hard |
| Worktree leaks, from a killed process or a lingering conflict state | Disk growth | `withSession` guarantees release; `worktree prune` at startup; `gc()` reclaims by age and size |
| Several processes sharing one `root` | Concurrent corruption of the object database | Explicitly unsupported by design; deployment requires a StatefulSet with an RWO PV. If sharing ever becomes mandatory, an external lock is needed and the git-on-NFS risk has to be reassessed |
| A partial clone fetching blobs lazily | `log -p` and `diffSummary` incur implicit network latency, or large downloads | `--name-only` by default; the diff behind `merge: 'auto'` forces `--name-only`; documented explicitly |
| Getting the worktree creation order wrong | Every blob is fetched and "download only the named directories" stops working | The fixed order in §3.5; an integration test asserting the object count |
| A token leaking into logs or `.git/config` | A security incident | Injected only through `-c http.extraheader`; uniform scrubbing plus a dedicated unit test |
| A conflicted worktree lingering indefinitely | Disk usage, unclear semantics | Never cleaned up automatically, so no change is lost, but `gc()` has to report such worktrees for the host to act on |

---

## Appendix A: implementation record (2026-08-29)

This section records where the implementation **actually departed** from the
design above, and what it **discovered**. The text above is left as originally
written for comparison; this section takes precedence.

### A.1 Departures in technology choices

| Item | Designed | Actual | Why |
| --- | --- | --- | --- |
| The git process layer | simple-git | `node:child_process.execFile` | simple-git's `timeout` is an **idle** timeout rather than a total one, and cannot implement the per-command total timeout §5.1 requires. Under this `GitExecutor` design, argument passing, the concurrency queue, progress parsing and error mapping are all handled here anyway, so simple-git would only ever be used as a `.raw()` pass-through - close to zero value. |
| TypeScript version | 5.x | **pinned to `^5.9.3`** | Dependency resolution once pulled `typescript` up to 7.0.2, which crashed tsup's rollup-plugin-dts (`useCaseSensitiveFileNames`). Back on 5.9.3, `dts: true` works and also emits the `.d.cts` that CJS needs, so the original bundling plan did **not** change. The overwhelming majority of consumers are on TS 5.x, and this package's devDependency should not drift onto a freshly released major. |

### A.2 Defects found during implementation, not covered by the design

1. **A rebase conflict has no `MERGE_HEAD`.**
   The designed merge-state check looked only at `MERGE_HEAD`, so a worktree
   stopped at a rebase conflict was reported as clean and `withSession` deleted
   it, losing the conflict state.
   → Added `operationInProgress(): 'merge' | 'rebase' | 'cherry-pick' | null`,
   which also checks `MERGE_HEAD`, the `rebase-merge` and `rebase-apply`
   directories, and `CHERRY_PICK_HEAD`.

2. **`git commit` during a rebase fails silently.**
   It "succeeds", while leaving the rebase unfinished and HEAD detached.
   → `commit()` now throws `INVALID_ARGUMENT` during a rebase and points at the
   new `continueRebase()`; `abortMerge()` dispatches to
   `merge/rebase/cherry-pick --abort` based on the current operation.

3. **git's stage 2/3 semantics are reversed during a rebase.**
   Stage 2 is the upstream being rebased onto and stage 3 the commit being
   replayed. Passing that through unchanged hands a host that asked for
   `take: 'ours'` the other side's content - the kind of defect that silently
   produces wrong results.
   → Normalized: `ours` always means **the change on the current branch**, with
   `Conflict.sidesSwapped = true` when a swap happened (`raw` keeps git's
   original order), and `resolveByHunks` swaps the choices back before applying
   them. `deleted_by_them` and `deleted_by_us` swap too.

4. **A session's author was written into the shared `.git/config`.**
   Creating twenty sessions concurrently fought over `config.lock`, failing
   intermittently, and every session shared one identity.
   → Switched to `git config --worktree`, which is exactly what
   `extensions.worktreeConfig` is for.

5. **Conflict marker parsing failed on CRLF files.**
   `=======\r` does not match `/^=======$/`, which crashed the parse of the
   whole hunk.
   → A trailing `\r` is stripped before markers are matched; content lines keep
   theirs so a write-back is byte-identical.

6. **The shared `.git/config` was written from more than one place.**
   Besides the author in A.2.4, `git push --set-upstream` and the tracking set
   up by `git worktree add -b <branch> <dir> origin/x` both write
   `branch.<name>.*` into the shared config - the same race and the same
   contamination.
   → push dropped `--set-upstream` and worktree creation gained `--no-track`.
   Every operation in this package names its refspec and `origin/<branch>`
   explicitly and does not rely on upstream tracking.
   Session creation and push now write **no shared config at all**.

7. **Calling `store()` again for one URL with a different configuration
   silently reused the first one** - asking for `github` on the second call, for
   instance, still returned a store with no forge.
   → The configuration signature is compared and a mismatch throws
   `INVALID_ARGUMENT`; a store is a shared object database and a URL may only
   have one.

8. **`SessionConfig.retryOnReject` was never passed to `GitRepo`**, so the
   session-level setting silently did nothing.
   → Fixed, with a regression test.

9. **`publish` could not return a conflict.**
   The design routed it through `withSession`, which throws
   `MERGE_IN_PROGRESS` on a conflict and swallowed the `PushResult` conflict
   branch.
   → `publish` manages its own session: on a conflict it **returns** the result
   and keeps the worktree; everything else releases.
   The conflict branch of `PushResult` gained a `worktreeDir` field for
   `attachSession` to take over.
   → Added `dispose({ keepWorktree })`, so the worktree can be kept while the
   store's refcount is released - otherwise `activeSessions` never comes back
   down and `gc` is blocked forever.

### A.3 Confirmed git behaviour

- **Cone-mode sparse checkout always includes the files at the repository
  root**, `README.md` among them. This is git's own behaviour and cannot be
  turned off. `PathGuard` still refuses writes to those files, so the writable
  range is strictly equal to the declared `sparsePaths`.
- **A rename/rename conflict appears in the index as three entries that each
  carry one stage** - base at the old path, ours at our new path, theirs at
  theirs - rather than several stages on one path.
  Grouping relies on `git diff --name-status -M`; without a mapping it degrades
  to reporting each entry separately rather than throwing and blocking.

### A.4 API additions

`exists()` · `merge(ref, opts)` · `continueRebase()` · `operationInProgress()` ·
`recover({ abortOperation, clearIndexLock })` · the `RepoStore.forge` getter ·
`dispose({ keepWorktree })` · `gc({ maxAgeDays | maxAgeMs })`

`setSparsePaths` accepts `SparsePathInput[]`, mixing the string shorthand with
objects, rather than requiring full `SparsePath[]`.

### A.5 Not implemented

- `gc({ maxTotalBytes })` - it needs a recursive directory size, and reclamation
  currently goes by idle time only.
- SSH authentication, GitLab and Bitbucket: out of scope for the first version
  by design, with the interfaces left in place.

### A.6 Verification status

- The build output is ESM, CJS, `.d.ts` and `.d.cts`, verified from a separate
  consumer project: the types are usable and the `PushResult` discriminated
  union narrows correctly.
- **295 tests pass** (`npm test`), with the integration tests running against a
  local bare repository and never going online. They include a concurrency
  stress test with twenty sessions, real-git coverage of all five conflict
  kinds, byte-identical binary content, and an object-count assertion that no
  full blob fetch happens while a sparse worktree is created.
- The git version tested locally is **2.50.1**. **The declared floor of 2.32 has
  not been verified locally**; the CI matrix
  (`.github/workflows/ci.yml`, node 18/20/22 against git 2.32/system) pins it
  down. If 2.32 does not hold, `MIN_GIT` has to go up and this document has to
  follow.
