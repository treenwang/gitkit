# The gitkit UI suite — design document

**Date**: 2026-08-29
**Status**: design confirmed, pending review before the implementation plan
**Prerequisite**: [`2026-08-29-git-operation-package-design.md`](./2026-08-29-git-operation-package-design.md), the core package's design and implementation record

---

## 1. Goals and scenario

Give the finished server-side core package a UI and transport layer a **frontend
can import directly**, so that a user in a browser can **edit a file, commit,
and open a pull request**, resolving conflicts as structured data when they
arise.

### The first consumer

**The skill management feature of branchkinect-platform's platform console.**

Today it is read-only:
`apps/web/platform-console/src/components/agent-quality/skill-source-panel.tsx`
shows which files a prompt came from - path, byte count, sha256, an
`uncommitted` marker and the source text. This design turns that into
**editable, committed back to git**.

What gets edited:

```
prompts/agent-skills/
  catalog.yaml                    ← the category-to-channel enablement matrix, under a strong contract
  hvac/{category}/{channel}/*.md  ← skill bodies
  hvac/_base/*.md                 ← non-routed base prompts
  common/{category}/{channel}/*.md
```

### Why the core package fits this scenario

| Characteristic | The core package's answer |
| --- | --- |
| A huge monorepo where only `prompts/agent-skills/` is needed | partial clone plus cone-mode sparse checkout |
| `main` is protected, so changes have to go through a pull request | The main path is exactly create a branch, edit, commit, push, open a PR |
| Several administrators may edit at once | One independent worktree per session |
| `check:skills` validates the `catalog.yaml` contract | `requireChecks` makes `merge: 'auto'` derive "wait for CI" |

### Technology stack, decided by the consumer and not negotiable

- Frontend: React 19, Vite SPA, **shadcn**, **Tailwind v4**, TanStack Query 5,
  Radix, lucide
- Backend: **NestJS on Express**, running on Bun
- An existing editor: `@lexical/react`. This design provides **no** editor, only
  the shell and the slot.

### The key trade-off: you are editing a branch, not what is live

A running agent reads its prompts from `AGENT_PROMPTS_ROOT`; editing happens in
a gitkit worktree. The two are separate, and a change only takes effect through
**a pull request, a merge and a deploy**.

That is a **deliberate review gate**, but the UI has to say so explicitly or
administrators will assume saving makes it live. It follows that "preview my
edited skill" has to read from the session's worktree, never from
`AGENT_PROMPTS_ROOT`.

### Non-goals

- **No editor of its own.** The host passes one in through a slot - Lexical,
  CodeMirror or a plain textarea.
- **No diff viewer of its own.** A lightweight zero-dependency rendering is
  built in and replaceable through a slot.
- **No history browsing** - no arbitrary historical diffs, no commit history.
  Only "this change", for the reasons in §7.1.
- **No rename API.** git detects renames by content similarity, and "create plus
  delete" is equivalent in the history.
- **No authentication or tenancy decisions inside the package.** The host
  decides all of it through the `resolveSession` callback (§4.2).
- **No session creation endpoint**, by default. Branch naming, author identity
  and which directories are editable are all business policy.
- **No sharing a session across instances.** See §4.6 and §12.

---

## 2. Package split and dependency direction

**The core package is renamed from `@treenwang/git-operation` to
`@treenwang/gitkit`.** It is unpublished, so renaming costs nothing. The
reasoning: the short name `gitop` collides with the established industry term
**GitOps**, declarative continuous delivery for infrastructure, and would be
misread.

```
browser                                       server
┌────────────────────────────┐               ┌──────────────────────────────┐
│ @treenwang/gitkit-ui       │               │ @treenwang/gitkit-server     │
│   /hooks       React hooks │               │   createHandler()            │
│   /components  components  │               │   toExpress() adapter        │
└──────────┬─────────────────┘               └──────────┬───────────────────┘
           │                                             │
┌──────────▼─────────────────┐   HTTP RPC    ┌──────────▼───────────────────┐
│ @treenwang/gitkit-client   │ ◄───────────► │ @treenwang/gitkit            │
│  framework-agnostic ·      │               │  (already done; three new    │
│  zero runtime dependencies │               │   APIs this time)            │
└────────────────────────────┘               └──────────────────────────────┘
```

