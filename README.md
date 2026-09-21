# gitkit

Operate on Git repositories programmatically from a server, and let a browser
edit files, commit, and open pull requests directly.

| Package | Environment | Responsibility |
| --- | --- | --- |
| [`@treenwang/gitkit`](packages/core) | server | The core: sparse checkout, worktree-isolated concurrency, structured conflicts, GitHub pull requests |
| [`@treenwang/gitkit-server`](packages/server) | server | HTTP transport: a web-standard handler plus an Express adapter |
| [`@treenwang/gitkit-client`](packages/client) | browser | Typed RPC client, **zero runtime dependencies** |
| [`@treenwang/gitkit-ui`](packages/ui) | browser | React hooks and components, **no bundled CSS, no editor** |

The protocol contract is defined in the client and reused by the server through
`import type`, so any disagreement between the two fails `npm run typecheck` —
the contract test is the typecheck.

```bash
npm install
npm test          # 481 tests; the integration tests use a local bare repo and never go online
npm run typecheck
npm run build
```

Design documents live in [`docs/superpowers/specs/`](docs/superpowers/specs/).

Two runnable examples are in [`examples/`](examples/): a plain HTML one that
exercises the client, and a React one that exercises `@treenwang/gitkit-ui`.

---

An embeddable npm package for operating on Git repositories from a server:
**check out only the directories you name**, **safe under concurrency**,
**conflicts returned as structured data**, with optional GitHub pull requests.

## What it solves

- You need `docs/` out of a repository and do not want to pull the whole thing
  down: partial clone plus cone-mode sparse checkout.
- Your server handles several tasks against one repository at once: one git
  worktree per task, sharing an object database, none of them interfering.
- Someone else may push from another client at any moment: a rejected push and
  a merge conflict are **return values**, not exceptions.
- The target branch is protected: the main path is fixed as create a branch,
  edit, commit, push, open a pull request.

## Requirements

- Node.js >= 18
- **git >= 2.32** on the host; the worktree and sparse-checkout combination is
  defective in earlier versions
- The workspace on **local disk or a Kubernetes PV**, **owned by a single
  process** - several processes may not share one `root`
- HTTPS personal access token authentication
- Pull requests need `@octokit/rest`, an optional peerDependency. Without it
  the core git features are unaffected.

## Quick start

```ts
import { RepoManager } from '@treenwang/gitkit'

const manager = new RepoManager({
  root: '/data/repos',
  auth: { token: process.env.GH_TOKEN! },
})

const store = await manager.store({
  url: 'https://github.com/acme/web',
  github: {},                        // enables pull requests, reusing the token above
})

const result = await store.publish({
  branch: 'feat/docs-update',
  sparsePaths: [
    { path: 'docs', requireChecks: false },   // docs can merge straight away
    { path: 'src', requireChecks: true },     // code has to wait for CI
  ],
  author: { name: 'Bot', email: 'bot@acme.io' },
  message: 'docs: update getting started',
  files: [{ path: 'docs/getting-started.md', content: '# Hello\n' }],
  createPR: { title: 'Update docs', base: 'main' },
  merge: 'auto',
})
```

## Core concepts

### Three layers

```
RepoManager   store lifecycle, clone dedup, preflight, disk reclamation
  └ RepoStore   one shared object database per URL; opens and closes sessions, fetches, branches
      └ GitRepo   the operation facade bound to a single worktree
```

### Concurrency model

One `git worktree` per task: a single object database, which saves disk, with
its own HEAD and index, which makes it genuinely concurrent. Only `fetch` and
`worktree add/remove` go through an in-process serial queue; everything inside a
worktree is unlocked.

That is why **one `root` directory can only be used by one process**. Under
Kubernetes, a StatefulSet with a ReadWriteOnce PV.

### sparse-checkout

**Cone mode only** - directory prefixes, no wildcards. A worktree is always
created in the order `worktree add --no-checkout`, `sparse-checkout set`,
`checkout`; getting that wrong makes a partial clone fetch every blob.

Note that cone mode **always includes the files at the repository root**, which
is git's own behaviour, but `PathGuard` still refuses writes to those files so
nothing leaves the range you declared.

## The push state machine

```
push the branch
 ├─ succeeded ──────► createPR, if configured ─► handle the merge mode ─► ok: true
 └─ rejected (non-fast-forward)
      └─ retryOnReject, true by default ─► pull, merge strategy by default
            ├─ no conflict ─► push once more (one retry only)
            └─ conflict ───► stop mid-merge, return reason: 'conflict'
```

