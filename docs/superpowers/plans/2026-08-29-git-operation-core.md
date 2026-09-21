# @treenwang/git-operation — plan 1 of 3: the core (sparse worktrees and basic git operations)

> **Status: superseded by the implementation (2026-08-29).**
> This plan was implemented in full, and implementing it uncovered several
> defects it did not cover: rebase state, the shared-config race, the reversed
> ours/theirs during a rebase, and others. **The code and appendix A of the spec
> are the current truth**; this document is kept only as a record of how the
> work was originally broken down. Plans 2 and 3 (the conflict layer and the
> GitHub layer) were never written up separately - their scope was implemented
> and tested directly.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** deliver a working package skeleton that can make a partial, sparse clone of a GitHub repository, open an independent worktree per concurrent task, read and write files in it, commit, push the branch, and release it safely.

**Architecture:** three layers, dependencies pointing one way. Layer 1 (`exec/`) is the only place that spawns git; layer 2 (`domain/`) is entirely pure functions that never touch IO; layer 3 (`api/`) is the three-level facade `RepoManager`, `RepoStore`, `GitRepo`. Concurrency is isolated by git worktrees, with only `fetch` and `worktree add/remove` going through an in-process mutex.

**Tech Stack:** TypeScript 5.x · Bun (`bun test`) · tsup (ESM + CJS + d.ts) · simple-git · system git >= 2.32

**Spec:** `docs/superpowers/specs/2026-08-29-git-operation-package-design.md`

## Global Constraints

These constraints apply to **every** task and are not repeated per task:

- The package is `@treenwang/git-operation`. The runtime target is **Node >= 18**, and the source **must not use any `Bun.*` API** - Bun is only for running tests and development.
- System **git >= 2.32**. Preflight has to block anything lower.
- **`src/exec/git-executor.ts` is the only place that spawns or execs git.** `child_process`, `simple-git`, `spawn` or `exec` appearing in any other file is an implementation error.
- **Nothing under `src/domain/` touches IO**: no importing `node:fs` or `node:child_process`, and no callback-style IO. Inputs and outputs are strings and plain objects only.
- **`GitRepo` never locks.** Only `RepoStore` may use `StoreMutex`.
- **The token never reaches the URL, the logs, an error message or the `command` field.** Authentication is always injected per invocation with `-c http.extraheader=...`.
- sparse-checkout is **cone mode only** - directory prefixes, no globs.
- Every git call injects `-c merge.conflictStyle=diff3`.
- Commit messages are in English and follow Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`).

## File Structure

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Every public type, plus `GitOpError` and `GitErrorCode` |
| `src/exec/sanitize.ts` | Pure function: scrub secrets out of arbitrary text |
| `src/exec/git-executor.ts` | The only place that spawns git: auth injection, timeouts, progress, scrubbing |
| `src/exec/store-mutex.ts` | An in-process serial queue, keyed |
| `src/exec/fs-gateway.ts` | File reads and writes, constrained by `PathGuard` |
| `src/domain/error-mapper.ts` | Pure function: git stderr to a `GitErrorCode` |
| `src/domain/layout-planner.ts` | Pure function: `root` plus a url to store and worktree paths |
| `src/domain/path-guard.ts` | Pure function: relative path validation, for traversal and the sparse range |
| `src/domain/sparse-manager.ts` | Pure function: `sparsePaths` normalization and cone validation |
| `src/api/repo-manager.ts` | Store lifecycle, clone dedup, preflight, startup cleanup, gc |
| `src/api/repo-store.ts` | The shared object database: fetch, branches, session lifecycle |
| `src/api/git-repo.ts` | The operation facade bound to a single worktree |
| `src/index.ts` | Re-exports the public API and types, nothing else |

---

### Task 1: project scaffolding and secret scrubbing

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`, `src/types.ts`
- Create: `src/exec/sanitize.ts`
- Test: `tests/unit/sanitize.test.ts`

**Interfaces:**
- Consumes: nothing; this is the first task
- Produces:
  - `class GitOpError extends Error { code: GitErrorCode; detail: string; command?: string; cause?: unknown }`
  - `type GitErrorCode` - see the code below; this one definition is used throughout the plan
  - `redact(text: string, secrets: readonly string[]): string`

- [ ] **Step 1: initialize the project files**

`package.json`:

```json
{
  "name": "@treenwang/git-operation",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsup",
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "simple-git": "^3.27.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsup": "^8.0.0",
    "typescript": "^5.5.0"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node", "bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`tsup.config.ts`：

```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node18',
  sourcemap: true,
})
```

- [ ] **Step 2: write `src/types.ts`**

```ts
export type GitErrorCode =
  | 'GIT_NOT_FOUND'
  | 'GIT_VERSION_TOO_OLD'
  | 'AUTH_FAILED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'NOT_A_REPO'
  | 'DIRTY_WORKTREE'
  | 'MERGE_IN_PROGRESS'
  | 'BRANCH_IN_USE'
  | 'BRANCH_EXISTS'
  | 'BRANCH_NOT_FOUND'
  | 'WORKTREE_DISPOSED'
  | 'PATH_OUTSIDE_SPARSE'
  | 'PATH_TRAVERSAL'
  | 'INVALID_ARGUMENT'
  | 'FORGE_NOT_INSTALLED'
  | 'FORGE_API_ERROR'
  | 'UNKNOWN'

export class GitOpError extends Error {
  readonly code: GitErrorCode
  readonly detail: string
  readonly command?: string
  constructor(
    code: GitErrorCode,
    message: string,
    opts: { detail?: string; command?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'GitOpError'
    this.code = code
    this.detail = opts.detail ?? ''
    this.command = opts.command
  }
}

export type SparsePath = { path: string; requireChecks?: boolean }

export type ProgressEvent = {
  phase: 'clone' | 'fetch' | 'pull' | 'push' | 'checkout' | 'worktree'
  message: string
  percent?: number
}
```

- [ ] **Step 3: write the failing scrubbing tests**

`tests/unit/sanitize.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { redact } from '../../src/exec/sanitize'

describe('redact', () => {
  test('replaces a plaintext secret', () => {
    expect(redact('token is ghp_abc123', ['ghp_abc123'])).toBe('token is ***')
  })

  test('replaces the base64-encoded secret, the form http.extraheader uses', () => {
    const token = 'ghp_abc123'
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64')
    const line = `git -c http.extraheader=AUTHORIZATION: basic ${encoded} fetch`
    const out = redact(line, [token])
    expect(out).not.toContain(encoded)
    expect(out).toContain('***')
  })

  test('replaces every occurrence', () => {
    expect(redact('a T b T c', ['T'])).toBe('a *** b *** c')
  })

  test('an empty secret is ignored rather than replacing everything', () => {
    expect(redact('hello', ['', '  '])).toBe('hello')
  })

  test('a secret containing regex metacharacters is replaced literally', () => {
    expect(redact('v=a.b*c', ['a.b*c'])).toBe('v=***')
  })

  test('returns the text unchanged when there is no secret', () => {
    expect(redact('nothing to hide', [])).toBe('nothing to hide')
  })
})
```

- [ ] **Step 4: run the tests and confirm they fail**

Run: `bun test tests/unit/sanitize.test.ts`
Expected: FAIL —— `Cannot find module '../../src/exec/sanitize'`

- [ ] **Step 5: implement `src/exec/sanitize.ts`**

```ts
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scrub secrets out of arbitrary text. Besides the literal value, this also
 * scrubs the base64 form of `x-access-token:<secret>` - the shape the secret
 * takes on the command line once http.extraheader has injected it.
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (!secret || !secret.trim()) continue
    const variants = [
      secret,
      Buffer.from(`x-access-token:${secret}`).toString('base64'),
      Buffer.from(secret).toString('base64'),
    ]
    for (const v of variants) {
      out = out.replace(new RegExp(escapeRegExp(v), 'g'), '***')
    }
  }
  return out
}
```

- [ ] **Step 6: write a minimal `src/index.ts`**

```ts
export * from './types'
```

- [ ] **Step 7: run the tests and the typecheck**

Run: `bun install && bun test tests/unit/sanitize.test.ts && bun run typecheck`
Expected: 6 tests PASS and a clean typecheck

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts src tests
git commit -m "feat: scaffold package and add secret redaction"
```

---

### Task 2: ErrorMapper, a pure function

**Files:**
- Create: `src/domain/error-mapper.ts`
- Test: `tests/unit/error-mapper.test.ts`

**Interfaces:**
- Consumes: `GitErrorCode` from task 1
- Produces: `mapGitError(stderr: string, exitCode?: number): GitErrorCode`

- [ ] **Step 1: write the failing tests**

`tests/unit/error-mapper.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { mapGitError } from '../../src/domain/error-mapper'

describe('mapGitError', () => {
  const cases: Array<[string, string, string]> = [
    ['authentication failure', "fatal: Authentication failed for 'https://github.com/a/b.git/'", 'AUTH_FAILED'],
    ['401', 'fatal: unable to access: The requested URL returned error: 403', 'AUTH_FAILED'],
    ['DNS failure', 'fatal: unable to access: Could not resolve host: github.com', 'NETWORK'],
    ['connection timeout', 'fatal: unable to access: Failed to connect to github.com port 443: Connection timed out', 'NETWORK'],
    ['not a repository', 'fatal: not a git repository (or any of the parent directories): .git', 'NOT_A_REPO'],
    ['dirty worktree', 'error: Your local changes to the following files would be overwritten by merge:', 'DIRTY_WORKTREE'],
    ['merge in progress', 'fatal: You have not concluded your merge (MERGE_HEAD exists).', 'MERGE_IN_PROGRESS'],
    ['branch already in use', "fatal: 'feat/x' is already checked out at '/data/wt/a'", 'BRANCH_IN_USE'],
    ['branch already exists', "fatal: a branch named 'feat/x' already exists", 'BRANCH_EXISTS'],
  ]

  for (const [name, stderr, expected] of cases) {
    test(name, () => {
      expect(mapGitError(stderr)).toBe(expected as never)
    })
  }

  test('returns UNKNOWN when nothing matches, and never guesses', () => {
    expect(mapGitError('fatal: something nobody has ever seen before')).toBe('UNKNOWN')
  })

  test('empty stderr returns UNKNOWN', () => {
    expect(mapGitError('')).toBe('UNKNOWN')
  })

  test('matching ignores case', () => {
    expect(mapGitError('FATAL: AUTHENTICATION FAILED for x')).toBe('AUTH_FAILED')
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/unit/error-mapper.test.ts`
Expected: FAIL - the module does not exist

- [ ] **Step 3: implement `src/domain/error-mapper.ts`**