| Package | Environment | Runtime dependencies | Responsibility |
| --- | --- | --- | --- |
| `@treenwang/gitkit` | server | system git >= 2.32 | Already done. Gains `deleteFile`, `readBuffer` and `getDiff` this time, **with no breaking changes** |
| `@treenwang/gitkit-server` | server | gitkit | Exposes the core as a web-standard handler, with an Express adapter |
| `@treenwang/gitkit-client` | browser | **none** | A typed RPC client that uses `fetch` and nothing else |
| `@treenwang/gitkit-ui` | browser | client, its only dependency; React 19 and TanStack Query 5 as peers; **Radix and lucide as optional peers** | hooks and components |

### Hard constraints

1. **`client` is framework-agnostic.** It does not import React. A consumer on
   Vue, Svelte or a Node script imports only the client.
2. **`ui` has two subpaths**: `@treenwang/gitkit-ui/hooks` and `/components`. A
   consumer who wants only the hooks does not get component code in their
   bundle.
3. **The single source of shared types is `@treenwang/gitkit`.** `client` reuses
   `Conflict`, `PushResult`, `HunkChoice` and the rest through `import type`,
   **adding no runtime dependency**. A server-side type change becomes a
   frontend compile error.
4. **`ui`'s only `dependency` is `client`**, and it bundles no CSS. UI component
   libraries are used as **optional peers** and never as ordinary dependencies -
   see §9.2.

---

## 3. Repository restructuring

Today `src/` sits at the repository root and is the core package. It has to
become npm workspaces:

```
packages/
  core/      @treenwang/gitkit          ← moved from the existing src/ and tests/
  server/    @treenwang/gitkit-server
  client/    @treenwang/gitkit-client
  ui/        @treenwang/gitkit-ui
```

- Move with `git mv` to keep the history.
- The existing 295 tests **change paths only, never logic**; every one of them
  passing afterwards is what makes the migration complete.
- The package name `@treenwang/git-operation` becomes `@treenwang/gitkit`, with
  the README, spec and CI updated to match.

---

## 4. The transport protocol and the security boundary

**The central proposition: the browser is an untrusted input source.** The
server must never let the frontend decide which repository, which worktree, or
whose identity an operation uses.

### 4.1 The shape of the handler

```ts
import { createHandler, toExpress } from '@treenwang/gitkit-server'

const handler = createHandler({
  resolveSession,                  // required, see §4.2
  allow: ['status', 'files.list', 'files.read', 'files.write', 'files.delete',
          'changes.list', 'changes.diff', 'commit', 'push', 'sync.pull'],
  serialize: true,                 // serialize per sessionId, true by default
  maxContentBytes: 1_048_576,      // 1 MB by default
  exposeDetail: false,             // false by default, see §4.5
})
```

`handler` has the type `(req: Request) => Promise<Response>`, the web-standard
Fetch API, so it drops straight into Hono, Bun, Deno, Cloudflare or a Next.js
App Router.

NestJS on Express uses the bundled adapter:

```ts
@Controller('admin/skills/git')
export class SkillGitController {
  @All('*')
  handle(@Req() req: Request, @Res() res: Response) {
    return toExpress(handler)(req, res)
  }
}
```

### 4.2 The security boundary: `resolveSession`

**The protocol has no `url`, `root`, `worktreeDir` or `token` field.** The
browser sends an opaque `sessionId` and the host resolves it:

```ts
async function resolveSession(req: Request, sessionId: string): Promise<GitRepo | null> {
  const user = await auth(req)                       // the host's authentication
  const record = await db.skillSessions.find(sessionId)
  if (!record || record.ownerId !== user.id) return null   // the host's authorization
  return store.attachSession(record.worktreeDir)
}
```

Returning `null` gives HTTP 404, **not 403** - the caller is never told "that
session exists but you may not have it".

**The frontend cannot enumerate sessions, escalate, or name an arbitrary path.**

### 4.3 Session creation is outside this protocol

Branch naming, author identity and which sparse directories are editable are all
business policy and belong to the host's own endpoint.

For the first consumer, at session granularity A - one editing proposal is one
branch:

```
① An administrator clicks "edit skill"
   → the host's backend: store.createSession({
       branch: `skills/${user.login}-${ulid()}`,
       sparsePaths: [{ path: 'prompts/agent-skills', requireChecks: true }],
       author: { name: user.name, email: user.email },
     })
   → records sessionId → worktreeDir in the database
   → returns { sessionId } to the browser

② Every later edit or commit request goes through this protocol carrying only the sessionId

③ Once the pull request merges, or is abandoned, the host calls repo.dispose()
   and deletes the database record
```