```ts
const r = await repo.push({ createPR: { title, base: 'main' }, merge: 'auto' })

if (r.ok) {
  r.pr                  // the pull request was opened
  r.autoMerge           // how the merge went; a failure changes neither r.ok nor r.pr
} else if (r.reason === 'conflict') {
  r.conflicts           // structured conflicts
  r.worktreeDir         // the conflict state, which store.attachSession() can take over
}
```

### Merge modes

| Value | Meaning |
| --- | --- |
| `'auto'` (default) | Derived from the `sparsePaths.requireChecks` the changed files match, **taking the most conservative** |
| `'now'` | Merge immediately (`PUT /pulls/{n}/merge`) |
| `'checksPass'` | GitHub's native auto-merge; GitHub merges once the required checks pass |
| `false` | Open the pull request only and merge by hand |

`'auto'` decides the blast radius with `git diff --name-only base...HEAD`, which
reads trees only and never triggers a partial clone's lazy blob fetching.

## Conflicts

**Not every conflict has `<<<<<<<` markers.** Only a text file both sides
modified does. delete/modify, rename and binary conflicts leave no markers in
the working tree at all, so this package decides the type from the stage bits of
`git ls-files -u` and always reads all three sides per stage with
`cat-file blob`.

```ts
const conflicts = await repo.getConflicts()
// { path, type, binary, base?, ours?, theirs?, hunks?, raw?, sidesSwapped? }

// pick a side for the whole file
await repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])
// delete, which a delete/modify conflict requires
await repo.resolveConflicts([{ path: 'docs/b.md', take: 'delete' }])
// hand-edited content
await repo.resolveConflicts([{ path: 'docs/c.md', content: merged }])
// a side per hunk
await repo.resolveByHunks('docs/a.md', ['ours', 'theirs', { content: '...' }])

await repo.commit({ message: 'resolve conflicts' })   // concludes a merge
await repo.continueRebase()                           // concludes a rebase
```

`type` is one of `both_modified`, `both_added`, `deleted_by_them`,
`deleted_by_us` and `rename`. Renames are detected but never resolved
automatically; `ourPath` and `theirPath` hand the decision to you.

**Rebase direction is normalized.** During a rebase git's stages 2 and 3 are
reversed: stage 2 is the upstream being rebased onto and stage 3 the commit
being replayed. This package normalizes that, so `ours` always means **the
change on your branch**, with `sidesSwapped: true` when a swap happened.

## Session lifecycle

```ts
// Releases itself. If it exits mid-merge or mid-rebase, the worktree is kept
// and MERGE_IN_PROGRESS is thrown.
await store.withSession(cfg, async (repo) => { /* ... */ })

// Managed by hand
const repo = await store.createSession(cfg)
try { /* ... */ } finally { await repo.dispose() }

// Take a kept worktree back over, e.g. to recover conflict state after a restart
const repo = await store.attachSession(worktreeDir)

// Inspect
await store.listSessions()   // [{ dir, branch, state: 'clean'|'conflicted'|'merging' }]
```

**Leftover merge or rebase state is never cleaned up automatically** - an
automatic abort could discard a conflict someone had half resolved. Handle it
explicitly with `repo.recover({ abortOperation: true })`.

## Error handling

Expected outcomes are return values: a rejected push, a conflict, a pull request
blocked by protection rules. Only genuine failures throw a `GitOpError`, which
carries a `code` and a scrubbed `detail` and `command`.

```
GIT_NOT_FOUND · GIT_VERSION_TOO_OLD · AUTH_FAILED · NETWORK · TIMEOUT
NOT_A_REPO · DIRTY_WORKTREE · MERGE_IN_PROGRESS
BRANCH_IN_USE · BRANCH_EXISTS · BRANCH_NOT_FOUND · WORKTREE_DISPOSED
PATH_OUTSIDE_SPARSE · PATH_TRAVERSAL · INVALID_ARGUMENT
FORGE_NOT_INSTALLED · FORGE_API_ERROR · UNKNOWN
```

stderr that matches nothing is always `UNKNOWN` plus the raw output. It never
guesses.

## Security

- **The token is never written into the URL**, where it would land in
  `.git/config` and the reflog. It is injected per invocation with
  `-c http.extraheader`.
- The token never appears in logs, error messages or the `command` field; it is
  always scrubbed to `***`.
- File access goes through `PathGuard`, which refuses directory traversal,
  access to `.git`, and anything outside the sparse range, then re-checks with
  `realpath` immediately before reading or writing to close the symlink escape.

## Development

```bash
npm install
npm test          # 481 tests across the repo; the integration tests use a local bare repo and never go online
npm run typecheck
npm run build
```

Design documents live in [`docs/superpowers/specs/`](docs/superpowers/specs/).