```ts
import type { GitErrorCode } from '../types'

/**
 * stderr patterns to error codes. Order matters: first match wins.
 * Anything unmatched returns UNKNOWN - a wrong code is worse than no code.
 */
const RULES: Array<[RegExp, GitErrorCode]> = [
  [/authentication failed|invalid username or password|returned error: 40[13]/i, 'AUTH_FAILED'],
  [/could not resolve host|failed to connect|connection timed out|network is unreachable|ssl certificate problem/i, 'NETWORK'],
  [/not a git repository/i, 'NOT_A_REPO'],
  [/is already checked out at/i, 'BRANCH_IN_USE'],
  [/a branch named .* already exists|already exists\.$/im, 'BRANCH_EXISTS'],
  [/you have not concluded your merge|merge_head exists|you are in the middle of a merge/i, 'MERGE_IN_PROGRESS'],
  [/local changes to the following files would be overwritten|your local changes would be overwritten/i, 'DIRTY_WORKTREE'],
]

export function mapGitError(stderr: string, exitCode?: number): GitErrorCode {
  if (!stderr) return 'UNKNOWN'
  for (const [re, code] of RULES) {
    if (re.test(stderr)) return code
  }
  return 'UNKNOWN'
}
```

- [ ] **Step 4: run the tests and confirm they pass**

Run: `bun test tests/unit/error-mapper.test.ts`
Expected: 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/error-mapper.ts tests/unit/error-mapper.test.ts
git commit -m "feat: map git stderr to structured error codes"
```

---

### Task 3: LayoutPlanner, a pure function

**Files:**
- Create: `src/domain/layout-planner.ts`
- Test: `tests/unit/layout-planner.test.ts`

**Interfaces:**
- Consumes: `GitOpError`（Task 1）
- Produces:
  - `planLayout(root: string, url: string): { key: string; repoDir: string; storeDir: string; worktreeRoot: string }`
  - `worktreeDirFor(worktreeRoot: string, sessionId: string): string`

`key` uniquely identifies a store and doubles as the `StoreMutex` key.

- [ ] **Step 1: write the failing tests**

`tests/unit/layout-planner.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { planLayout, worktreeDirFor } from '../../src/domain/layout-planner'
import { GitOpError } from '../../src/types'

describe('planLayout', () => {
  test('a standard https url', () => {
    const l = planLayout('/data/repos', 'https://github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).toBe('/data/repos/github.com/acme/web')
    expect(l.storeDir).toBe('/data/repos/github.com/acme/web/store')
    expect(l.worktreeRoot).toBe('/data/repos/github.com/acme/web/wt')
  })

  test('strips the .git suffix', () => {
    expect(planLayout('/r', 'https://github.com/acme/web.git').key).toBe('github.com/acme/web')
  })

  test('strips a trailing slash', () => {
    expect(planLayout('/r', 'https://github.com/acme/web/').key).toBe('github.com/acme/web')
  })

  test('the host is lowercased and the path keeps its case', () => {
    expect(planLayout('/r', 'https://GitHub.COM/Acme/Web').key).toBe('github.com/Acme/Web')
  })

  test('a self-hosted GHE with a port', () => {
    expect(planLayout('/r', 'https://git.corp.io:8443/g/p').key).toBe('git.corp.io_8443/g/p')
  })

  test('credentials in the url are dropped and never reach the path', () => {
    const l = planLayout('/r', 'https://user:tok@github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).not.toContain('tok')
  })

  test('suspicious characters in a path segment are replaced', () => {
    expect(planLayout('/r', 'https://github.com/a..b/c').key).toBe('github.com/a__b/c')
  })

  test('a url that is not http(s) throws INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'git@github.com:acme/web.git')).toThrow(GitOpError)
  })

  test('a missing owner/repo throws INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'https://github.com/')).toThrow(GitOpError)
  })
})