Where a host genuinely wants it, a `createSession(req, params)` callback lets
the package route the call, **with the host still validating the parameters**.

### 4.4 The RPC shape

`POST {mount}/{op}`, with a JSON body of `{ sessionId, ...params }`.

Paths rather than one endpoint, so logs, devtools and APM can see what is going
on directly.

| op | params | Returns |
| --- | --- | --- |
| `status` | — | `{ branch, operation, clean, staged, modified, untracked, conflicted }` |
| `files.list` | `dir?` | `{ entries: FileEntry[] }` |
| `files.read` | `path` | `{ content, etag, binary: false }` or `{ binary: true, size }` |
| `files.write` | `path, content, baseEtag?, ifNotExists?` | `{ etag }` |
| `files.delete` | `path` | `{ deleted: true }` |
| `changes.list` | — | `{ files: ChangeEntry[] }` |
| `changes.diff` | `path?, against?` | `{ patch, truncated }` |
| `commit` | `message, paths?` | `{ sha, changed }` |
| `push` | `createPR?, merge?, method?` | `PushResult`, **with `worktreeDir` stripped**, see §4.5 |
| `sync.pull` | `strategy?` | `{ conflicted }` |
| `conflicts.list` | — | `{ conflicts: Conflict[] }` |
| `conflicts.resolve` | `resolutions` | `{ remaining }` |
| `conflicts.resolveByHunks` | `path, choices` | `{ remaining }` |
| `conflicts.continue` | — | `{ done, conflicted }` |
| `conflicts.abort` | — | `{ ok: true }` |

The two types this layer owns; everything else is reused from
`@treenwang/gitkit`:

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

An op not listed in `allow` answers 404, **not 405** - a capability that is
turned off should not reveal that it exists. The host may also supply
`can(ctx, op)` for a fine-grained per-request decision.

### 4.5 Three filters that have to be in place

Each of these is a place where server-side information would otherwise reach the
browser:

1. **`GitOpError.detail` and `command` are not returned by default.** They hold
   absolute server paths
   (`/data/repos/github.com/acme/web/wt/s-a3f9...`). The default response body is
   `{ code, message }` alone; `exposeDetail: true` adds `detail`, and is for
   internal tools only.
2. **`worktreeDir` has to be stripped from the conflict branch of
   `PushResult`.** It is an absolute server path, and the frontend holds nothing
   but a `sessionId` and has no use for it.
3. **A response size ceiling, `maxContentBytes`, 1 MB by default.** A conflict's
   `ours`, `theirs` and `base` content, and a diff, can all be large. Past the
   limit the response carries no `content`, only `oid` and `size`, with
   `truncated: true`, and the UI says the file is too large to edit online.

### 4.6 Concurrency: several requests for one session

The core package is designed around one owner per session, and a worktree is
unlocked inside. But a browser user may open two tabs, or trigger autosave in
quick succession - two requests writing the same index collide on `index.lock`.

**With `serialize: true`, the server package serializes requests per `sessionId`
within the process**, reusing the core package's `StoreMutex` pattern. These
operations take milliseconds, so the queueing cost is negligible.

**An in-process queue is not enough across several instances.** The host has to
route one session to one instance - a sticky session - or bring its own
distributed lock. This package **does not pretend to solve that**; it states the
premise in the documentation.

### 4.7 Mapping error codes to HTTP statuses

The response body is always `{ error: { code, message } }`. `code` is **every
`GitErrorCode` plus the few the server package owns** - `SESSION_NOT_FOUND`,
`OP_NOT_ALLOWED`, `STALE_ETAG`, `ALREADY_EXISTS` - which describe transport
failures with no counterpart in the core package.

| Error code | HTTP | Note |
| --- | --- | --- |
| `SESSION_NOT_FOUND` | 404 | Does not distinguish missing from forbidden |
| `OP_NOT_ALLOWED` | 404 | Does not reveal that a disabled capability exists |
| `INVALID_ARGUMENT` · `PATH_OUTSIDE_SPARSE` · `PATH_TRAVERSAL` | 400 | |
| `STALE_ETAG` | 409 | The response carries the server's current `content` and `etag` |
| `ALREADY_EXISTS` | 409 | `ifNotExists: true` against an existing path |
| `BRANCH_IN_USE` · `BRANCH_EXISTS` · `BRANCH_NOT_FOUND` · `MERGE_IN_PROGRESS` · `DIRTY_WORKTREE` | 409 | |
| `WORKTREE_DISPOSED` | 410 | The session is gone; the UI should start the user over |
| `AUTH_FAILED` | 502 | An **upstream** git auth failure, not a signed-out browser user |
| `NETWORK` · `TIMEOUT` | 504 | |
| `FORGE_NOT_INSTALLED` | 501 | |
| everything else | 500 | |

**Mapping `AUTH_FAILED` to 502 rather than 401 matters**: a 401 would make the
frontend's interceptor read it as an expired user session and start a re-login,
when the real problem is an expired GitHub token on the server.

---

## 5. Editing and saving

### 5.1 The autosave strategy

The worktree is the single source of truth. Every edit ends up on the server's
disk, so switching devices, reloading the page and restarting the process all
pick up where you left off - the inherent advantage of a worktree on a PV over a
purely browser-side editor.

| Trigger | When |
| --- | --- |
| Debounced save | **800 ms** after typing stops |
| Forced save | At least once every **5 s** while typing continues (the debounce maxWait) |
| Save on blur | The editor loses focus |
| Before switching files | Has to be flushed first, or the switch is refused |
| Page hidden | `visibilitychange → hidden` sends `fetch(..., { keepalive: true })` |

The state machine, exposed for the UI to display:

```
clean ──typing──► dirty ──debounce elapses──► saving ──succeeded──► saved ──► clean
                   ▲                             │
                   └──────────── error ◄─────────┘     content stays in the browser and can be retried
```

### 5.2 Optimistic concurrency control, without which data is lost silently

While a user is editing `hvac/pricing/voice/core.md`, that file may change on
the server - another tab saved it, or a `sync.pull` brought remote changes in.
Writing straight through would **silently overwrite** those changes.

```
files.read   → { content, etag }              etag = sha256 of the content's UTF-8 bytes, hex
files.write  → { path, content, baseEtag }
               the server reads the current content and computes its etag
               ├─ matches baseEtag → write, return the new etag
               └─ does not match  → 409 { code: 'STALE_ETAG', etag, content }
```

Omitting `baseEtag` **skips the check**, for when you mean to overwrite, but
`ui`'s `useFile` always sends it.

On a 409 the UI offers three choices: **overwrite**, **view the difference**,
**discard my changes**. No automatic three-way merge - that belongs to phase 2
and reuses the conflict resolution machinery.

The etag is computed by `gitkit-server`; **the core package needs no change**.

### 5.3 Creating and deleting

- **Create**: `files.write` to a path that does not exist. Intermediate
  directories are created automatically, which `FsGateway` already does. With
  `ifNotExists: true`, an existing path gives a 409 so nothing is overwritten by
  mistake.
- **Delete**: `files.delete` removes the file from the working tree; the core
  package's `git add -A` records it as a deletion at commit time.
- **Range**: everything goes through `PathGuard`. Leaving the declared sparse
  directories gives 400 with `PATH_OUTSIDE_SPARSE`, so the frontend gets a clear
  code rather than a mysterious failure.

### 5.4 Binary files

`files.read` probes for NUL bytes with `readBuffer` first. A binary file returns
`{ binary: true, size }` and **no content**; the UI says the file is binary and
cannot be edited, and allows only deletion.

---

## 6. Additions to the core package

Three new APIs and **no change to any existing public interface**:

| API | Purpose |
| --- | --- |
| `GitRepo.deleteFile(path)` | Delete a file, through `PathGuard` |
| `GitRepo.readBuffer(path)` | Binary probing - `FsGateway.readBuffer` exists already and only needs exposing |
| `GitRepo.getDiff(opts)` | A diff of the current changes |

`getDiff`'s signature and constraints:

```ts
getDiff(opts?: {
  paths?: string[]        // omitted, the session's sparsePaths are used
  against?: string        // omitted means working tree against HEAD; a base gives base...HEAD
  context?: number        // context lines, 3 by default
}): Promise<{ patch: string; truncated: boolean }>
```

**`paths` always goes through `PathGuard` and throws when it leaves the range.**
That makes "the UI physically cannot diff anything outside the declared range"
an invariant rather than something the caller has to remember.