describe('worktreeDirFor', () => {
  test('joins on the sessionId', () => {
    expect(worktreeDirFor('/r/wt', 'abc123')).toBe('/r/wt/abc123')
  })

  test('a sessionId containing a separator throws', () => {
    expect(() => worktreeDirFor('/r/wt', '../escape')).toThrow(GitOpError)
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/unit/layout-planner.test.ts`
Expected: FAIL - the module does not exist

- [ ] **Step 3: implement `src/domain/layout-planner.ts`**

```ts
import { posix } from 'node:path'
import { GitOpError } from '../types'

export type Layout = {
  key: string
  repoDir: string
  storeDir: string
  worktreeRoot: string
}

/** Keep only safe characters in a path segment, so `..` and separators cannot reach a filesystem path. */
function safeSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '__')
}

export function planLayout(root: string, url: string): Layout {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GitOpError('INVALID_ARGUMENT', `cannot parse the repository URL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GitOpError('INVALID_ARGUMENT', `only http(s) URLs are supported, got: ${parsed.protocol}`)
  }

  const host = parsed.port
    ? `${parsed.hostname.toLowerCase()}_${parsed.port}`
    : parsed.hostname.toLowerCase()

  const segments = parsed.pathname
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
    .map(safeSegment)

  if (segments.length < 2) {
    throw new GitOpError('INVALID_ARGUMENT', `URL has no owner/repo: ${url}`)
  }

  const key = [safeSegment(host), ...segments].join('/')
  const repoDir = posix.join(root, key)
  return {
    key,
    repoDir,
    storeDir: posix.join(repoDir, 'store'),
    worktreeRoot: posix.join(repoDir, 'wt'),
  }
}

export function worktreeDirFor(worktreeRoot: string, sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw new GitOpError('INVALID_ARGUMENT', `invalid sessionId: ${sessionId}`)
  }
  return posix.join(worktreeRoot, sessionId)
}
```

- [ ] **Step 4: run the tests and confirm they pass**

Run: `bun test tests/unit/layout-planner.test.ts`
Expected: 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/layout-planner.ts tests/unit/layout-planner.test.ts
git commit -m "feat: derive store and worktree paths from repo url"
```

---

### Task 4: SparseManager, a pure function

**Files:**
- Create: `src/domain/sparse-manager.ts`
- Test: `tests/unit/sparse-manager.test.ts`

**Interfaces:**
- Consumes: `SparsePath`, `GitOpError`（Task 1）
- Produces:
  - `normalizeSparsePaths(input?: readonly (string | SparsePath)[]): SparsePath[]`
  - `isFullCheckout(paths: SparsePath[]): boolean`

Normalization: convert to POSIX separators, strip leading and trailing slashes, deduplicate, and **drop any subpath a parent directory already covers**, since in cone mode a parent already includes its subdirectories. Validation: refuse glob characters, `..`, absolute paths and the empty string.

- [ ] **Step 1: write the failing tests**

`tests/unit/sparse-manager.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { isFullCheckout, normalizeSparsePaths } from '../../src/domain/sparse-manager'
import { GitOpError } from '../../src/types'

describe('normalizeSparsePaths', () => {
  test('undefined and an empty array both mean a full checkout', () => {
    expect(normalizeSparsePaths(undefined)).toEqual([])
    expect(normalizeSparsePaths([])).toEqual([])
    expect(isFullCheckout([])).toBe(true)
  })

  test('the string shorthand defaults to requireChecks: true, the conservative choice', () => {
    expect(normalizeSparsePaths(['docs'])).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('the object form keeps requireChecks', () => {
    expect(normalizeSparsePaths([{ path: 'docs', requireChecks: false }]))
      .toEqual([{ path: 'docs', requireChecks: false }])
  })

  test('the object form defaults requireChecks to true when it is omitted', () => {
    expect(normalizeSparsePaths([{ path: 'src' }])).toEqual([{ path: 'src', requireChecks: true }])
  })

  test('backslashes become forward slashes and leading and trailing slashes are stripped', () => {
    expect(normalizeSparsePaths(['\\docs\\api\\'])[0]!.path).toBe('docs/api')
  })

  test('duplicate paths are deduplicated', () => {
    expect(normalizeSparsePaths(['docs', 'docs/'])).toHaveLength(1)
  })

  test('a subpath already covered by a parent directory is dropped', () => {
    const out = normalizeSparsePaths(['docs', 'docs/api'])
    expect(out).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('a parent directory takes the most conservative requireChecks', () => {
    const out = normalizeSparsePaths([
      { path: 'docs', requireChecks: false },
      { path: 'docs/api', requireChecks: true },
    ])
    expect(out).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('paths with a similar prefix but no parent relationship are all kept', () => {
    const out = normalizeSparsePaths(['docs', 'docsite'])
    expect(out.map((p) => p.path).sort()).toEqual(['docs', 'docsite'])
  })

  test('output is sorted by path, so results are stable', () => {
    expect(normalizeSparsePaths(['b', 'a']).map((p) => p.path)).toEqual(['a', 'b'])
  })

  const bad: Array<[string, string]> = [
    ['glob star', 'docs/*'],
    ['glob question mark', 'docs/?.md'],
    ['glob brackets', 'docs/[ab]'],
    ['negation prefix', '!docs'],
    ['parent traversal', '../etc'],
    ['embedded traversal', 'docs/../../etc'],
    ['absolute path', '/etc'],
    ['empty string', ''],
    ['whitespace only', '   '],
  ]
  for (const [name, p] of bad) {
    test(`refuses: ${name}`, () => {
      expect(() => normalizeSparsePaths([p])).toThrow(GitOpError)
    })
  }
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/unit/sparse-manager.test.ts`
Expected: FAIL - the module does not exist

- [ ] **Step 3: implement `src/domain/sparse-manager.ts`**

```ts
import { GitOpError, type SparsePath } from '../types'

function validate(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
  if (!p) throw new GitOpError('INVALID_ARGUMENT', 'a sparse path cannot be empty')
  if (raw.startsWith('/')) throw new GitOpError('INVALID_ARGUMENT', `a sparse path must be relative: ${raw}`)
  if (/[*?[\]!]/.test(p)) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `sparse paths do not support wildcards; only cone-mode directory prefixes: ${raw}`,
    )
  }
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new GitOpError('INVALID_ARGUMENT', `a sparse path must not contain . or ..: ${raw}`)
  }
  return p
}

function isAncestor(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`)
}

export function normalizeSparsePaths(
  input?: readonly (string | SparsePath)[],
): SparsePath[] {
  if (!input || input.length === 0) return []

  const merged = new Map<string, boolean>()
  for (const item of input) {
    const raw = typeof item === 'string' ? item : item.path
    const requireChecks = typeof item === 'string' ? true : item.requireChecks ?? true
    const path = validate(raw)
    // When one path appears twice, take the most conservative value
    merged.set(path, (merged.get(path) ?? false) || requireChecks)
  }

  const sorted = [...merged.keys()].sort()
  const kept: SparsePath[] = []
  for (const path of sorted) {
    const ancestor = kept.find((k) => isAncestor(k.path, path))
    if (ancestor) {
      // A parent covers this subpath: drop it, but merge its requireChecks upward as the most conservative value
      ancestor.requireChecks = ancestor.requireChecks || merged.get(path)!
      continue
    }
    kept.push({ path, requireChecks: merged.get(path)! })
  }
  return kept
}

export function isFullCheckout(paths: readonly SparsePath[]): boolean {
  return paths.length === 0
}
```

- [ ] **Step 4: run the tests and confirm they pass**

Run: `bun test tests/unit/sparse-manager.test.ts`
Expected: 19 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/sparse-manager.ts tests/unit/sparse-manager.test.ts
git commit -m "feat: normalize and validate cone-mode sparse paths"
```

---

### Task 5: PathGuard, a pure function

**Files:**
- Create: `src/domain/path-guard.ts`
- Test: `tests/unit/path-guard.test.ts`

**Interfaces:**
- Consumes: `SparsePath`, `GitOpError`（Task 1）
- Produces: `resolveWithin(worktreeDir: string, relPath: string, sparse: readonly SparsePath[]): string`

Returns an absolute path. Leaving the worktree throws `PATH_TRAVERSAL`; leaving the sparse range throws `PATH_OUTSIDE_SPARSE`.

- [ ] **Step 1: write the failing tests**

`tests/unit/path-guard.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { resolveWithin } from '../../src/domain/path-guard'
import { GitOpError } from '../../src/types'

const WT = '/wt/task-1'
const SPARSE = [{ path: 'docs', requireChecks: true }]

function codeOf(fn: () => unknown): string {
  try { fn(); return 'NO_THROW' } catch (e) { return (e as GitOpError).code }
}

describe('resolveWithin', () => {
  test('a path inside the sparse range passes', () => {
    expect(resolveWithin(WT, 'docs/a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('the sparse directory itself passes', () => {
    expect(resolveWithin(WT, 'docs', SPARSE)).toBe('/wt/task-1/docs')
  })

  test('normalizes redundant segments', () => {
    expect(resolveWithin(WT, './docs/./a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('full-checkout mode, with sparse empty, allows any path inside the repository', () => {
    expect(resolveWithin(WT, 'src/x.ts', [])).toBe('/wt/task-1/src/x.ts')
  })

  test('escaping the worktree gives PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '../other/a.md', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('a deep traversal gives PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, 'docs/../../etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('an absolute path gives PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '/etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('inside the repository but outside the sparse range gives PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'src/index.ts', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('a shared prefix that is not a subdirectory gives PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'docsite/a.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('a repository root file is refused in sparse mode - cone mode keeps root files, but this package will not write them', () => {
    expect(codeOf(() => resolveWithin(WT, 'README.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('an empty path gives INVALID_ARGUMENT', () => {
    expect(codeOf(() => resolveWithin(WT, '', SPARSE))).toBe('INVALID_ARGUMENT')
  })

  test('the .git directory is always refused', () => {
    expect(codeOf(() => resolveWithin(WT, '.git/config', []))).toBe('PATH_TRAVERSAL')
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/unit/path-guard.test.ts`
Expected: FAIL - the module does not exist

- [ ] **Step 3: implement `src/domain/path-guard.ts`**

```ts
import { posix } from 'node:path'
import { GitOpError, type SparsePath } from '../types'

/**
 * Validate and resolve a relative path inside the worktree.
 *
 * Note that this is a pure function and does not resolve symlinks, which would
 * need IO. Its caller FsGateway has to refuse symlinks with lstat before
 * writing - see exec/fs-gateway.ts.
 */
export function resolveWithin(
  worktreeDir: string,
  relPath: string,
  sparse: readonly SparsePath[],
): string {
  if (!relPath || !relPath.trim()) {
    throw new GitOpError('INVALID_ARGUMENT', 'the path cannot be empty')
  }

  const normalizedInput = relPath.replace(/\\/g, '/')
  if (posix.isAbsolute(normalizedInput)) {
    throw new GitOpError('PATH_TRAVERSAL', `absolute paths are not accepted: ${relPath}`)
  }

  const rel = posix.normalize(normalizedInput).replace(/^\.\//, '').replace(/\/+$/, '')
  if (rel === '..' || rel.startsWith('../')) {
    throw new GitOpError('PATH_TRAVERSAL', `path escapes the worktree: ${relPath}`)
  }
  if (rel === '.git' || rel.startsWith('.git/')) {
    throw new GitOpError('PATH_TRAVERSAL', `access to the .git directory is not allowed: ${relPath}`)
  }

  if (sparse.length > 0) {
    const inScope = sparse.some((s) => rel === s.path || rel.startsWith(`${s.path}/`))
    if (!inScope) {
      const allowed = sparse.map((s) => s.path).join(', ')
      throw new GitOpError(
        'PATH_OUTSIDE_SPARSE',
        `path ${rel} is outside the sparse range (allowed: ${allowed})`,
      )
    }
  }

  return posix.join(worktreeDir, rel)
}
```

- [ ] **Step 4: run the tests and confirm they pass**

Run: `bun test tests/unit/path-guard.test.ts`
Expected: 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/path-guard.ts tests/unit/path-guard.test.ts
git commit -m "feat: guard worktree paths against traversal and sparse escape"
```

---

### Task 6: StoreMutex, serializing by key

**Files:**
- Create: `src/exec/store-mutex.ts`
- Test: `tests/unit/store-mutex.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `class StoreMutex { run<T>(key: string, fn: () => Promise<T>): Promise<T> }`

- [ ] **Step 1: write the failing tests**

`tests/unit/store-mutex.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { StoreMutex } from '../../src/exec/store-mutex'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('StoreMutex', () => {
  test('tasks with the same key run serially and never overlap', async () => {
    const m = new StoreMutex()
    const events: string[] = []
    const job = (name: string, ms: number) => async () => {
      events.push(`${name}:start`)
      await tick(ms)
      events.push(`${name}:end`)
      return name
    }
    await Promise.all([m.run('k', job('a', 20)), m.run('k', job('b', 1))])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  test('tasks with different keys run concurrently', async () => {
    const m = new StoreMutex()
    const events: string[] = []
    const job = (name: string, ms: number) => async () => {
      events.push(`${name}:start`)
      await tick(ms)
      events.push(`${name}:end`)
    }
    await Promise.all([m.run('k1', job('a', 20)), m.run('k2', job('b', 1))])
    expect(events[0]).toBe('a:start')
    expect(events[1]).toBe('b:start')  // b was not blocked by a
  })

  test('return values pass through', async () => {
    const m = new StoreMutex()
    await expect(m.run('k', async () => 42)).resolves.toBe(42)
  })

  test('a throw does not wedge the queue and later tasks still run', async () => {
    const m = new StoreMutex()
    await expect(m.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(m.run('k', async () => 'ok')).resolves.toBe('ok')
  })

  test('no key is left behind once the queue drains, so nothing leaks', async () => {
    const m = new StoreMutex()
    await m.run('k', async () => 1)
    expect(m.size).toBe(0)
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/unit/store-mutex.test.ts`
Expected: FAIL - the module does not exist

- [ ] **Step 3: implement `src/exec/store-mutex.ts`**

```ts
/**
 * An in-process serial queue, keyed.
 *
 * It exists only to protect store-level shared state: git fetch, which writes
 * refs and objects, and git worktree add/remove, which writes .git/worktrees.
 * Operations inside a worktree take no lock at all - see spec §3.4.
 *
 * This package assumes a single process owns the root directory, so no file
 * lock or distributed lock is needed.
 */
export class StoreMutex {
  #tails = new Map<string, Promise<unknown>>()

  get size(): number {
    return this.#tails.size
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve()
    // Queue on regardless of whether the previous task succeeded, so one failure cannot wedge the queue
    const result = prev.then(fn, fn)
    const tail = result.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    this.#tails.set(key, tail)
    return result
  }
}
```

- [ ] **Step 4: run the tests and confirm they pass**

Run: `bun test tests/unit/store-mutex.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/exec/store-mutex.ts tests/unit/store-mutex.test.ts
git commit -m "feat: serialize store-level git operations per key"
```

---

### Task 7: GitExecutor, the only place that spawns git

**Files:**
- Create: `src/exec/git-executor.ts`
- Test: `tests/integration/git-executor.test.ts`
- Test: `tests/helpers/fixtures.ts`

**Interfaces:**
- Consumes: `redact`（Task 1）、`mapGitError`（Task 2）、`GitOpError` / `ProgressEvent`（Task 1）
- Produces:
  - `type ExecOptions = { cwd?: string; token?: string; timeout?: number; phase?: ProgressEvent['phase'] }`
  - `class GitExecutor { constructor(opts: { gitPath?: string; timeout?: number; onProgress?: (e: ProgressEvent) => void }); run(args: string[], opts?: ExecOptions): Promise<string>; version(): Promise<{ major: number; minor: number; patch: number; raw: string }> }`

`run` returns trimmed stdout. On failure it throws a `GitOpError` whose `code` comes from `mapGitError`, with `detail` and `command` both scrubbed.

- [ ] **Step 1: write the test helpers, against real git**

`tests/helpers/fixtures.ts`：

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(prefix = 'gitop-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  })
}

/**
 * Build a bare repository with content to act as the remote, returning a path
 * usable as a clone url.
 * Layout: docs/a.md, docs/api/b.md, src/index.ts, README.md
 */
export function makeBareRemote(root: string): string {
  const bare = join(root, 'remote.git')
  const seed = join(root, 'seed')
  mkdirSync(bare, { recursive: true })
  mkdirSync(seed, { recursive: true })

  git(bare, 'init', '--bare', '-b', 'main', '.')
  git(seed, 'init', '-b', 'main', '.')

  mkdirSync(join(seed, 'docs', 'api'), { recursive: true })
  mkdirSync(join(seed, 'src'), { recursive: true })
  writeFileSync(join(seed, 'docs', 'a.md'), '# a\n')
  writeFileSync(join(seed, 'docs', 'api', 'b.md'), '# b\n')
  writeFileSync(join(seed, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(seed, 'README.md'), '# readme\n')

  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'remote', 'add', 'origin', bare)
  git(seed, 'push', 'origin', 'main')
  return bare
}

/** Add a commit on the remote, simulating "someone else pushed". */
export function pushToRemote(
  root: string,
  bare: string,
  files: Record<string, string>,
  message = 'external change',
): void {
  const clone = join(root, `ext-${Math.random().toString(36).slice(2, 8)}`)
  git(root, 'clone', bare, clone)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(clone, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  git(clone, 'add', '-A')
  git(clone, 'commit', '-m', message)
  git(clone, 'push', 'origin', 'main')
}
```

- [ ] **Step 2: write the failing GitExecutor tests**

`tests/integration/git-executor.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GitExecutor } from '../../src/exec/git-executor'
import { GitOpError, type ProgressEvent } from '../../src/types'
import { cleanup, makeBareRemote, tempDir } from '../helpers/fixtures'

let root: string
beforeEach(() => { root = tempDir() })
afterEach(() => { cleanup(root) })

describe('GitExecutor', () => {
  test('version parses the version number', async () => {
    const v = await new GitExecutor({}).version()
    expect(v.major).toBeGreaterThanOrEqual(2)
    expect(typeof v.raw).toBe('string')
  })

  test('run returns trimmed stdout', async () => {
    const bare = makeBareRemote(root)
    const out = await new GitExecutor({}).run(['ls-remote', '--heads', bare])
    expect(out).toContain('refs/heads/main')
    expect(out).toBe(out.trim())
  })

  test('a failure throws GitOpError with the mapped code', async () => {
    const exec = new GitExecutor({})
    try {
      await exec.run(['status'], { cwd: root })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(GitOpError)
      expect((e as GitOpError).code).toBe('NOT_A_REPO')
    }
  })

  test('neither the message nor command contains the token', async () => {
    const exec = new GitExecutor({})
    const token = 'ghp_supersecrettoken'
    try {
      await exec.run(['ls-remote', 'https://127.0.0.1:1/nope.git'], { token, timeout: 15_000 })
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as GitOpError
      const blob = `${err.message}\n${err.detail}\n${err.command ?? ''}`
      expect(blob).not.toContain(token)
    }
  })

  test('a timeout throws TIMEOUT', async () => {
    const exec = new GitExecutor({ timeout: 1 })
    try {
      // Cloning an unreachable address is certain to take more than 1ms
      await exec.run(['clone', 'https://127.0.0.1:1/nope.git', `${root}/x`])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('TIMEOUT')
    }
  })

  test('onProgress receives scrubbed events', async () => {
    const events: ProgressEvent[] = []
    const bare = makeBareRemote(root)
    const exec = new GitExecutor({ onProgress: (e) => events.push(e) })
    await exec.run(['clone', '--progress', bare, `${root}/c`], { phase: 'clone' })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.phase === 'clone')).toBe(true)
  })

  test('injects merge.conflictStyle=diff3', async () => {
    const bare = makeBareRemote(root)
    const exec = new GitExecutor({})
    await exec.run(['clone', bare, `${root}/c`])
    const out = await exec.run(['config', '--get', 'merge.conflictStyle'], { cwd: `${root}/c` })
      .catch(() => '')
    // The injection happens through -c rather than by writing config, so
    // config --get cannot see it; assert instead that it appears in the
    // arguments handed to git
    expect(out).toBe('')
    const args = exec.buildArgs(['status'], {})
    expect(args).toContain('merge.conflictStyle=diff3')
  })
})
```

- [ ] **Step 3: run the tests and confirm they fail**

Run: `bun test tests/integration/git-executor.test.ts`
Expected: FAIL - the module does not exist

- [ ] **Step 4: implement `src/exec/git-executor.ts`**

```ts
import { execFile } from 'node:child_process'
import { mapGitError } from '../domain/error-mapper'
import { GitOpError, type ProgressEvent } from '../types'
import { redact } from './sanitize'

export type ExecOptions = {
  cwd?: string
  token?: string
  timeout?: number
  phase?: ProgressEvent['phase']
}

export type GitVersion = { major: number; minor: number; patch: number; raw: string }

const DEFAULT_TIMEOUT = 120_000

/**
 * The only place that spawns git. child_process appearing in any other file is
 * an implementation error.
 *
 * Credentials are injected per invocation through `-c http.extraheader` and
 * never written into the URL, which would leak them into .git/config and the
 * reflog.
 */
export class GitExecutor {
  readonly #gitPath: string
  readonly #timeout: number
  readonly #onProgress?: (e: ProgressEvent) => void

  constructor(opts: {
    gitPath?: string
    timeout?: number
    onProgress?: (e: ProgressEvent) => void
  }) {
    this.#gitPath = opts.gitPath ?? 'git'
    this.#timeout = opts.timeout ?? DEFAULT_TIMEOUT
    this.#onProgress = opts.onProgress
  }

  /** Exposed only for testability: builds the full argument list handed to git. */
  buildArgs(args: readonly string[], opts: ExecOptions): string[] {
    const pre = ['-c', 'merge.conflictStyle=diff3', '-c', 'core.quotepath=false']
    if (opts.token) {
      const basic = Buffer.from(`x-access-token:${opts.token}`).toString('base64')
      pre.push('-c', `http.extraheader=AUTHORIZATION: basic ${basic}`)
    }
    return [...pre, ...args]
  }

  async run(args: readonly string[], opts: ExecOptions = {}): Promise<string> {
    const full = this.buildArgs(args, opts)
    const secrets = opts.token ? [opts.token] : []
    const printable = redact([this.#gitPath, ...full].join(' '), secrets)

    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.#gitPath,
        full,
        {
          cwd: opts.cwd,
          timeout: opts.timeout ?? this.#timeout,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          const safeErr = redact(String(stderr ?? ''), secrets)
          if (!error) {
            resolve(String(stdout).trim())
            return
          }
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
          const enoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
          const code = enoent
            ? 'GIT_NOT_FOUND'
            : killed
              ? 'TIMEOUT'
              : mapGitError(safeErr)
          reject(
            new GitOpError(code, redact(error.message, secrets), {
              detail: safeErr,
              command: printable,
              cause: error,
            }),
          )
        },
      )

      if (this.#onProgress && child.stderr) {
        let buf = ''
        child.stderr.on('data', (chunk: Buffer | string) => {
          buf += String(chunk)
          const lines = buf.split(/\r?\n|\r/)
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const pct = /(\d{1,3})%/.exec(line)
            this.#onProgress!({
              phase: opts.phase ?? 'fetch',
              message: redact(line, secrets),
              percent: pct ? Number(pct[1]) : undefined,
            })
          }
        })
      }
    })
  }

  async version(): Promise<GitVersion> {
    const raw = await this.run(['--version'])
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw)
    if (!m) {
      throw new GitOpError('UNKNOWN', `cannot parse the git version: ${raw}`, { detail: raw })
    }
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3] ?? 0),
      raw,
    }
  }
}
```

- [ ] **Step 5: run the tests and confirm they pass**

Run: `bun test tests/integration/git-executor.test.ts`
Expected: 7 tests PASS

- [ ] **Step 6: add a guard test so nothing else spawns git**

`tests/unit/architecture.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

describe('architectural constraints', () => {
  const files = walk('src')

  test('only git-executor.ts may import child_process or simple-git', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith('git-executor.ts') &&
        /from ['"]node:child_process['"]|from ['"]simple-git['"]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  test('nothing under domain/ may touch IO', () => {
    const offenders = files
      .filter((f) => f.includes('/domain/'))
      .filter((f) =>
        /from ['"]node:(fs|child_process|net|http|https)['"]/.test(readFileSync(f, 'utf8')),
      )
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 7: run the whole test suite**

Run: `bun test && bun run typecheck`
Expected: everything PASSES

- [ ] **Step 8: Commit**

```bash
git add src/exec/git-executor.ts tests/
git commit -m "feat: add git executor with auth injection, timeout and redaction"
```

---

### Task 8: RepoManager - preflight, layout, clone dedup

**Files:**
- Create: `src/api/repo-manager.ts`
- Modify: `src/index.ts`
- Test: `tests/integration/repo-manager.test.ts`

**Interfaces:**
- Consumes: `GitExecutor`（Task 7）、`StoreMutex`（Task 6）、`planLayout`（Task 3）
- Produces:
  - `type ManagerConfig = { root: string; auth?: { token: string }; gitPath?: string; timeout?: number; onProgress?: (e: ProgressEvent) => void }`
  - `type StoreConfig = { url: string; auth?: { token: string }; depth?: number; filter?: string | false }`
  - `class RepoManager { constructor(cfg: ManagerConfig); store(cfg: StoreConfig): Promise<RepoStore>; evict(url: string): Promise<boolean>; gc(opts): Promise<GcReport> }`

**This task delivers only as far as the store directory being cloned correctly.** `RepoStore`'s session support arrives in task 9; here only its constructor and `fetch` are implemented.

- [ ] **Step 1: write the failing tests**

`tests/integration/repo-manager.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import { GitOpError } from '../../src/types'
import { cleanup, makeBareRemote, tempDir } from '../helpers/fixtures'

let root: string
let bare: string
let repos: string

beforeEach(() => {
  root = tempDir()
  bare = makeBareRemote(root)
  repos = join(root, 'repos')
})
afterEach(() => cleanup(root))

// A local path is not an http url, and planLayout accepts only http(s).
// The integration tests use a file:// url; letting the file protocol through
// the manager is covered in step 3.
const urlOf = (p: string) => `file://${p}`

describe('RepoManager', () => {
  test('the first store() call clones and lands in the expected layout', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(existsSync(join(store.storeDir, '.git'))).toBe(true)
    expect(existsSync(store.worktreeRoot)).toBe(true)
  })

  test('the store working tree is empty, thanks to --no-checkout', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    const entries = readdirSync(store.storeDir).filter((e) => e !== '.git')
    expect(entries).toEqual([])
  })

  test('the store sets extensions.worktreeConfig', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('extensions.worktreeConfig')).toBe('true')
  })

  test('the store keeps the remote.origin.fetch refspec, proving --bare was not used', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('remote.origin.fetch'))
      .toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  test('a second call reuses the same store instance instead of cloning again', async () => {
    const m = new RepoManager({ root: repos })
    const a = await m.store({ url: urlOf(bare) })
    const b = await m.store({ url: urlOf(bare) })
    expect(b).toBe(a)
  })

  test('concurrent first calls clone exactly once', async () => {
    const m = new RepoManager({ root: repos })
    const [a, b, c] = await Promise.all([
      m.store({ url: urlOf(bare) }),
      m.store({ url: urlOf(bare) }),
      m.store({ url: urlOf(bare) }),
    ])
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test('an existing store directory is reused rather than re-cloned', async () => {
    const m1 = new RepoManager({ root: repos })
    const s1 = await m1.store({ url: urlOf(bare) })
    const m2 = new RepoManager({ root: repos })
    const s2 = await m2.store({ url: urlOf(bare) })
    expect(s2.storeDir).toBe(s1.storeDir)
    expect(existsSync(join(s2.storeDir, '.git'))).toBe(true)
  })

  test('preflight throws GIT_VERSION_TOO_OLD when git is too old', async () => {
    const m = new RepoManager({ root: repos, gitPath: 'git' })
    // Uses a fake version injection point - see the optional minGitVersion parameter in the implementation
    const low = new RepoManager({ root: repos, minGitVersion: { major: 99, minor: 0, patch: 0 } })
    await expect(low.store({ url: urlOf(bare) })).rejects.toThrow(GitOpError)
    void m
  })

  test('a gitPath pointing at a missing executable throws GIT_NOT_FOUND', async () => {
    const m = new RepoManager({ root: repos, gitPath: '/nonexistent/git' })
    try {
      await m.store({ url: urlOf(bare) })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('GIT_NOT_FOUND')
    }
  })

  test('evict removes the store directory', async () => {
    const m = new RepoManager({ root: repos })
    const s = await m.store({ url: urlOf(bare) })
    expect(await m.evict(urlOf(bare))).toBe(true)
    expect(existsSync(s.storeDir)).toBe(false)
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/integration/repo-manager.test.ts`
Expected: FAIL - the module does not exist

- [ ] **Step 3: relax `planLayout` to accept `file://`, for tests only**

Change the protocol validation in `src/domain/layout-planner.ts` and add one case to `tests/unit/layout-planner.test.ts`:

```ts
// Replace the protocol check in layout-planner.ts
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'file:'])
if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
  throw new GitOpError('INVALID_ARGUMENT', `only http(s) and file URLs are supported, got: ${parsed.protocol}`)
}
```

For a `file:` URL the `hostname` is empty, so the fixed string `local` is used as the host segment:

```ts
const rawHost = parsed.hostname || (parsed.protocol === 'file:' ? 'local' : '')
if (!rawHost) throw new GitOpError('INVALID_ARGUMENT', `URL has no host: ${url}`)
const host = parsed.port ? `${rawHost.toLowerCase()}_${parsed.port}` : rawHost.toLowerCase()
```

A `file://` pathname often has a single segment, `/tmp/xxx/remote.git` for instance, so the "at least two segments" rule is relaxed to apply **only to http(s)**:

```ts
if (parsed.protocol !== 'file:' && segments.length < 2) {
  throw new GitOpError('INVALID_ARGUMENT', `URL has no owner/repo: ${url}`)
}
if (segments.length === 0) {
  throw new GitOpError('INVALID_ARGUMENT', `URL has no path: ${url}`)
}
```

A new unit test:

```ts
test('file:// urls, used by the local tests', () => {
  const l = planLayout('/r', 'file:///tmp/x/remote.git')
  expect(l.key).toBe('local/tmp/x/remote')
})
```

- [ ] **Step 4: implement `src/api/repo-manager.ts`**

```ts
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { planLayout } from '../domain/layout-planner'
import { GitExecutor } from '../exec/git-executor'
import { StoreMutex } from '../exec/store-mutex'
import { GitOpError, type ProgressEvent } from '../types'
import { RepoStore } from './repo-store'

export type ManagerConfig = {
  root: string
  auth?: { token: string }
  gitPath?: string
  timeout?: number
  onProgress?: (e: ProgressEvent) => void
  /** For tests to override; never pass this in production. */
  minGitVersion?: { major: number; minor: number; patch: number }
}

export type StoreConfig = {
  url: string
  auth?: { token: string }
  depth?: number
  /** Partial clone filter, 'blob:none' by default; pass false to disable. */
  filter?: string | false
}

export type GcReport = {
  removed: string[]
  skippedActive: string[]
}

const MIN_GIT = { major: 2, minor: 32, patch: 0 }

export class RepoManager {
  readonly #cfg: ManagerConfig
  readonly #exec: GitExecutor
  readonly #mutex = new StoreMutex()
  readonly #stores = new Map<string, Promise<RepoStore>>()
  #preflight?: Promise<void>

  constructor(cfg: ManagerConfig) {
    this.#cfg = cfg
    this.#exec = new GitExecutor({
      gitPath: cfg.gitPath,
      timeout: cfg.timeout,
      onProgress: cfg.onProgress,
    })
  }

  async #ensurePreflight(): Promise<void> {
    this.#preflight ??= (async () => {
      const v = await this.#exec.version()
      const min = this.#cfg.minGitVersion ?? MIN_GIT
      const ok =
        v.major > min.major ||
        (v.major === min.major && v.minor >= min.minor)
      if (!ok) {
        throw new GitOpError(
          'GIT_VERSION_TOO_OLD',
          `git >= ${min.major}.${min.minor} is required, found ${v.raw}`,
          { detail: v.raw },
        )
      }
    })()
    try {
      await this.#preflight
    } catch (e) {
      this.#preflight = undefined  // Allow a retry next time
      throw e
    }
  }

  async store(cfg: StoreConfig): Promise<RepoStore> {
    await this.#ensurePreflight()
    const layout = planLayout(this.#cfg.root, cfg.url)

    const existing = this.#stores.get(layout.key)
    if (existing) return existing

    const created = this.#mutex
      .run(layout.key, async () => {
        await mkdir(layout.worktreeRoot, { recursive: true })
        const token = cfg.auth?.token ?? this.#cfg.auth?.token

        if (!existsSync(join(layout.storeDir, '.git'))) {
          const args = ['clone', '--no-checkout']
          if (cfg.filter !== false) args.push(`--filter=${cfg.filter ?? 'blob:none'}`)
          if (cfg.depth) args.push('--depth', String(cfg.depth))
          args.push(cfg.url, layout.storeDir)
          await this.#exec.run(args, { token, phase: 'clone' })
          await this.#exec.run(['config', 'extensions.worktreeConfig', 'true'], {
            cwd: layout.storeDir,
          })
        }

        const store = new RepoStore({
          layout,
          exec: this.#exec,
          mutex: this.#mutex,
          token,
          url: cfg.url,
        })
        await store.pruneOrphans()
        return store
      })
      .catch((e) => {
        this.#stores.delete(layout.key)
        throw e
      })

    this.#stores.set(layout.key, created)
    return created
  }

  async evict(url: string): Promise<boolean> {
    const layout = planLayout(this.#cfg.root, url)
    const pending = this.#stores.get(layout.key)
    if (pending) {
      const store = await pending.catch(() => undefined)
      if (store && store.activeSessions > 0) return false
      this.#stores.delete(layout.key)
    }
    if (!existsSync(layout.repoDir)) return false
    await rm(layout.repoDir, { recursive: true, force: true })
    return true
  }

  async gc(opts: { maxAgeDays?: number; maxTotalBytes?: number } = {}): Promise<GcReport> {
    const report: GcReport = { removed: [], skippedActive: [] }
    for (const [key, pending] of [...this.#stores]) {
      const store = await pending.catch(() => undefined)
      if (!store) continue
      if (store.activeSessions > 0) {
        report.skippedActive.push(key)
        continue
      }
      if (opts.maxAgeDays !== undefined && store.idleMs < opts.maxAgeDays * 86_400_000) continue
      this.#stores.delete(key)
      await rm(store.repoDir, { recursive: true, force: true })
      report.removed.push(key)
    }
    return report
  }
}
```

- [ ] **Step 5: implement a minimal `src/api/repo-store.ts`**

This step implements the constructor, `configGet`, `fetch`, `pruneOrphans` and the counters only; session support follows in task 9.

```ts
import { readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Layout } from '../domain/layout-planner'
import type { GitExecutor } from '../exec/git-executor'
import type { StoreMutex } from '../exec/store-mutex'

export type RepoStoreDeps = {
  layout: Layout
  exec: GitExecutor
  mutex: StoreMutex
  token?: string
  url: string
}

export class RepoStore {
  readonly #d: RepoStoreDeps
  #active = 0
  #lastUsed = 0

  constructor(deps: RepoStoreDeps) {
    this.#d = deps
    this.#lastUsed = performance.timeOrigin + performance.now()
  }

  get repoDir(): string { return this.#d.layout.repoDir }
  get storeDir(): string { return this.#d.layout.storeDir }
  get worktreeRoot(): string { return this.#d.layout.worktreeRoot }
  get key(): string { return this.#d.layout.key }
  get url(): string { return this.#d.url }
  get activeSessions(): number { return this.#active }
  get idleMs(): number {
    return performance.timeOrigin + performance.now() - this.#lastUsed
  }

  /** For RepoManager and the session lifecycle only. */
  _retain(): void { this.#active += 1; this.#touch() }
  _release(): void { this.#active = Math.max(0, this.#active - 1); this.#touch() }
  #touch(): void { this.#lastUsed = performance.timeOrigin + performance.now() }

  async configGet(name: string): Promise<string> {
    return this.#d.exec.run(['config', '--get', name], { cwd: this.storeDir })
  }

  /** Store level: writes refs and objects, so it has to be serialized. */
  async fetch(refspec?: string): Promise<void> {
    this.#touch()
    await this.#d.mutex.run(this.key, () =>
      this.#d.exec.run(
        refspec ? ['fetch', 'origin', refspec] : ['fetch', '--prune', 'origin'],
        { cwd: this.storeDir, token: this.#d.token, phase: 'fetch' },
      ),
    )
  }

  /** Startup cleanup: reclaim orphaned worktrees left behind by a killed process. */
  async pruneOrphans(): Promise<string[]> {
    return this.#d.mutex.run(this.key, async () => {
      await this.#d.exec.run(['worktree', 'prune'], { cwd: this.storeDir })
      if (!existsSync(this.worktreeRoot)) return []
      const registered = new Set(await this.#listRegisteredWorktrees())
      const removed: string[] = []
      for (const entry of await readdir(this.worktreeRoot)) {
        const dir = `${this.worktreeRoot}/${entry}`
        if (registered.has(dir)) continue
        await rm(dir, { recursive: true, force: true })
        removed.push(dir)
      }
      return removed
    })
  }

  async #listRegisteredWorktrees(): Promise<string[]> {
    const out = await this.#d.exec.run(['worktree', 'list', '--porcelain'], {
      cwd: this.storeDir,
    })
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((p) => p !== this.storeDir)
  }
}
```

- [ ] **Step 6: update `src/index.ts`**

```ts
export * from './types'
export { RepoManager } from './api/repo-manager'
export type { ManagerConfig, StoreConfig, GcReport } from './api/repo-manager'
export { RepoStore } from './api/repo-store'
```

- [ ] **Step 7: run the tests**

Run: `bun test && bun run typecheck`
Expected: everything PASSES - 10 repo-manager tests plus the existing ones

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat: add repo manager with preflight, layout and clone dedup"
```

---

### Task 9: worktree sessions - the correct sparse creation order

**Files:**
- Modify: `src/api/repo-store.ts`
- Create: `src/api/git-repo.ts`
- Modify: `src/index.ts`
- Test: `tests/integration/session.test.ts`

**Interfaces:**
- Consumes: `RepoStore`（Task 8）、`normalizeSparsePaths`（Task 4）、`GitExecutor`（Task 7）
- Produces:
  - `type SessionConfig = { branch: string; branchMode?: 'create' | 'reuse' | 'createOrReuse'; base?: string; sparsePaths?: (string | SparsePath)[]; author: { name: string; email: string }; retryOnReject?: boolean }`
  - `RepoStore#createSession(cfg: SessionConfig): Promise<GitRepo>`
  - `RepoStore#attachSession(worktreeDir: string): Promise<GitRepo>`
  - `RepoStore#listSessions(): Promise<SessionInfo[]>`
  - `class GitRepo { readonly dir: string; readonly branch: string; dispose(): Promise<void>; status(): Promise<StatusResult> }`

**The critical part: the worktree creation order has to be `add --no-checkout`, `sparse-checkout init --cone`, `sparse-checkout set`, `checkout`.** Getting it wrong triggers a full blob fetch under a partial clone, and "download only the named directories" stops working entirely.

- [ ] **Step 1: write the failing tests**

`tests/integration/session.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import { GitOpError } from '../../src/types'
import { cleanup, makeBareRemote, tempDir } from '../helpers/fixtures'

let root: string, bare: string, store: RepoStore

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  const m = new RepoManager({ root: join(root, 'repos') })
  store = await m.store({ url: `file://${bare}` })
})
afterEach(() => cleanup(root))

const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

describe('session lifecycle', () => {
  test('in sparse mode only the named directories reach disk', async () => {
    const repo = await store.createSession({
      branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR,
    })
    expect(existsSync(join(repo.dir, 'docs', 'a.md'))).toBe(true)
    expect(existsSync(join(repo.dir, 'src'))).toBe(false)
    await repo.dispose()
  })

  test('in full mode every directory reaches disk', async () => {
    const repo = await store.createSession({ branch: 'feat/full', author: AUTHOR })
    expect(existsSync(join(repo.dir, 'src', 'index.ts'))).toBe(true)
    await repo.dispose()
  })

  test('two sessions sparse configurations do not contaminate each other', async () => {
    const a = await store.createSession({ branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR })
    const b = await store.createSession({ branch: 'feat/b', sparsePaths: ['src'], author: AUTHOR })
    expect(existsSync(join(a.dir, 'docs'))).toBe(true)
    expect(existsSync(join(a.dir, 'src'))).toBe(false)
    expect(existsSync(join(b.dir, 'src'))).toBe(true)
    expect(existsSync(join(b.dir, 'docs'))).toBe(false)
    await a.dispose(); await b.dispose()
  })

  test('creating a worktree does not fetch every blob', async () => {
    // Under a partial clone, an unfetched blob counts as promisor-missing.
    // Assert that once the sparse session exists, the blobs under src/ are
    // still not fetched.
    const repo = await store.createSession({
      branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR,
    })
    const missing = execFileSync(
      'git',
      ['rev-list', '--objects', '--missing=print', 'HEAD'],
      { cwd: store.storeDir, encoding: 'utf8' },
    )
    // At minimum the blobs for src/index.ts and README.md should still be missing, marked with a leading ?
    expect(missing.split('\n').filter((l) => l.startsWith('?')).length).toBeGreaterThan(0)
    await repo.dispose()
  })

  test('checking one branch out in two sessions gives BRANCH_IN_USE', async () => {
    const a = await store.createSession({ branch: 'feat/dup', author: AUTHOR })
    try {
      await store.createSession({ branch: 'feat/dup', author: AUTHOR })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('BRANCH_IN_USE')
    } finally {
      await a.dispose()
    }
  })

  test("branchMode: 'create' on an existing branch gives BRANCH_EXISTS", async () => {
    const a = await store.createSession({ branch: 'feat/x', author: AUTHOR })
    await a.dispose()
    try {
      await store.createSession({ branch: 'feat/x', branchMode: 'create', author: AUTHOR })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('BRANCH_EXISTS')
    }
  })

  test("branchMode: 'reuse' on a missing branch gives BRANCH_NOT_FOUND", async () => {
    try {
      await store.createSession({ branch: 'feat/nope', branchMode: 'reuse', author: AUTHOR })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('BRANCH_NOT_FOUND')
    }
  })

  test("branchMode defaults to createOrReuse: create when missing, reuse when present", async () => {
    const a = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    await a.dispose()
    const b = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    expect(b.branch).toBe('feat/r')
    await b.dispose()
  })

  test('dispose removes the directory and is idempotent', async () => {
    const repo = await store.createSession({ branch: 'feat/d', author: AUTHOR })
    const dir = repo.dir
    await repo.dispose()
    await repo.dispose()
    expect(existsSync(dir)).toBe(false)
  })

  test('calling a method after dispose throws WORKTREE_DISPOSED', async () => {
    const repo = await store.createSession({ branch: 'feat/d2', author: AUTHOR })
    await repo.dispose()
    try {
      await repo.status()
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('WORKTREE_DISPOSED')
    }
  })

  test('activeSessions rises and falls with creation and release', async () => {
    expect(store.activeSessions).toBe(0)
    const a = await store.createSession({ branch: 'feat/c1', author: AUTHOR })
    expect(store.activeSessions).toBe(1)
    await a.dispose()
    expect(store.activeSessions).toBe(0)
  })

  test('listSessions reports the live worktrees and their state', async () => {
    const a = await store.createSession({ branch: 'feat/l', author: AUTHOR })
    const list = await store.listSessions()
    expect(list.map((s) => s.dir)).toContain(a.dir)
    expect(list.find((s) => s.dir === a.dir)!.state).toBe('clean')
    await a.dispose()
  })

  test('ten sessions created concurrently all succeed without interfering', async () => {
    const repos = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.createSession({ branch: `feat/p${i}`, sparsePaths: ['docs'], author: AUTHOR }),
      ),
    )
    expect(new Set(repos.map((r) => r.dir)).size).toBe(10)
    for (const r of repos) expect(existsSync(join(r.dir, 'docs', 'a.md'))).toBe(true)
    await Promise.all(repos.map((r) => r.dispose()))
    expect(store.activeSessions).toBe(0)
  })

  test('attachSession can take an existing worktree back over', async () => {
    const a = await store.createSession({ branch: 'feat/at', author: AUTHOR })
    const dir = a.dir
    const b = await store.attachSession(dir)
    expect(b.dir).toBe(dir)
    expect(b.branch).toBe('feat/at')
    await b.dispose()
  })

  test('pruneOrphans reclaims orphaned directories', async () => {
    const orphan = join(store.worktreeRoot, 'orphan-xyz')
    execFileSync('mkdir', ['-p', join(orphan, 'sub')])
    const removed = await store.pruneOrphans()
    expect(removed).toContain(orphan)
    expect(existsSync(orphan)).toBe(false)
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/integration/session.test.ts`
Expected: FAIL - `createSession` does not exist

- [ ] **Step 3: implement `src/api/git-repo.ts`**

```ts
import { GitOpError, type SparsePath } from '../types'
import type { GitExecutor } from '../exec/git-executor'

export type StatusResult = {
  branch: string
  staged: string[]
  modified: string[]
  untracked: string[]
  conflicted: string[]
  clean: boolean
}

export type GitRepoDeps = {
  dir: string
  branch: string
  sparse: SparsePath[]
  author: { name: string; email: string }
  exec: GitExecutor
  token?: string
  onDispose: () => Promise<void>
}

export class GitRepo {
  readonly #d: GitRepoDeps
  #disposed = false

  constructor(deps: GitRepoDeps) {
    this.#d = deps
  }

  get dir(): string { return this.#d.dir }
  get branch(): string { return this.#d.branch }
  get sparsePaths(): readonly SparsePath[] { return this.#d.sparse }

  /** For GitRepo itself and the other api classes in this package. */
  _assertLive(): void {
    if (this.#disposed) {
      throw new GitOpError('WORKTREE_DISPOSED', `session already released: ${this.#d.dir}`)
    }
  }

  async _git(args: string[]): Promise<string> {
    this._assertLive()
    return this.#d.exec.run(args, { cwd: this.#d.dir, token: this.#d.token })
  }

  async status(): Promise<StatusResult> {
    const out = await this._git(['status', '--porcelain=v1', '-z', '--branch'])
    const parts = out.split('\0').filter(Boolean)
    const staged: string[] = []
    const modified: string[] = []
    const untracked: string[] = []
    const conflicted: string[] = []
    for (const entry of parts) {
      if (entry.startsWith('##')) continue
      const x = entry[0]!
      const y = entry[1]!
      const path = entry.slice(3)
      if (x === '?' && y === '?') untracked.push(path)
      else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
        conflicted.push(path)
      } else {
        if (x !== ' ') staged.push(path)
        if (y !== ' ') modified.push(path)
      }
    }
    return {
      branch: this.#d.branch,
      staged, modified, untracked, conflicted,
      clean: staged.length === 0 && modified.length === 0 &&
             untracked.length === 0 && conflicted.length === 0,
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#d.onDispose()
  }
}
```

- [ ] **Step 4: add session support to `src/api/repo-store.ts`**

Add the following members to the class, keeping what task 8 already put there:

```ts
// Additional imports at the top of the file
import { randomBytes } from 'node:crypto'
import { normalizeSparsePaths } from '../domain/sparse-manager'
import { worktreeDirFor } from '../domain/layout-planner'
import { GitOpError, type SparsePath } from '../types'
import { GitRepo } from './git-repo'

export type SessionConfig = {
  branch: string
  branchMode?: 'create' | 'reuse' | 'createOrReuse'
  base?: string
  sparsePaths?: (string | SparsePath)[]
  author: { name: string; email: string }
  retryOnReject?: boolean
}

export type SessionInfo = {
  dir: string
  branch: string
  state: 'clean' | 'conflicted' | 'merging'
}
```

New methods on the class:

```ts
  async #defaultBase(): Promise<string> {
    const head = await this.#d.exec
      .run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: this.storeDir })
      .catch(() => '')
    return head || 'origin/main'
  }

  async #branchExists(branch: string): Promise<boolean> {
    const local = await this.#d.exec
      .run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: this.storeDir })
      .catch(() => '')
    if (local) return true
    const remote = await this.#d.exec
      .run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
        cwd: this.storeDir,
      })
      .catch(() => '')
    return Boolean(remote)
  }

  async #checkedOutBranches(): Promise<Set<string>> {
    const out = await this.#d.exec.run(['worktree', 'list', '--porcelain'], {
      cwd: this.storeDir,
    })
    const set = new Set<string>()
    for (const line of out.split('\n')) {
      if (line.startsWith('branch ')) {
        set.add(line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''))
      }
    }
    return set
  }

  async createSession(cfg: SessionConfig): Promise<GitRepo> {
    const sparse = normalizeSparsePaths(cfg.sparsePaths)
    const mode = cfg.branchMode ?? 'createOrReuse'
    const sessionId = `s-${randomBytes(6).toString('hex')}`
    const dir = worktreeDirFor(this.worktreeRoot, sessionId)

    await this.fetch()

    const created = await this.#d.mutex.run(this.key, async () => {
      if ((await this.#checkedOutBranches()).has(cfg.branch)) {
        throw new GitOpError('BRANCH_IN_USE', `branch ${cfg.branch} is already checked out in another worktree`)
      }
      const exists = await this.#branchExists(cfg.branch)
      if (mode === 'create' && exists) {
        throw new GitOpError('BRANCH_EXISTS', `branch already exists: ${cfg.branch}`)
      }
      if (mode === 'reuse' && !exists) {
        throw new GitOpError('BRANCH_NOT_FOUND', `no such branch: ${cfg.branch}`)
      }

      // The order matters: create an empty worktree, configure sparse, and only
      // then check out. Checking out first would make the partial clone fetch
      // every blob from the promisor remote.
      const base = cfg.base ?? (await this.#defaultBase())
      const addArgs = ['worktree', 'add', '--no-checkout']
      if (exists) addArgs.push(dir, cfg.branch)
      else addArgs.push('-b', cfg.branch, dir, base)
      await this.#d.exec.run(addArgs, {
        cwd: this.storeDir, token: this.#d.token, phase: 'worktree',
      })
      return dir
    })

    try {
      if (sparse.length > 0) {
        await this.#d.exec.run(['sparse-checkout', 'init', '--cone'], { cwd: created })
        await this.#d.exec.run(
          ['sparse-checkout', 'set', ...sparse.map((s) => s.path)],
          { cwd: created },
        )
      }
      await this.#d.exec.run(['checkout'], {
        cwd: created, token: this.#d.token, phase: 'checkout',
      })
      await this.#d.exec.run(['config', 'user.name', cfg.author.name], { cwd: created })
      await this.#d.exec.run(['config', 'user.email', cfg.author.email], { cwd: created })
    } catch (e) {
      await this.#removeWorktree(created).catch(() => undefined)
      throw e
    }

    this._retain()
    return new GitRepo({
      dir: created,
      branch: cfg.branch,
      sparse,
      author: cfg.author,
      exec: this.#d.exec,
      token: this.#d.token,
      onDispose: async () => {
        await this.#removeWorktree(created)
        this._release()
      },
    })
  }

  async attachSession(worktreeDir: string): Promise<GitRepo> {
    const branch = (
      await this.#d.exec.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreeDir })
    ).trim()
    const raw = await this.#d.exec
      .run(['sparse-checkout', 'list'], { cwd: worktreeDir })
      .catch(() => '')
    const sparse = normalizeSparsePaths(raw.split('\n').map((s) => s.trim()).filter(Boolean))
    const name = await this.#d.exec.run(['config', '--get', 'user.name'], { cwd: worktreeDir })
    const email = await this.#d.exec.run(['config', '--get', 'user.email'], { cwd: worktreeDir })

    this._retain()
    return new GitRepo({
      dir: worktreeDir,
      branch,
      sparse,
      author: { name, email },
      exec: this.#d.exec,
      token: this.#d.token,
      onDispose: async () => {
        await this.#removeWorktree(worktreeDir)
        this._release()
      },
    })
  }

  async listSessions(): Promise<SessionInfo[]> {
    const dirs = await this.#listRegisteredWorktrees()
    const infos: SessionInfo[] = []
    for (const dir of dirs) {
      const branch = await this.#d.exec
        .run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
        .catch(() => 'HEAD')
      const unmerged = await this.#d.exec
        .run(['ls-files', '-u'], { cwd: dir })
        .catch(() => '')
      const mergeHeadPath = await this.#d.exec
        .run(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: dir })
        .catch(() => '')
      const merging = Boolean(mergeHeadPath) && existsSync(
        mergeHeadPath.startsWith('/') ? mergeHeadPath : `${dir}/${mergeHeadPath}`,
      )
      infos.push({
        dir,
        branch,
        state: unmerged ? 'conflicted' : merging ? 'merging' : 'clean',
      })
    }
    return infos
  }

  async #removeWorktree(dir: string): Promise<void> {
    await this.#d.mutex.run(this.key, async () => {
      await this.#d.exec
        .run(['worktree', 'remove', '--force', dir], { cwd: this.storeDir })
        .catch(async () => {
          await rm(dir, { recursive: true, force: true })
          await this.#d.exec.run(['worktree', 'prune'], { cwd: this.storeDir })
        })
    })
  }
```

- [ ] **Step 5: update `src/index.ts`**

```ts
export * from './types'
export { RepoManager } from './api/repo-manager'
export type { ManagerConfig, StoreConfig, GcReport } from './api/repo-manager'
export { RepoStore } from './api/repo-store'
export type { SessionConfig, SessionInfo } from './api/repo-store'
export { GitRepo } from './api/git-repo'
export type { StatusResult } from './api/git-repo'
```

- [ ] **Step 6: run the tests**

Run: `bun test tests/integration/session.test.ts`
Expected: 15 tests PASS

- [ ] **Step 7: run the whole suite and the typecheck**

Run: `bun test && bun run typecheck`
Expected: everything PASSES

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat: create sparse worktree sessions with correct checkout order"
```

---

### Task 10: FsGateway - constrained file reads and writes

**Files:**
- Create: `src/exec/fs-gateway.ts`
- Modify: `src/api/git-repo.ts`
- Test: `tests/integration/fs-gateway.test.ts`

**Interfaces:**
- Consumes: `resolveWithin`（Task 5）、`GitRepo`（Task 9）
- Produces:
  - `class FsGateway { constructor(dir: string, sparse: readonly SparsePath[]); readFile(rel): Promise<string>; writeFile(rel, content): Promise<void>; listFiles(rel?): Promise<string[]>; exists(rel): Promise<boolean> }`
  - `GitRepo#readFile / writeFile / listFiles / exists`

- [ ] **Step 1: write the failing tests**

`tests/integration/fs-gateway.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { symlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { GitRepo } from '../../src/api/git-repo'
import { GitOpError } from '../../src/types'
import { cleanup, makeBareRemote, tempDir } from '../helpers/fixtures'

let root: string, repo: GitRepo
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  const bare = makeBareRemote(root)
  const m = new RepoManager({ root: join(root, 'repos') })
  const store = await m.store({ url: `file://${bare}` })
  repo = await store.createSession({ branch: 'feat/fs', sparsePaths: ['docs'], author: AUTHOR })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'NO_THROW', (e: GitOpError) => e.code)
}

describe('FsGateway through GitRepo', () => {
  test('reads a file inside the sparse range', async () => {
    expect(await repo.readFile('docs/a.md')).toBe('# a\n')
  })

  test('writes and reads back', async () => {
    await repo.writeFile('docs/new.md', 'hello')
    expect(await repo.readFile('docs/new.md')).toBe('hello')
  })

  test('creates intermediate directories on write', async () => {
    await repo.writeFile('docs/deep/nested/x.md', 'x')
    expect(await repo.readFile('docs/deep/nested/x.md')).toBe('x')
  })

  test('reading a file outside the sparse range gives PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.readFile('src/index.ts'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('writing outside the sparse range gives PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.writeFile('src/x.ts', 'x'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('a traversal path gives PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.writeFile('../escape.md', 'x'))).toBe('PATH_TRAVERSAL')
  })

  test('writing under .git gives PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.writeFile('.git/hooks/evil', 'x'))).toBe('PATH_TRAVERSAL')
  })

  test('escaping through a symlink gives PATH_TRAVERSAL', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(repo.dir, 'docs', 'link'))
    expect(await codeOf(repo.readFile('docs/link/secret.txt'))).toBe('PATH_TRAVERSAL')
  })

  test('listFiles lists only files inside the sparse range, and never .git', async () => {
    const files = await repo.listFiles()
    expect(files).toContain('docs/a.md')
    expect(files).toContain('docs/api/b.md')
    expect(files.some((f) => f.startsWith('.git'))).toBe(false)
    expect(files.some((f) => f.startsWith('src/'))).toBe(false)
  })

  test('listFiles can be limited to a subdirectory', async () => {
    expect(await repo.listFiles('docs/api')).toEqual(['docs/api/b.md'])
  })

  test('exists returns true or false as appropriate', async () => {
    expect(await repo.exists('docs/a.md')).toBe(true)
    expect(await repo.exists('docs/nope.md')).toBe(false)
  })

  test('file operations after dispose throw WORKTREE_DISPOSED', async () => {
    await repo.dispose()
    expect(await codeOf(repo.readFile('docs/a.md'))).toBe('WORKTREE_DISPOSED')
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/integration/fs-gateway.test.ts`
Expected: FAIL - `repo.readFile` does not exist

- [ ] **Step 3: implement `src/exec/fs-gateway.ts`**

```ts
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { resolveWithin } from '../domain/path-guard'
import { GitOpError, type SparsePath } from '../types'

/**
 * File access constrained by PathGuard.
 *
 * PathGuard is a pure function and cannot resolve symlinks, so this class
 * re-checks with realpath that the target is still inside the worktree,
 * closing the "escape through a symlink" route.
 */
export class FsGateway {
  constructor(
    private readonly dir: string,
    private readonly sparse: readonly SparsePath[],
  ) {}

  async #safeAbs(rel: string, mustExist: boolean): Promise<string> {
    const abs = resolveWithin(this.dir, rel, this.sparse)
    const probe = mustExist ? abs : dirname(abs)
    let real: string
    try {
      real = await realpath(probe)
    } catch (e) {
      if (mustExist) throw e
      return abs  // The parent does not exist yet; mkdir creates it later, and PathGuard already validated the path
    }
    const rootReal = await realpath(this.dir)
    const rel2 = relative(rootReal, real)
    if (rel2.startsWith('..') || resolve(rootReal, rel2) !== real) {
      throw new GitOpError('PATH_TRAVERSAL', `path escapes the worktree through a symlink: ${rel}`)
    }
    return abs
  }

  async readFile(rel: string): Promise<string> {
    const abs = await this.#safeAbs(rel, true)
    return readFile(abs, 'utf8')
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const abs = await this.#safeAbs(rel, false)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }

  async exists(rel: string): Promise<boolean> {
    try {
      const abs = await this.#safeAbs(rel, true)
      await lstat(abs)
      return true
    } catch {
      return false
    }
  }

  /** Recursively list relative paths, skipping .git and anything outside the sparse range. */
  async listFiles(rel?: string): Promise<string[]> {
    const roots = rel
      ? [rel]
      : this.sparse.length > 0
        ? this.sparse.map((s) => s.path)
        : ['.']
    const out: string[] = []
    for (const r of roots) {
      const base = r === '.' ? this.dir : await this.#safeAbs(r, true).catch(() => '')
      if (!base) continue
      await this.#walk(base, r === '.' ? '' : r, out)
    }
    return out.sort()
  }

  async #walk(absDir: string, relDir: string, out: string[]): Promise<void> {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === '.git') continue
      const childRel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) await this.#walk(`${absDir}${sep}${e.name}`, childRel, out)
      else out.push(childRel)
    }
  }
}
```

- [ ] **Step 4: expose the file methods on `GitRepo`**

Append to `src/api/git-repo.ts`:

```ts
// Imports at the top
import { FsGateway } from '../exec/fs-gateway'

// New fields and methods on the class
  readonly #fs: FsGateway

  // Append at the end of the constructor:
  //   this.#fs = new FsGateway(deps.dir, deps.sparse)

  async readFile(rel: string): Promise<string> {
    this._assertLive()
    return this.#fs.readFile(rel)
  }

  async writeFile(rel: string, content: string): Promise<void> {
    this._assertLive()
    await this.#fs.writeFile(rel, content)
  }

  async listFiles(rel?: string): Promise<string[]> {
    this._assertLive()
    return this.#fs.listFiles(rel)
  }

  async exists(rel: string): Promise<boolean> {
    this._assertLive()
    return this.#fs.exists(rel)
  }
```

- [ ] **Step 5: run the tests**

Run: `bun test tests/integration/fs-gateway.test.ts && bun run typecheck`
Expected: 12 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/exec/fs-gateway.ts src/api/git-repo.ts tests/integration/fs-gateway.test.ts
git commit -m "feat: add sparse-scoped file gateway with symlink escape guard"
```

---

### Task 11: commit, a pull split into fetch plus merge, and a basic push

**Files:**
- Modify: `src/api/git-repo.ts`
- Modify: `src/api/repo-store.ts`
- Test: `tests/integration/basic-ops.test.ts`

**Interfaces:**
- Consumes: `GitRepo`（Task 9、10）、`RepoStore#fetch`（Task 8）
- Produces:
  - `GitRepo#commit(opts: { message: string; paths?: string[] }): Promise<{ sha: string; changed: boolean }>`
  - `GitRepo#pull(opts?: { strategy?: 'merge' | 'rebase'; ref?: string }): Promise<{ conflicted: boolean }>`
  - `GitRepo#pushBranch(): Promise<{ ok: true } | { ok: false; reason: 'rejected' | 'auth' | 'network'; detail: string }>`
  - `GitRepo#log(opts?: { limit?: number }): Promise<LogEntry[]>`
  - `GitRepo#diffSummary(opts?: { against?: string }): Promise<string[]>`
  - `RepoStore#listBranches(): Promise<string[]>` / `RepoStore#deleteBranch(name: string): Promise<void>`

**Note: `pull` has to be split into a store-level `fetch`, which takes the mutex, plus a worktree-level merge, which does not**, or it violates the "`GitRepo` never locks" constraint. The `pushBranch` in this task is the basic version **without retries**; retries and the conflict state machine arrive in plans 2 and 3.

- [ ] **Step 1: write the failing tests**

`tests/integration/basic-ops.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitRepo } from '../../src/api/git-repo'
import { cleanup, makeBareRemote, pushToRemote, tempDir } from '../helpers/fixtures'

let root: string, bare: string, store: RepoStore, repo: GitRepo
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  const m = new RepoManager({ root: join(root, 'repos') })
  store = await m.store({ url: `file://${bare}` })
  repo = await store.createSession({ branch: 'feat/ops', sparsePaths: ['docs'], author: AUTHOR })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

describe('basic operations', () => {
  test('commit produces a sha with the right author', async () => {
    await repo.writeFile('docs/new.md', 'hi')
    const r = await repo.commit({ message: 'add new doc' })
    expect(r.changed).toBe(true)
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/)
    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'],
      { cwd: repo.dir, encoding: 'utf8' }).trim()
    expect(author).toBe('Bot <bot@example.com>')
  })

  test('commit with nothing changed returns changed: false without failing', async () => {
    const r = await repo.commit({ message: 'nothing' })
    expect(r.changed).toBe(false)
  })

  test('commit with paths commits only those files', async () => {
    await repo.writeFile('docs/a1.md', '1')
    await repo.writeFile('docs/a2.md', '2')
    await repo.commit({ message: 'only a1', paths: ['docs/a1.md'] })
    const st = await repo.status()
    expect(st.untracked).toContain('docs/a2.md')
  })

  test('commit throws when its paths leave the sparse range', async () => {
    await repo.writeFile('docs/x.md', 'x')
    await expect(repo.commit({ message: 'm', paths: ['src/index.ts'] })).rejects.toThrow()
  })

  test('after a successful pushBranch the remote has the branch', async () => {
    await repo.writeFile('docs/p.md', 'p')
    await repo.commit({ message: 'push me' })
    const r = await repo.pushBranch()
    expect(r.ok).toBe(true)
    const refs = execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' })
    expect(refs).toContain('refs/heads/feat/ops')
  })

  test('pushing after someone else moved the remote branch returns rejected', async () => {
    await repo.writeFile('docs/p.md', 'v1')
    await repo.commit({ message: 'v1' })
    expect((await repo.pushBranch()).ok).toBe(true)

    // Simulate someone else pushing to the same branch again
    const other = join(root, 'other')
    execFileSync('git', ['clone', '-b', 'feat/ops', bare, other])
    execFileSync('bash', ['-c', `echo v2 > ${other}/docs/p.md`])
    execFileSync('git', ['-c', 'user.name=O', '-c', 'user.email=o@e.com',
      'commit', '-am', 'v2'], { cwd: other })
    execFileSync('git', ['push'], { cwd: other })

    await repo.writeFile('docs/p.md', 'v3')
    await repo.commit({ message: 'v3' })
    const r = await repo.pushBranch()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('rejected')
  })

  test('a pull without conflicts merges the remote changes in', async () => {
    pushToRemote(root, bare, { 'docs/ext.md': 'from other' })
    const r = await repo.pull({ ref: 'origin/main' })
    expect(r.conflicted).toBe(false)
    expect(await repo.readFile('docs/ext.md')).toBe('from other')
  })

  test('a conflicting pull returns conflicted: true rather than throwing', async () => {
    await repo.writeFile('docs/a.md', '# mine\n')
    await repo.commit({ message: 'mine' })
    pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' })
    const r = await repo.pull({ ref: 'origin/main' })
    expect(r.conflicted).toBe(true)
    expect((await repo.status()).conflicted).toContain('docs/a.md')
  })

  test('log returns the commit list', async () => {
    await repo.writeFile('docs/l.md', 'l')
    await repo.commit({ message: 'log entry' })
    const entries = await repo.log({ limit: 1 })
    expect(entries[0]!.message).toBe('log entry')
    expect(entries[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('diffSummary uses --name-only and returns the changed file names', async () => {
    await repo.writeFile('docs/d.md', 'd')
    await repo.commit({ message: 'd' })
    const files = await repo.diffSummary({ against: 'origin/main' })
    expect(files).toContain('docs/d.md')
  })

  test('listBranches lists local and remote branches', async () => {
    const branches = await store.listBranches()
    expect(branches).toContain('main')
  })

  test('deleteBranch removes a branch that is not checked out', async () => {
    const tmp = await store.createSession({ branch: 'feat/tmp', author: AUTHOR })
    await tmp.dispose()
    await store.deleteBranch('feat/tmp')
    expect(await store.listBranches()).not.toContain('feat/tmp')
  })
})
```

- [ ] **Step 2: run the tests and confirm they fail**

Run: `bun test tests/integration/basic-ops.test.ts`
Expected: FAIL - `repo.commit` does not exist

- [ ] **Step 3: implement the operations on `GitRepo`**

Append to `src/api/git-repo.ts`:

```ts
// Additional imports at the top of the file
import { resolveWithin } from '../domain/path-guard'

export type LogEntry = { sha: string; author: string; date: string; message: string }

// Append inside the GitRepo class:

  async commit(opts: { message: string; paths?: string[] }): Promise<{ sha: string; changed: boolean }> {
    this._assertLive()
    if (opts.paths) {
      // An out-of-range path has to be refused before git is touched
      for (const p of opts.paths) resolveWithin(this.#d.dir, p, this.#d.sparse)
      await this._git(['add', '--', ...opts.paths])
    } else {
      await this._git(['add', '-A'])
    }

    const staged = await this._git(['diff', '--cached', '--name-only'])
    const merging = await this.#isMerging()
    if (!staged && !merging) {
      const sha = await this._git(['rev-parse', 'HEAD'])
      return { sha, changed: false }
    }

    await this._git([
      '-c', `user.name=${this.#d.author.name}`,
      '-c', `user.email=${this.#d.author.email}`,
      'commit', '-m', opts.message,
    ])
    return { sha: await this._git(['rev-parse', 'HEAD']), changed: true }
  }

  async #isMerging(): Promise<boolean> {
    const p = await this._git(['rev-parse', '--git-path', 'MERGE_HEAD']).catch(() => '')
    if (!p) return false
    const abs = p.startsWith('/') ? p : `${this.#d.dir}/${p}`
    const { existsSync } = await import('node:fs')
    return existsSync(abs)
  }

  /**
   * pull is a store-level fetch, with the caller holding the lock, plus a
   * worktree-level merge, unlocked. Conflicts do not throw; they come back as
   * conflicted: true, with the details supplied by getConflicts in plan 2.
   */
  async pull(opts: { strategy?: 'merge' | 'rebase'; ref?: string } = {}): Promise<{ conflicted: boolean }> {
    this._assertLive()
    await this.#d.fetch()
    const ref = opts.ref ?? `origin/${this.#d.branch}`
    const args = opts.strategy === 'rebase'
      ? ['rebase', ref]
      : ['merge', '--no-edit', ref]
    try {
      await this._git(args)
      return { conflicted: false }
    } catch (e) {
      const unmerged = await this._git(['ls-files', '-u']).catch(() => '')
      if (unmerged) return { conflicted: true }
      throw e
    }
  }

  async pushBranch(): Promise<
    | { ok: true }
    | { ok: false; reason: 'rejected' | 'auth' | 'network'; detail: string }
  > {
    this._assertLive()
    try {
      await this.#d.exec.run(
        ['push', '--set-upstream', 'origin', `${this.#d.branch}:${this.#d.branch}`],
        { cwd: this.#d.dir, token: this.#d.token, phase: 'push' },
      )
      return { ok: true }
    } catch (e) {
      const err = e as GitOpError
      if (err.code === 'AUTH_FAILED') return { ok: false, reason: 'auth', detail: err.detail }
      if (err.code === 'NETWORK') return { ok: false, reason: 'network', detail: err.detail }
      if (/non-fast-forward|fetch first|rejected/i.test(err.detail)) {
        return { ok: false, reason: 'rejected', detail: err.detail }
      }
      throw e
    }
  }

  async log(opts: { limit?: number } = {}): Promise<LogEntry[]> {
    const out = await this._git([
      'log', `-${opts.limit ?? 20}`, '--format=%H%x1f%an%x1f%aI%x1f%s',
    ])
    if (!out) return []
    return out.split('\n').map((line) => {
      const [sha, author, date, message] = line.split('\x1f')
      return { sha: sha!, author: author!, date: date!, message: message! }
    })
  }

  /** --name-only only: under a partial clone, a diff that needs content triggers lazy blob fetching. */
  async diffSummary(opts: { against?: string } = {}): Promise<string[]> {
    const target = opts.against ?? 'HEAD~1'
    const out = await this._git(['diff', '--name-only', `${target}...HEAD`])
    return out ? out.split('\n').filter(Boolean) : []
  }
```

Also add `fetch: () => Promise<void>` to `GitRepoDeps`, and pass `fetch: () => this.fetch()` when `RepoStore#createSession` and `attachSession` construct a `GitRepo`.

- [ ] **Step 4: implement the branch methods on `RepoStore`**

```ts
  async listBranches(): Promise<string[]> {
    const out = await this.#d.exec.run(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
      { cwd: this.storeDir },
    )
    return [...new Set(
      out.split('\n').filter(Boolean).map((r) => r.replace(/^origin\//, '')),
    )].filter((b) => b !== 'HEAD')
  }

  async deleteBranch(name: string): Promise<void> {
    await this.#d.mutex.run(this.key, () =>
      this.#d.exec.run(['branch', '-D', name], { cwd: this.storeDir }),
    )
  }
```

- [ ] **Step 5: run the tests**

Run: `bun test tests/integration/basic-ops.test.ts`
Expected: 12 tests PASS

- [ ] **Step 6: run the whole suite, the typecheck and the build**

Run: `bun test && bun run typecheck && bun run build`
Expected: everything PASSES, and `dist/` holds `index.js`, `index.cjs` and `index.d.ts`

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat: add commit, pull, push and branch operations"
```

---

## Definition of done for plan 1

This plan is delivered once the following end-to-end scenario runs:

```ts
const manager = new RepoManager({ root: '/data/repos', auth: { token } })
const store = await manager.store({ url: 'https://github.com/acme/web' })
const repo = await store.createSession({
  branch: 'feat/docs-update',
  sparsePaths: [{ path: 'docs', requireChecks: false }],
  author: { name: 'Bot', email: 'bot@acme.io' },
})
await repo.writeFile('docs/a.md', '# updated\n')
await repo.commit({ message: 'docs: update a' })
const r = await repo.pushBranch()
await repo.dispose()
```

**Not yet implemented, delivered by later plans:** structured conflicts (plan 2), the automatic pull and retry after a rejected push (plan 2), `withSession` and `publish` (plan 2), GitHub pull requests and merge modes (plan 3), the CI matrix and release configuration (plan 3).