---

## 7. Diffs and history: scope and reasoning

### 7.1 Only "the current change", no history browsing

Under a partial clone, any diff that needs file **content** makes git **lazily
fetch blobs** from the promisor remote. Measured over three commits with changes
in both `docs/` and `src/`:

| Operation | Missing blobs |
| --- | --- |
| `clone --filter=blob:none` | 9 |
| `git diff HEAD~2 HEAD -- docs/` | 9 → **7**, fetching the 2 under docs/ |
| `git diff HEAD~2 HEAD`, no pathspec | 7 → **3**, fetching 4 more under src/, large files among them |

**Conclusion: a pathspec limit works, and a diff fetches only the blobs under
that path.** Which is why §6 forces `paths` through `PathGuard`.

Three problems remain, and they **only apply to browsing arbitrary history**:

1. **A diff becomes a network operation that can fail hard.** With the promisor
   remote unreachable, the measured error is
   `fatal: Could not read from remote repository.` In a full clone a diff is
   purely local and cannot fail.
2. **Fetched blobs accumulate permanently** in the local object database.
3. **A shallow clone with `depth` truncates the history outright**, and a
   history panel hits a wall.

**Restricting the scope to "the current change" makes all three disappear:**

| Scenario kept | Network cost |
| --- | --- |
| Working tree against HEAD - what have I changed and not committed | **none**, the blobs are already in the working tree |
| `base...HEAD` - the full diff of this pull request | **tiny**, a three-dot diff reads only the merge-base side and only the changed files |
| The commit list for this session (`log base..HEAD`) | **none**, commit objects only |
| The file tree and file contents | **none**, that is the working tree inside the sparse range |

For the full history, GitHub's web interface is right there; there is no need to
rebuild it in the host application.

### 7.2 Diff rendering is pluggable

A **lightweight zero-dependency unified diff renderer** is built in - git
already emits unified diff format, and a view with +/- colouring is about a
hundred lines - alongside a `renderDiff` slot:

```tsx
<DiffView path="…" />                                   // works out of the box, no extra dependency
<DiffView path="…" renderDiff={(patch) => <Monaco …/>} />  // swap in anything
```

Three reasons: **it works out of the box** with nothing installed, **the bundle
stays small** - `monaco-editor` is over 2 MB and this package should not choose
it for a consumer - and **there is an escape hatch**.

Verified replacements, all MIT and updated within 2026:
`react-diff-viewer-continued@4.4.0` · `@git-diff-view/react@0.1.7` ·
`diff2html@3.4.56` · `@codemirror/merge@6.12.2` · `monaco-editor@0.56.0`.

---

## 8. The components and hooks API

### 8.1 Layers

```
@treenwang/gitkit-ui/hooks        the logic, on TanStack Query, with no UI at all
@treenwang/gitkit-ui/components   the components, on the hooks
```

**The hooks build on `@tanstack/react-query`** (a `^5` peer dependency) rather
than a cache of their own - the first consumer is already on 5.90, and a private
cache would mean two parallel sets of request state and invalidation logic.

### 8.2 The provider and the hooks

```tsx
<GitkitProvider client={createClient({ baseUrl: '/api/admin/skills/git' })} sessionId={id}>
  …
</GitkitProvider>
```

| Hook | Returns |
| --- | --- |
| `useSessionStatus()` | The branch, the operation in progress, whether it is clean, counts per file category |
| `useFileTree(dir?)` | The directory tree plus a `modified / added / deleted / conflicted` marker per entry |
| `useFile(path)` | `{ content, etag, binary, state, setContent, save, saveState, staleConflict }` |
| `useChanges()` | The list of files changed this time |
| `useDiff({ path?, against? })` | `{ patch, isLoading, error }` |
| `useCommit()` | `mutate({ message, paths? })` |
| `usePush()` | `mutate({ createPR?, merge?, method? })` giving a `PushResult` |
| `useConflicts()` | Phase 2 |

`useFile` implements the autosave state machine from §5.1 and the etag check
from §5.2 internally; when `staleConflict` is non-null the component should
offer overwrite, view the difference, or discard.

### 8.3 The components

| Component | Note |
| --- | --- |
| `FileTree` | The directory tree inside the sparse range, with change markers; supports create and delete |
| `FileEditor` | **A shell with no editor.** Handles loading, the dirty marker, autosave and the etag conflict prompt; the editor arrives through a render prop |
| `ChangeList` | The files changed this time, clickable to navigate |
| `DiffView` | A diff of the current changes, with the lightweight rendering built in and a `renderDiff` slot |
| `CommitPanel` | commit message, push, open a pull request, pick a merge mode, show the result |
| `SyncStatus` | ahead/behind, triggers `sync.pull` |
| `ConflictResolver` | Phase 2: a side per hunk, a side per file, or hand-edited |

The shape of `FileEditor`'s slot:

```tsx
<FileEditor path="prompts/agent-skills/hvac/pricing/voice/core.md">
  {({ content, onChange, saveState, binary }) =>
    binary
      ? <BinaryNotice />
      : <YourLexicalEditor value={content} onChange={onChange} />}
</FileEditor>
```

### 8.4 How merge modes appear in the UI

`CommitPanel` sends `merge: 'auto'` by default and lets the core package derive
the mode from `requireChecks` on the `sparsePaths`.

**The trade-off for the first consumer: `prompts/agent-skills` as a whole gets
`requireChecks: true`.**

The reason is that sparse paths are **directory-grained**, an inherent limit of
cone mode, and `catalog.yaml` lives under `prompts/agent-skills/` alongside the
skill `.md` bodies, so "editing a body skips checks, editing the catalog waits
for CI" cannot be expressed. `check:skills` is fast, and waiting for CI on
everything is a safe and acceptable default.

`CommitPanel` also offers an explicit "merge now" option, which sends
`merge: 'now'`, for a host that knows only bodies changed. **Knowing what
changed is business knowledge that belongs to the host, not the package** - the
same reasoning that cut the `mergePolicy` rule engine out of the core design.

---

## 9. Dependencies, styling and theming

### 9.1 Why shadcn cannot be a direct dependency

**shadcn/ui is not an installable npm package** - it is source code copied into
the consumer's repository, built on Radix and Tailwind. `npm i shadcn` installs
the CLI, not components. So "depend on shadcn" is not a thing a distributed
component library can do.

### 9.2 Radix has to be an optional peer, never an ordinary dependency

Putting `radix-ui` in `dependencies` while the consumer installs their own copy
lets the package manager resolve **two Radix instances**. Every Radix component
relies on React context - `DialogContext`, `PopperContext` and friends - and
**contexts from two instances do not talk to each other**. The symptoms are
dialogs that will not open, broken focus management and portals mounted in the
wrong place, reproducing only under particular dependency trees.

**What has to be avoided is a duplicate instance and a split visual style, not
the dependency itself.** Hence:

```jsonc
{
  "dependencies":  { "@treenwang/gitkit-client": "workspace:*" },
  "peerDependencies": {
    "react": "^19", "@tanstack/react-query": "^5",
    "radix-ui": "^1", "lucide-react": "*"
  },
  "peerDependenciesMeta": {
    "radix-ui":     { "optional": true },
    "lucide-react": { "optional": true }
  }
}
```

Three tiers of behaviour, highest priority first:

1. **The consumer injected their own components through `components`** - use
   theirs.
2. **Radix is installed** - the first consumer already has `radix-ui@^1.4.3` -
   so Dialog, DropdownMenu and Tooltip use Radix, with **accessibility intact**:
   focus trapping, aria, keyboard navigation, and only one instance.
3. **Neither** - fall back to native `<dialog>` and `<details>`, functional with
   consistent styling and slightly weaker interaction detail.

**Icons take no dependency** and are inlined SVG. Only a handful are used, which
is not worth a constraint.

### 9.3 Styling: semantic tokens only, no bundled CSS

The components use shadcn's semantic token classes only - `bg-background`,
`text-muted-foreground`, `border-border`, `bg-muted/20` and so on. shadcn's
theming is entirely CSS variables, so the components **follow the consumer's
theme automatically**, dark mode included.

**This package bundles no CSS.** The reasoning: shadcn's premise is that the
component source belongs to you and the theme is unified through CSS variables.
Bundling styles would leave this package's components ignoring a theme change
and looking like visual outsiders.

The consumer adds one line to their Tailwind v4 configuration to scan this
package's output:

```css
@source "../node_modules/@treenwang/gitkit-ui/dist";
```

### 9.4 Detecting the mistake in development

Forgetting `@source` leaves the components **completely unstyled with no error
at all**, by far the easiest trap in this approach. So when
`NODE_ENV !== 'production'`, the package checks whether `--background` and the
other CSS variables exist and `console.warn`s the cause and the fix when they do
not.

## 10. Phases

Each phase is independently usable and independently releasable.

**Phase 1 - the main path: edit, commit, pull request**

- Move the repository to a monorepo and rename it (§3)
- Three new APIs in the core package (§6)
- `gitkit-server`: `status` · `files.*` · `changes.*` · `commit` · `push` ·
  `sync.pull`
- `gitkit-client`: typed wrappers for every op
- `gitkit-ui`: `FileTree` · `FileEditor` · `ChangeList` · `DiffView` ·
  `CommitPanel` · `SyncStatus`
- Conflicts get **minimal handling**: when `push` returns a conflict, say so and
  offer to abort the merge, so the main path never wedges

**Phase 2 - conflict resolution**

- Every `conflicts.*` op
- The `ConflictResolver` component: a side per file, a side per hunk,
  hand-editing, and particular presentations for renames and binaries
- The etag 409 from §5.2 gains an automatic three-way merge option, reusing the
  same machinery

**Phase 3 - as needed**

- A fuller pull request wizard: templates, reviewers, labels
- A worked example of deep `@lexical/react` integration
- Better diff viewer adapters

---

## 11. Test strategy

Following the core package's layering: **anything that can be a pure unit test
is one**.

**`gitkit-server`**

- *Pure unit tests, no git and no network*: op routing and argument validation,
  narrowing through `allow`, the error code to HTTP mapping, **stripping
  `detail`, `command` and `worktreeDir`**, `maxContentBytes` truncation, etag
  computation and comparison. Injected with a fake `GitRepo`. **Information
  filtering needs dedicated cases**, asserting one by one that no server path
  can be found in the response body.
- *Integration tests*: real git against a local bare repository, reusing the
  core package's `tests/helpers/fixtures.ts`, running read, write, commit and
  push end to end.
- *Concurrency*: ten concurrent writes for one sessionId, asserting they all
  succeed with no `index.lock` error.

**`gitkit-client`**: `fetch` stubbed, asserting the request shape, error
deserialization, timeouts and aborts.

**`gitkit-ui`**

- Hooks: React Testing Library with a fake client injected. **The autosave state
  machine is the focus** - debounce, maxWait, blur, switching files,
  `visibilitychange` - along with **the three branches of an etag 409**. Time
  uses a fake clock; no waiting on a real `setTimeout`.
- Components: render and interaction assertions, no pixel-level snapshots.
- **No real git inside the `ui` package.** All git behaviour comes from the fake
  client.

**The cross-package contract**: `client` and `server` share one op definition
table, so `npm run typecheck` *is* the contract test - a disagreement about an
op name, its parameters or its result fails at compile time.

**CI**: the core package's matrix (node 18/20/22 against git 2.32/system), plus
a happy-dom environment for the browser side.

---

## 12. Identified risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A consumer forgets the Tailwind `@source` | The components are completely unstyled with no error | Check the CSS variables in development and `console.warn` (§9.4) |
| Per-session serialization fails across several instances | Concurrent writes collide on `index.lock` | The documentation requires sticky sessions; the package does not pretend to solve it |
| Session lifetime drifts from pull request state | The session outlives a merged PR and the user keeps editing a stale branch | `WORKTREE_DISPOSED` gives 410 and the UI starts the user over; the host is responsible for calling `dispose()` once the PR merges |
| `requireChecks` is too coarse, being directory-grained | "Bodies skip checks, the catalog waits for CI" cannot be expressed | Everything waits for CI by default, with an explicit `merge: 'now'` escape hatch |
| shadcn token names change between versions | The components look wrong | Use only the most stable core tokens and list the variables depended on in the documentation |
| Two Radix instances | Dialogs, focus and portals break, and it is hard to reproduce | Declared an optional peer rather than a dependency (§9.2) |
| The request volume autosave produces | Server load | 800 ms debounce plus a 5 s maxWait; a write is an ordinary file write and costs very little |
| A large file or a large diff | The browser stutters or runs out of memory | `maxContentBytes` truncation with a `truncated` marker, and the UI degrades explicitly |
| The monorepo migration introduces a regression | The existing 295 tests break | The migration changes paths only, never logic; all of them passing is what makes it complete |
