# @aaxis/git-operation — 计划 1/3：核心（sparse worktree 与基础 git 操作）

> **状态：已被实现取代（2026-08-29）。**
> 本计划已全部实现，且实现过程中发现了若干本计划未覆盖的缺陷（rebase 状态、
> 共享 config 竞态、rebase 的 ours/theirs 反转等）。**代码与 spec 的附录 A 才是
> 当前事实**，本文保留仅供追溯当初的任务拆分。计划 2/3（冲突层、GitHub 层）未
> 单独成文，其范围已直接实现并测试。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可用的包骨架：能对一个 GitHub 仓库做 partial + sparse clone，为每个并发任务开一个独立 worktree，在其中读写文件、commit、push 分支，并安全释放。

**Architecture:** 三层单向依赖。Layer 1 (`exec/`) 是唯一 spawn git 的地方；Layer 2 (`domain/`) 全是不碰 IO 的纯函数；Layer 3 (`api/`) 是 `RepoManager` → `RepoStore` → `GitRepo` 三级门面。并发靠 git worktree 隔离，仅 `fetch` 与 `worktree add/remove` 走进程内 mutex。

**Tech Stack:** TypeScript 5.x · Bun（`bun test`）· tsup（ESM + CJS + d.ts）· simple-git · 系统 git ≥ 2.32

**Spec:** `docs/superpowers/specs/2026-08-29-git-operation-package-design.md`

## Global Constraints

这些约束适用于**每一个**任务，不再逐条重复：

- 包名 `@aaxis/git-operation`。运行时目标 **Node ≥ 18**；源码**不得使用任何 `Bun.*` API**（Bun 只用于跑测试和开发）。
- 系统 **git ≥ 2.32**。preflight 必须硬性拦截更低版本。
- **`src/exec/git-executor.ts` 是唯一 spawn/exec git 的地方。** 其他任何文件出现 `child_process`、`simple-git`、`spawn`、`exec` 均为实现错误。
- **`src/domain/` 下所有模块不得碰 IO**：不 import `node:fs`、`node:child_process`、不接受回调式 IO。输入输出只能是字符串与普通对象。
- **`GitRepo` 永不加锁。** 只有 `RepoStore` 可以使用 `StoreMutex`。
- **token 绝不写入 URL、日志、错误信息、`command` 字段。** 认证一律用 `-c http.extraheader=...` 单次注入。
- sparse-checkout **只支持 cone 模式**（目录前缀），不支持 glob。
- 所有 git 调用统一注入 `-c merge.conflictStyle=diff3`。
- 提交信息用英文，遵循 Conventional Commits（`feat:` / `fix:` / `test:` / `chore:`）。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src/types.ts` | 所有公开类型与 `GitOpError`、`GitErrorCode` |
| `src/exec/sanitize.ts` | 纯函数：从任意文本中抹除 secret |
| `src/exec/git-executor.ts` | 唯一 spawn git 处：认证注入、超时、progress、脱敏 |
| `src/exec/store-mutex.ts` | 按 key 分键的进程内串行队列 |
| `src/exec/fs-gateway.ts` | 受 `PathGuard` 约束的文件读写 |
| `src/domain/error-mapper.ts` | 纯函数：git stderr → `GitErrorCode` |
| `src/domain/layout-planner.ts` | 纯函数：`root` + url → store / worktree 路径 |
| `src/domain/path-guard.ts` | 纯函数：相对路径校验（穿越 + sparse 范围） |
| `src/domain/sparse-manager.ts` | 纯函数：`sparsePaths` 规范化与 cone 校验 |
| `src/api/repo-manager.ts` | store 生命周期、clone 去重、preflight、启动清理、gc |
| `src/api/repo-store.ts` | 共享对象库：fetch、branch、session 生命周期 |
| `src/api/git-repo.ts` | 绑定单个 worktree 的操作门面 |
| `src/index.ts` | 只 re-export 公开 API 与类型 |

---

### Task 1: 项目脚手架与 secret 脱敏

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`, `src/types.ts`
- Create: `src/exec/sanitize.ts`
- Test: `tests/unit/sanitize.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `class GitOpError extends Error { code: GitErrorCode; detail: string; command?: string; cause?: unknown }`
  - `type GitErrorCode`（见下方代码，本计划全程使用同一份定义）
  - `redact(text: string, secrets: readonly string[]): string`

- [ ] **Step 1: 初始化项目文件**

`package.json`：

```json
{
  "name": "@aaxis/git-operation",
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

- [ ] **Step 2: 写 `src/types.ts`**

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

- [ ] **Step 3: 写失败的脱敏测试**

`tests/unit/sanitize.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { redact } from '../../src/exec/sanitize'

describe('redact', () => {
  test('替换明文 secret', () => {
    expect(redact('token is ghp_abc123', ['ghp_abc123'])).toBe('token is ***')
  })

  test('替换 base64 编码后的 secret（http.extraheader 的形式）', () => {
    const token = 'ghp_abc123'
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64')
    const line = `git -c http.extraheader=AUTHORIZATION: basic ${encoded} fetch`
    const out = redact(line, [token])
    expect(out).not.toContain(encoded)
    expect(out).toContain('***')
  })

  test('多次出现全部替换', () => {
    expect(redact('a T b T c', ['T'])).toBe('a *** b *** c')
  })

  test('空 secret 被忽略，不产生全文替换', () => {
    expect(redact('hello', ['', '  '])).toBe('hello')
  })

  test('secret 含正则元字符时按字面量替换', () => {
    expect(redact('v=a.b*c', ['a.b*c'])).toBe('v=***')
  })

  test('无 secret 时原样返回', () => {
    expect(redact('nothing to hide', [])).toBe('nothing to hide')
  })
})
```

- [ ] **Step 4: 运行测试，确认失败**

Run: `bun test tests/unit/sanitize.test.ts`
Expected: FAIL —— `Cannot find module '../../src/exec/sanitize'`

- [ ] **Step 5: 实现 `src/exec/sanitize.ts`**

```ts
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从任意文本中抹除 secret。除明文外，还会抹除 `x-access-token:<secret>`
 * 的 base64 形式 —— 这是 http.extraheader 注入后会出现在命令行里的样子。
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

- [ ] **Step 6: 写最小的 `src/index.ts`**

```ts
export * from './types'
```

- [ ] **Step 7: 运行测试与类型检查**

Run: `bun install && bun test tests/unit/sanitize.test.ts && bun run typecheck`
Expected: 6 tests PASS，typecheck 无错误

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts src tests
git commit -m "feat: scaffold package and add secret redaction"
```

---

### Task 2: ErrorMapper（纯函数）

**Files:**
- Create: `src/domain/error-mapper.ts`
- Test: `tests/unit/error-mapper.test.ts`

**Interfaces:**
- Consumes: `GitErrorCode`（Task 1）
- Produces: `mapGitError(stderr: string, exitCode?: number): GitErrorCode`

- [ ] **Step 1: 写失败的测试**

`tests/unit/error-mapper.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { mapGitError } from '../../src/domain/error-mapper'

describe('mapGitError', () => {
  const cases: Array<[string, string, string]> = [
    ['认证失败', "fatal: Authentication failed for 'https://github.com/a/b.git/'", 'AUTH_FAILED'],
    ['401', 'fatal: unable to access: The requested URL returned error: 403', 'AUTH_FAILED'],
    ['DNS 失败', 'fatal: unable to access: Could not resolve host: github.com', 'NETWORK'],
    ['连接超时', 'fatal: unable to access: Failed to connect to github.com port 443: Connection timed out', 'NETWORK'],
    ['非仓库', 'fatal: not a git repository (or any of the parent directories): .git', 'NOT_A_REPO'],
    ['工作区脏', 'error: Your local changes to the following files would be overwritten by merge:', 'DIRTY_WORKTREE'],
    ['merge 进行中', 'fatal: You have not concluded your merge (MERGE_HEAD exists).', 'MERGE_IN_PROGRESS'],
    ['分支已被占用', "fatal: 'feat/x' is already checked out at '/data/wt/a'", 'BRANCH_IN_USE'],
    ['分支已存在', "fatal: a branch named 'feat/x' already exists", 'BRANCH_EXISTS'],
  ]

  for (const [name, stderr, expected] of cases) {
    test(name, () => {
      expect(mapGitError(stderr)).toBe(expected as never)
    })
  }

  test('无法识别时返回 UNKNOWN，绝不猜测', () => {
    expect(mapGitError('fatal: something nobody has ever seen before')).toBe('UNKNOWN')
  })

  test('空 stderr 返回 UNKNOWN', () => {
    expect(mapGitError('')).toBe('UNKNOWN')
  })

  test('匹配不区分大小写', () => {
    expect(mapGitError('FATAL: AUTHENTICATION FAILED for x')).toBe('AUTH_FAILED')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/unit/error-mapper.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/domain/error-mapper.ts`**

```ts
import type { GitErrorCode } from '../types'

/**
 * stderr 模式 → 错误码。顺序敏感：先匹配者胜。
 * 匹配不中一律返回 UNKNOWN —— 猜错的错误码比没有错误码更有害。
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

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test tests/unit/error-mapper.test.ts`
Expected: 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/error-mapper.ts tests/unit/error-mapper.test.ts
git commit -m "feat: map git stderr to structured error codes"
```

---

### Task 3: LayoutPlanner（纯函数）

**Files:**
- Create: `src/domain/layout-planner.ts`
- Test: `tests/unit/layout-planner.test.ts`

**Interfaces:**
- Consumes: `GitOpError`（Task 1）
- Produces:
  - `planLayout(root: string, url: string): { key: string; repoDir: string; storeDir: string; worktreeRoot: string }`
  - `worktreeDirFor(worktreeRoot: string, sessionId: string): string`

`key` 是 store 的唯一标识（也用作 `StoreMutex` 的键）。

- [ ] **Step 1: 写失败的测试**

`tests/unit/layout-planner.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { planLayout, worktreeDirFor } from '../../src/domain/layout-planner'
import { GitOpError } from '../../src/types'

describe('planLayout', () => {
  test('标准 https url', () => {
    const l = planLayout('/data/repos', 'https://github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).toBe('/data/repos/github.com/acme/web')
    expect(l.storeDir).toBe('/data/repos/github.com/acme/web/store')
    expect(l.worktreeRoot).toBe('/data/repos/github.com/acme/web/wt')
  })

  test('去掉 .git 后缀', () => {
    expect(planLayout('/r', 'https://github.com/acme/web.git').key).toBe('github.com/acme/web')
  })

  test('去掉尾部斜杠', () => {
    expect(planLayout('/r', 'https://github.com/acme/web/').key).toBe('github.com/acme/web')
  })

  test('host 小写化，path 保留大小写', () => {
    expect(planLayout('/r', 'https://GitHub.COM/Acme/Web').key).toBe('github.com/Acme/Web')
  })

  test('带端口的自建 GHE', () => {
    expect(planLayout('/r', 'https://git.corp.io:8443/g/p').key).toBe('git.corp.io_8443/g/p')
  })

  test('url 中的凭据被丢弃，不进入路径', () => {
    const l = planLayout('/r', 'https://user:tok@github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).not.toContain('tok')
  })

  test('路径段中的可疑字符被替换', () => {
    expect(planLayout('/r', 'https://github.com/a..b/c').key).toBe('github.com/a__b/c')
  })

  test('非 http(s) url 抛 INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'git@github.com:acme/web.git')).toThrow(GitOpError)
  })

  test('缺少 owner/repo 抛 INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'https://github.com/')).toThrow(GitOpError)
  })
})

describe('worktreeDirFor', () => {
  test('拼接 sessionId', () => {
    expect(worktreeDirFor('/r/wt', 'abc123')).toBe('/r/wt/abc123')
  })

  test('sessionId 含分隔符时抛错', () => {
    expect(() => worktreeDirFor('/r/wt', '../escape')).toThrow(GitOpError)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/unit/layout-planner.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/domain/layout-planner.ts`**

```ts
import { posix } from 'node:path'
import { GitOpError } from '../types'

export type Layout = {
  key: string
  repoDir: string
  storeDir: string
  worktreeRoot: string
}

/** 路径段中只保留安全字符，避免 `..`、分隔符等进入文件系统路径。 */
function safeSegment(seg: string): string {
  return seg.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '__')
}

export function planLayout(root: string, url: string): Layout {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GitOpError('INVALID_ARGUMENT', `无法解析仓库 URL: ${url}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GitOpError('INVALID_ARGUMENT', `只支持 http(s) URL，收到: ${parsed.protocol}`)
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
    throw new GitOpError('INVALID_ARGUMENT', `URL 缺少 owner/repo: ${url}`)
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
    throw new GitOpError('INVALID_ARGUMENT', `非法 sessionId: ${sessionId}`)
  }
  return posix.join(worktreeRoot, sessionId)
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test tests/unit/layout-planner.test.ts`
Expected: 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/layout-planner.ts tests/unit/layout-planner.test.ts
git commit -m "feat: derive store and worktree paths from repo url"
```

---

### Task 4: SparseManager（纯函数）

**Files:**
- Create: `src/domain/sparse-manager.ts`
- Test: `tests/unit/sparse-manager.test.ts`

**Interfaces:**
- Consumes: `SparsePath`, `GitOpError`（Task 1）
- Produces:
  - `normalizeSparsePaths(input?: readonly (string | SparsePath)[]): SparsePath[]`
  - `isFullCheckout(paths: SparsePath[]): boolean`

规范化规则：转 POSIX 分隔符、去首尾斜杠、去重、**丢弃被父目录覆盖的子路径**（cone 模式下父目录已包含子目录）。校验规则：拒绝 glob 字符、拒绝 `..`、拒绝绝对路径、拒绝空串。

- [ ] **Step 1: 写失败的测试**

`tests/unit/sparse-manager.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { isFullCheckout, normalizeSparsePaths } from '../../src/domain/sparse-manager'
import { GitOpError } from '../../src/types'

describe('normalizeSparsePaths', () => {
  test('undefined 与空数组都表示全量 checkout', () => {
    expect(normalizeSparsePaths(undefined)).toEqual([])
    expect(normalizeSparsePaths([])).toEqual([])
    expect(isFullCheckout([])).toBe(true)
  })

  test('字符串简写默认 requireChecks: true（保守）', () => {
    expect(normalizeSparsePaths(['docs'])).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('对象形式保留 requireChecks', () => {
    expect(normalizeSparsePaths([{ path: 'docs', requireChecks: false }]))
      .toEqual([{ path: 'docs', requireChecks: false }])
  })

  test('对象形式省略 requireChecks 时默认 true', () => {
    expect(normalizeSparsePaths([{ path: 'src' }])).toEqual([{ path: 'src', requireChecks: true }])
  })

  test('反斜杠转为正斜杠，首尾斜杠被去掉', () => {
    expect(normalizeSparsePaths(['\\docs\\api\\'])[0]!.path).toBe('docs/api')
  })

  test('重复路径去重', () => {
    expect(normalizeSparsePaths(['docs', 'docs/'])).toHaveLength(1)
  })

  test('被父目录覆盖的子路径被丢弃', () => {
    const out = normalizeSparsePaths(['docs', 'docs/api'])
    expect(out).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('父目录的 requireChecks 取最保守值', () => {
    const out = normalizeSparsePaths([
      { path: 'docs', requireChecks: false },
      { path: 'docs/api', requireChecks: true },
    ])
    expect(out).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('前缀相似但非父子关系的路径都保留', () => {
    const out = normalizeSparsePaths(['docs', 'docsite'])
    expect(out.map((p) => p.path).sort()).toEqual(['docs', 'docsite'])
  })

  test('输出按 path 排序，结果稳定', () => {
    expect(normalizeSparsePaths(['b', 'a']).map((p) => p.path)).toEqual(['a', 'b'])
  })

  const bad: Array<[string, string]> = [
    ['glob 星号', 'docs/*'],
    ['glob 问号', 'docs/?.md'],
    ['glob 方括号', 'docs/[ab]'],
    ['否定前缀', '!docs'],
    ['父目录穿越', '../etc'],
    ['内嵌穿越', 'docs/../../etc'],
    ['绝对路径', '/etc'],
    ['空串', ''],
    ['纯空白', '   '],
  ]
  for (const [name, p] of bad) {
    test(`拒绝：${name}`, () => {
      expect(() => normalizeSparsePaths([p])).toThrow(GitOpError)
    })
  }
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/unit/sparse-manager.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/domain/sparse-manager.ts`**

```ts
import { GitOpError, type SparsePath } from '../types'

function validate(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim()
  if (!p) throw new GitOpError('INVALID_ARGUMENT', 'sparse path 不能为空')
  if (raw.startsWith('/')) throw new GitOpError('INVALID_ARGUMENT', `sparse path 必须是相对路径: ${raw}`)
  if (/[*?[\]!]/.test(p)) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `sparse path 不支持通配符（只支持 cone 模式的目录前缀）: ${raw}`,
    )
  }
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new GitOpError('INVALID_ARGUMENT', `sparse path 不得包含 . 或 ..: ${raw}`)
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
    // 同路径重复出现时取最保守值
    merged.set(path, (merged.get(path) ?? false) || requireChecks)
  }

  const sorted = [...merged.keys()].sort()
  const kept: SparsePath[] = []
  for (const path of sorted) {
    const ancestor = kept.find((k) => isAncestor(k.path, path))
    if (ancestor) {
      // 子路径被父目录覆盖：丢弃自身，但把 requireChecks 向上合并为最保守值
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

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test tests/unit/sparse-manager.test.ts`
Expected: 19 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/sparse-manager.ts tests/unit/sparse-manager.test.ts
git commit -m "feat: normalize and validate cone-mode sparse paths"
```

---

### Task 5: PathGuard（纯函数）

**Files:**
- Create: `src/domain/path-guard.ts`
- Test: `tests/unit/path-guard.test.ts`

**Interfaces:**
- Consumes: `SparsePath`, `GitOpError`（Task 1）
- Produces: `resolveWithin(worktreeDir: string, relPath: string, sparse: readonly SparsePath[]): string`

返回绝对路径。越界抛 `PATH_TRAVERSAL`，出 sparse 范围抛 `PATH_OUTSIDE_SPARSE`。

- [ ] **Step 1: 写失败的测试**

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
  test('sparse 范围内的路径通过', () => {
    expect(resolveWithin(WT, 'docs/a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('sparse 目录本身通过', () => {
    expect(resolveWithin(WT, 'docs', SPARSE)).toBe('/wt/task-1/docs')
  })

  test('规范化冗余片段', () => {
    expect(resolveWithin(WT, './docs/./a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('全量模式（sparse 为空）放行任意仓内路径', () => {
    expect(resolveWithin(WT, 'src/x.ts', [])).toBe('/wt/task-1/src/x.ts')
  })

  test('穿越到 worktree 之外 → PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '../other/a.md', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('深度穿越 → PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, 'docs/../../etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('绝对路径 → PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '/etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('仓内但不在 sparse 范围 → PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'src/index.ts', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('前缀相同但非子目录 → PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'docsite/a.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('仓库根文件在 sparse 模式下被拒（cone 模式虽保留根文件，但本包不允许写）', () => {
    expect(codeOf(() => resolveWithin(WT, 'README.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('空路径 → INVALID_ARGUMENT', () => {
    expect(codeOf(() => resolveWithin(WT, '', SPARSE))).toBe('INVALID_ARGUMENT')
  })

  test('.git 目录一律拒绝', () => {
    expect(codeOf(() => resolveWithin(WT, '.git/config', []))).toBe('PATH_TRAVERSAL')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/unit/path-guard.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/domain/path-guard.ts`**

```ts
import { posix } from 'node:path'
import { GitOpError, type SparsePath } from '../types'

/**
 * 校验并解析 worktree 内的相对路径。
 *
 * 注意：这是纯函数，不做符号链接解析（那需要 IO）。调用方 FsGateway
 * 在真正写入前还需用 lstat 拒绝符号链接 —— 见 exec/fs-gateway.ts。
 */
export function resolveWithin(
  worktreeDir: string,
  relPath: string,
  sparse: readonly SparsePath[],
): string {
  if (!relPath || !relPath.trim()) {
    throw new GitOpError('INVALID_ARGUMENT', '路径不能为空')
  }

  const normalizedInput = relPath.replace(/\\/g, '/')
  if (posix.isAbsolute(normalizedInput)) {
    throw new GitOpError('PATH_TRAVERSAL', `不接受绝对路径: ${relPath}`)
  }

  const rel = posix.normalize(normalizedInput).replace(/^\.\//, '').replace(/\/+$/, '')
  if (rel === '..' || rel.startsWith('../')) {
    throw new GitOpError('PATH_TRAVERSAL', `路径越出 worktree: ${relPath}`)
  }
  if (rel === '.git' || rel.startsWith('.git/')) {
    throw new GitOpError('PATH_TRAVERSAL', `不允许访问 .git 目录: ${relPath}`)
  }

  if (sparse.length > 0) {
    const inScope = sparse.some((s) => rel === s.path || rel.startsWith(`${s.path}/`))
    if (!inScope) {
      const allowed = sparse.map((s) => s.path).join(', ')
      throw new GitOpError(
        'PATH_OUTSIDE_SPARSE',
        `路径 ${rel} 不在 sparse 范围内（允许: ${allowed}）`,
      )
    }
  }

  return posix.join(worktreeDir, rel)
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test tests/unit/path-guard.test.ts`
Expected: 12 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/path-guard.ts tests/unit/path-guard.test.ts
git commit -m "feat: guard worktree paths against traversal and sparse escape"
```

---

### Task 6: StoreMutex（按 key 串行化）

**Files:**
- Create: `src/exec/store-mutex.ts`
- Test: `tests/unit/store-mutex.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `class StoreMutex { run<T>(key: string, fn: () => Promise<T>): Promise<T> }`

- [ ] **Step 1: 写失败的测试**

`tests/unit/store-mutex.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { StoreMutex } from '../../src/exec/store-mutex'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('StoreMutex', () => {
  test('同 key 的任务串行执行，不重叠', async () => {
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

  test('不同 key 的任务可并发', async () => {
    const m = new StoreMutex()
    const events: string[] = []
    const job = (name: string, ms: number) => async () => {
      events.push(`${name}:start`)
      await tick(ms)
      events.push(`${name}:end`)
    }
    await Promise.all([m.run('k1', job('a', 20)), m.run('k2', job('b', 1))])
    expect(events[0]).toBe('a:start')
    expect(events[1]).toBe('b:start')  // b 未被 a 阻塞
  })

  test('返回值透传', async () => {
    const m = new StoreMutex()
    await expect(m.run('k', async () => 42)).resolves.toBe(42)
  })

  test('抛错后队列不卡死，后续任务照常执行', async () => {
    const m = new StoreMutex()
    await expect(m.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(m.run('k', async () => 'ok')).resolves.toBe('ok')
  })

  test('队列排空后不残留 key，避免内存泄漏', async () => {
    const m = new StoreMutex()
    await m.run('k', async () => 1)
    expect(m.size).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/unit/store-mutex.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 `src/exec/store-mutex.ts`**

```ts
/**
 * 按 key 分键的进程内串行队列。
 *
 * 只用于保护 store 级共享状态：git fetch（写 refs 与对象）与
 * git worktree add/remove（写 .git/worktrees）。worktree 内部的操作
 * 一律无锁 —— 见 spec §3.4。
 *
 * 本包假设单进程独占 root 目录，因此不需要文件锁或分布式锁。
 */
export class StoreMutex {
  #tails = new Map<string, Promise<unknown>>()

  get size(): number {
    return this.#tails.size
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve()
    // 无论前一个任务成功还是失败，都继续排队，避免队列卡死
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

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test tests/unit/store-mutex.test.ts`
Expected: 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/exec/store-mutex.ts tests/unit/store-mutex.test.ts
git commit -m "feat: serialize store-level git operations per key"
```

---

### Task 7: GitExecutor（唯一 spawn git 的地方）

**Files:**
- Create: `src/exec/git-executor.ts`
- Test: `tests/integration/git-executor.test.ts`
- Test: `tests/helpers/fixtures.ts`

**Interfaces:**
- Consumes: `redact`（Task 1）、`mapGitError`（Task 2）、`GitOpError` / `ProgressEvent`（Task 1）
- Produces:
  - `type ExecOptions = { cwd?: string; token?: string; timeout?: number; phase?: ProgressEvent['phase'] }`
  - `class GitExecutor { constructor(opts: { gitPath?: string; timeout?: number; onProgress?: (e: ProgressEvent) => void }); run(args: string[], opts?: ExecOptions): Promise<string>; version(): Promise<{ major: number; minor: number; patch: number; raw: string }> }`

`run` 返回 stdout（已 trim）。失败时抛 `GitOpError`，`code` 由 `mapGitError` 决定，`detail` 与 `command` 均已脱敏。

- [ ] **Step 1: 写测试辅助（真 git 环境）**

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
 * 造一个带内容的 bare 仓库当作 remote，返回其路径（可作为 clone url）。
 * 目录结构：docs/a.md、docs/api/b.md、src/index.ts、README.md
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

/** 在 remote 上追加一次提交，用于模拟"别人 push 了改动"。 */
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

- [ ] **Step 2: 写失败的 GitExecutor 测试**

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
  test('version 解析出版本号', async () => {
    const v = await new GitExecutor({}).version()
    expect(v.major).toBeGreaterThanOrEqual(2)
    expect(typeof v.raw).toBe('string')
  })

  test('run 返回 trim 后的 stdout', async () => {
    const bare = makeBareRemote(root)
    const out = await new GitExecutor({}).run(['ls-remote', '--heads', bare])
    expect(out).toContain('refs/heads/main')
    expect(out).toBe(out.trim())
  })

  test('失败时抛 GitOpError 且带映射后的 code', async () => {
    const exec = new GitExecutor({})
    try {
      await exec.run(['status'], { cwd: root })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(GitOpError)
      expect((e as GitOpError).code).toBe('NOT_A_REPO')
    }
  })

  test('错误信息与 command 中不含 token', async () => {
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

  test('超时抛 TIMEOUT', async () => {
    const exec = new GitExecutor({ timeout: 1 })
    try {
      // clone 一个不可达地址，必然超过 1ms
      await exec.run(['clone', 'https://127.0.0.1:1/nope.git', `${root}/x`])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('TIMEOUT')
    }
  })

  test('onProgress 收到已脱敏的事件', async () => {
    const events: ProgressEvent[] = []
    const bare = makeBareRemote(root)
    const exec = new GitExecutor({ onProgress: (e) => events.push(e) })
    await exec.run(['clone', '--progress', bare, `${root}/c`], { phase: 'clone' })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.phase === 'clone')).toBe(true)
  })

  test('注入 merge.conflictStyle=diff3', async () => {
    const bare = makeBareRemote(root)
    const exec = new GitExecutor({})
    await exec.run(['clone', bare, `${root}/c`])
    const out = await exec.run(['config', '--get', 'merge.conflictStyle'], { cwd: `${root}/c` })
      .catch(() => '')
    // 注入是通过 -c 而非写入 config，所以 config --get 读不到；
    // 这里改为断言注入出现在传给 git 的参数中
    expect(out).toBe('')
    const args = exec.buildArgs(['status'], {})
    expect(args).toContain('merge.conflictStyle=diff3')
  })
})
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `bun test tests/integration/git-executor.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 4: 实现 `src/exec/git-executor.ts`**

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
 * 唯一 spawn git 的地方。其他任何文件出现 child_process 均为实现错误。
 *
 * 认证通过 `-c http.extraheader` 单次注入，绝不写入 URL —— 后者会落入
 * .git/config 与 reflog 造成泄露。
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

  /** 暴露出来仅为可测试性：构造实际传给 git 的完整参数列表。 */
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
      throw new GitOpError('UNKNOWN', `无法解析 git 版本: ${raw}`, { detail: raw })
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

- [ ] **Step 5: 运行测试，确认通过**

Run: `bun test tests/integration/git-executor.test.ts`
Expected: 7 tests PASS

- [ ] **Step 6: 加一条守卫测试，防止别处 spawn git**

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

describe('架构约束', () => {
  const files = walk('src')

  test('只有 git-executor.ts 可以 import child_process 或 simple-git', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith('git-executor.ts') &&
        /from ['"]node:child_process['"]|from ['"]simple-git['"]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  test('domain/ 下不得碰 IO', () => {
    const offenders = files
      .filter((f) => f.includes('/domain/'))
      .filter((f) =>
        /from ['"]node:(fs|child_process|net|http|https)['"]/.test(readFileSync(f, 'utf8')),
      )
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 7: 运行全部测试**

Run: `bun test && bun run typecheck`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/exec/git-executor.ts tests/
git commit -m "feat: add git executor with auth injection, timeout and redaction"
```

---

### Task 8: RepoManager —— preflight、布局、clone 去重

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

**本任务只交付到"store 目录被正确 clone 出来"**；`RepoStore` 的 session 能力在 Task 9。本任务先实现 `RepoStore` 的构造与 `fetch`。

- [ ] **Step 1: 写失败的测试**

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

// 本地路径不是 http url，planLayout 只接受 http(s)。
// 集成测试用 file:// 形式的 url，并在 manager 里放行 file 协议见 Step 3 说明。
const urlOf = (p: string) => `file://${p}`

describe('RepoManager', () => {
  test('首次调用 store() 执行 clone，目录落在预期布局', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(existsSync(join(store.storeDir, '.git'))).toBe(true)
    expect(existsSync(store.worktreeRoot)).toBe(true)
  })

  test('store 的工作区为空（--no-checkout）', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    const entries = readdirSync(store.storeDir).filter((e) => e !== '.git')
    expect(entries).toEqual([])
  })

  test('store 设置了 extensions.worktreeConfig', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('extensions.worktreeConfig')).toBe('true')
  })

  test('store 保留了 remote.origin.fetch refspec（证明未用 --bare）', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('remote.origin.fetch'))
      .toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  test('第二次调用复用同一 store 实例，不重复 clone', async () => {
    const m = new RepoManager({ root: repos })
    const a = await m.store({ url: urlOf(bare) })
    const b = await m.store({ url: urlOf(bare) })
    expect(b).toBe(a)
  })

  test('并发首次调用只 clone 一次', async () => {
    const m = new RepoManager({ root: repos })
    const [a, b, c] = await Promise.all([
      m.store({ url: urlOf(bare) }),
      m.store({ url: urlOf(bare) }),
      m.store({ url: urlOf(bare) }),
    ])
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test('已存在的 store 目录被复用而非重新 clone', async () => {
    const m1 = new RepoManager({ root: repos })
    const s1 = await m1.store({ url: urlOf(bare) })
    const m2 = new RepoManager({ root: repos })
    const s2 = await m2.store({ url: urlOf(bare) })
    expect(s2.storeDir).toBe(s1.storeDir)
    expect(existsSync(join(s2.storeDir, '.git'))).toBe(true)
  })

  test('git 版本过低时 preflight 抛 GIT_VERSION_TOO_OLD', async () => {
    const m = new RepoManager({ root: repos, gitPath: 'git' })
    // 用一个伪造的 version 注入点：见实现中的 minGitVersion 可选参数
    const low = new RepoManager({ root: repos, minGitVersion: { major: 99, minor: 0, patch: 0 } })
    await expect(low.store({ url: urlOf(bare) })).rejects.toThrow(GitOpError)
    void m
  })

  test('gitPath 指向不存在的可执行文件时抛 GIT_NOT_FOUND', async () => {
    const m = new RepoManager({ root: repos, gitPath: '/nonexistent/git' })
    try {
      await m.store({ url: urlOf(bare) })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('GIT_NOT_FOUND')
    }
  })

  test('evict 删除 store 目录', async () => {
    const m = new RepoManager({ root: repos })
    const s = await m.store({ url: urlOf(bare) })
    expect(await m.evict(urlOf(bare))).toBe(true)
    expect(existsSync(s.storeDir)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/integration/repo-manager.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 放宽 `planLayout` 以支持 `file://`（仅测试用）**

修改 `src/domain/layout-planner.ts` 的协议校验，并在 `tests/unit/layout-planner.test.ts` 补一条用例：

```ts
// layout-planner.ts 中替换协议判断
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'file:'])
if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
  throw new GitOpError('INVALID_ARGUMENT', `只支持 http(s)/file URL，收到: ${parsed.protocol}`)
}
```

对 `file:` URL，`hostname` 为空，用固定字符串 `local` 作为 host 段：

```ts
const rawHost = parsed.hostname || (parsed.protocol === 'file:' ? 'local' : '')
if (!rawHost) throw new GitOpError('INVALID_ARGUMENT', `URL 缺少 host: ${url}`)
const host = parsed.port ? `${rawHost.toLowerCase()}_${parsed.port}` : rawHost.toLowerCase()
```

`file://` 的 pathname 常常只有一段（如 `/tmp/xxx/remote.git`），因此把「至少两段」的校验放宽为 **http(s) 才要求两段**：

```ts
if (parsed.protocol !== 'file:' && segments.length < 2) {
  throw new GitOpError('INVALID_ARGUMENT', `URL 缺少 owner/repo: ${url}`)
}
if (segments.length === 0) {
  throw new GitOpError('INVALID_ARGUMENT', `URL 缺少路径: ${url}`)
}
```

新增单测：

```ts
test('file:// url 用于本地测试', () => {
  const l = planLayout('/r', 'file:///tmp/x/remote.git')
  expect(l.key).toBe('local/tmp/x/remote')
})
```

- [ ] **Step 4: 实现 `src/api/repo-manager.ts`**

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
  /** 仅供测试覆盖；生产环境不要传。 */
  minGitVersion?: { major: number; minor: number; patch: number }
}

export type StoreConfig = {
  url: string
  auth?: { token: string }
  depth?: number
  /** partial clone filter，默认 'blob:none'；传 false 关闭。 */
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
          `需要 git >= ${min.major}.${min.minor}，当前为 ${v.raw}`,
          { detail: v.raw },
        )
      }
    })()
    try {
      await this.#preflight
    } catch (e) {
      this.#preflight = undefined  // 允许下次重试
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

- [ ] **Step 5: 实现 `src/api/repo-store.ts` 的最小版本**

本步只实现构造、`configGet`、`fetch`、`pruneOrphans` 与计数字段；session 能力在 Task 9 补齐。

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

  /** 仅供 RepoManager 与 session 生命周期使用。 */
  _retain(): void { this.#active += 1; this.#touch() }
  _release(): void { this.#active = Math.max(0, this.#active - 1); this.#touch() }
  #touch(): void { this.#lastUsed = performance.timeOrigin + performance.now() }

  async configGet(name: string): Promise<string> {
    return this.#d.exec.run(['config', '--get', name], { cwd: this.storeDir })
  }

  /** store 级：写 refs 与对象，必须串行。 */
  async fetch(refspec?: string): Promise<void> {
    this.#touch()
    await this.#d.mutex.run(this.key, () =>
      this.#d.exec.run(
        refspec ? ['fetch', 'origin', refspec] : ['fetch', '--prune', 'origin'],
        { cwd: this.storeDir, token: this.#d.token, phase: 'fetch' },
      ),
    )
  }

  /** 启动清理：回收进程被 kill 后残留的孤儿 worktree。 */
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

- [ ] **Step 6: 更新 `src/index.ts`**

```ts
export * from './types'
export { RepoManager } from './api/repo-manager'
export type { ManagerConfig, StoreConfig, GcReport } from './api/repo-manager'
export { RepoStore } from './api/repo-store'
```

- [ ] **Step 7: 运行测试**

Run: `bun test && bun run typecheck`
Expected: 全部 PASS（repo-manager 10 tests + 既有测试）

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat: add repo manager with preflight, layout and clone dedup"
```

---

### Task 9: worktree session —— 正确的 sparse 创建顺序

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

**关键：worktree 创建顺序必须是 `add --no-checkout` → `sparse-checkout init --cone` → `sparse-checkout set` → `checkout`。** 顺序错了会在 partial clone 中触发全量 blob 拉取，"只下载指定目录"直接失效。

- [ ] **Step 1: 写失败的测试**

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

describe('session 生命周期', () => {
  test('sparse 模式下只有指定目录落盘', async () => {
    const repo = await store.createSession({
      branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR,
    })
    expect(existsSync(join(repo.dir, 'docs', 'a.md'))).toBe(true)
    expect(existsSync(join(repo.dir, 'src'))).toBe(false)
    await repo.dispose()
  })

  test('全量模式下所有目录落盘', async () => {
    const repo = await store.createSession({ branch: 'feat/full', author: AUTHOR })
    expect(existsSync(join(repo.dir, 'src', 'index.ts'))).toBe(true)
    await repo.dispose()
  })

  test('两个 session 的 sparse 配置互不污染', async () => {
    const a = await store.createSession({ branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR })
    const b = await store.createSession({ branch: 'feat/b', sparsePaths: ['src'], author: AUTHOR })
    expect(existsSync(join(a.dir, 'docs'))).toBe(true)
    expect(existsSync(join(a.dir, 'src'))).toBe(false)
    expect(existsSync(join(b.dir, 'src'))).toBe(true)
    expect(existsSync(join(b.dir, 'docs'))).toBe(false)
    await a.dispose(); await b.dispose()
  })

  test('创建 worktree 期间不发生全量 blob 拉取', async () => {
    // partial clone 下，未拉取的 blob 计为 promisor 缺失。
    // 断言 sparse session 建立后，src/ 下的 blob 仍未被取回。
    const repo = await store.createSession({
      branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR,
    })
    const missing = execFileSync(
      'git',
      ['rev-list', '--objects', '--missing=print', 'HEAD'],
      { cwd: store.storeDir, encoding: 'utf8' },
    )
    // 至少 src/index.ts 与 README.md 的 blob 应仍缺失（以 ? 开头）
    expect(missing.split('\n').filter((l) => l.startsWith('?')).length).toBeGreaterThan(0)
    await repo.dispose()
  })

  test('同一分支在两个 session 中 checkout → BRANCH_IN_USE', async () => {
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

  test("branchMode: 'create' 遇已存在分支 → BRANCH_EXISTS", async () => {
    const a = await store.createSession({ branch: 'feat/x', author: AUTHOR })
    await a.dispose()
    try {
      await store.createSession({ branch: 'feat/x', branchMode: 'create', author: AUTHOR })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('BRANCH_EXISTS')
    }
  })

  test("branchMode: 'reuse' 遇不存在分支 → BRANCH_NOT_FOUND", async () => {
    try {
      await store.createSession({ branch: 'feat/nope', branchMode: 'reuse', author: AUTHOR })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('BRANCH_NOT_FOUND')
    }
  })

  test("branchMode 默认 createOrReuse：不存在则建，存在则复用", async () => {
    const a = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    await a.dispose()
    const b = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    expect(b.branch).toBe('feat/r')
    await b.dispose()
  })

  test('dispose 后目录被删除，且幂等', async () => {
    const repo = await store.createSession({ branch: 'feat/d', author: AUTHOR })
    const dir = repo.dir
    await repo.dispose()
    await repo.dispose()
    expect(existsSync(dir)).toBe(false)
  })

  test('dispose 后调用方法抛 WORKTREE_DISPOSED', async () => {
    const repo = await store.createSession({ branch: 'feat/d2', author: AUTHOR })
    await repo.dispose()
    try {
      await repo.status()
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('WORKTREE_DISPOSED')
    }
  })

  test('activeSessions 计数随创建与释放增减', async () => {
    expect(store.activeSessions).toBe(0)
    const a = await store.createSession({ branch: 'feat/c1', author: AUTHOR })
    expect(store.activeSessions).toBe(1)
    await a.dispose()
    expect(store.activeSessions).toBe(0)
  })

  test('listSessions 报告存活 worktree 与状态', async () => {
    const a = await store.createSession({ branch: 'feat/l', author: AUTHOR })
    const list = await store.listSessions()
    expect(list.map((s) => s.dir)).toContain(a.dir)
    expect(list.find((s) => s.dir === a.dir)!.state).toBe('clean')
    await a.dispose()
  })

  test('并发创建 10 个 session 全部成功且互不干扰', async () => {
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

  test('attachSession 可重新接管已存在的 worktree', async () => {
    const a = await store.createSession({ branch: 'feat/at', author: AUTHOR })
    const dir = a.dir
    const b = await store.attachSession(dir)
    expect(b.dir).toBe(dir)
    expect(b.branch).toBe('feat/at')
    await b.dispose()
  })

  test('pruneOrphans 回收无主目录', async () => {
    const orphan = join(store.worktreeRoot, 'orphan-xyz')
    execFileSync('mkdir', ['-p', join(orphan, 'sub')])
    const removed = await store.pruneOrphans()
    expect(removed).toContain(orphan)
    expect(existsSync(orphan)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/integration/session.test.ts`
Expected: FAIL —— `createSession` 不存在

- [ ] **Step 3: 实现 `src/api/git-repo.ts`**

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

  /** 供 GitRepo 内部与同包其他 api 类使用。 */
  _assertLive(): void {
    if (this.#disposed) {
      throw new GitOpError('WORKTREE_DISPOSED', `session 已释放: ${this.#d.dir}`)
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

- [ ] **Step 4: 在 `src/api/repo-store.ts` 中加入 session 能力**

在类中追加以下成员（保留 Task 8 已有内容）：

```ts
// 文件顶部追加 import
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

类内新增方法：

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
        throw new GitOpError('BRANCH_IN_USE', `分支 ${cfg.branch} 已在另一个 worktree 中 checkout`)
      }
      const exists = await this.#branchExists(cfg.branch)
      if (mode === 'create' && exists) {
        throw new GitOpError('BRANCH_EXISTS', `分支已存在: ${cfg.branch}`)
      }
      if (mode === 'reuse' && !exists) {
        throw new GitOpError('BRANCH_NOT_FOUND', `分支不存在: ${cfg.branch}`)
      }

      // 关键顺序：先建空 worktree，再配 sparse，最后才 checkout。
      // 若先 checkout，partial clone 会向 promisor remote 批量拉取全部 blob。
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

- [ ] **Step 5: 更新 `src/index.ts`**

```ts
export * from './types'
export { RepoManager } from './api/repo-manager'
export type { ManagerConfig, StoreConfig, GcReport } from './api/repo-manager'
export { RepoStore } from './api/repo-store'
export type { SessionConfig, SessionInfo } from './api/repo-store'
export { GitRepo } from './api/git-repo'
export type { StatusResult } from './api/git-repo'
```

- [ ] **Step 6: 运行测试**

Run: `bun test tests/integration/session.test.ts`
Expected: 15 tests PASS

- [ ] **Step 7: 运行全部测试与类型检查**

Run: `bun test && bun run typecheck`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src tests
git commit -m "feat: create sparse worktree sessions with correct checkout order"
```

---

### Task 10: FsGateway —— 受约束的文件读写

**Files:**
- Create: `src/exec/fs-gateway.ts`
- Modify: `src/api/git-repo.ts`
- Test: `tests/integration/fs-gateway.test.ts`

**Interfaces:**
- Consumes: `resolveWithin`（Task 5）、`GitRepo`（Task 9）
- Produces:
  - `class FsGateway { constructor(dir: string, sparse: readonly SparsePath[]); readFile(rel): Promise<string>; writeFile(rel, content): Promise<void>; listFiles(rel?): Promise<string[]>; exists(rel): Promise<boolean> }`
  - `GitRepo#readFile / writeFile / listFiles / exists`

- [ ] **Step 1: 写失败的测试**

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

describe('FsGateway 经由 GitRepo', () => {
  test('读取 sparse 范围内的文件', async () => {
    expect(await repo.readFile('docs/a.md')).toBe('# a\n')
  })

  test('写入并读回', async () => {
    await repo.writeFile('docs/new.md', 'hello')
    expect(await repo.readFile('docs/new.md')).toBe('hello')
  })

  test('写入时自动创建中间目录', async () => {
    await repo.writeFile('docs/deep/nested/x.md', 'x')
    expect(await repo.readFile('docs/deep/nested/x.md')).toBe('x')
  })

  test('读取 sparse 范围外的文件 → PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.readFile('src/index.ts'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('写入 sparse 范围外 → PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.writeFile('src/x.ts', 'x'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('穿越路径 → PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.writeFile('../escape.md', 'x'))).toBe('PATH_TRAVERSAL')
  })

  test('写入 .git 下 → PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.writeFile('.git/hooks/evil', 'x'))).toBe('PATH_TRAVERSAL')
  })

  test('经由符号链接逃逸 → PATH_TRAVERSAL', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(repo.dir, 'docs', 'link'))
    expect(await codeOf(repo.readFile('docs/link/secret.txt'))).toBe('PATH_TRAVERSAL')
  })

  test('listFiles 只列出 sparse 范围内的文件，且不含 .git', async () => {
    const files = await repo.listFiles()
    expect(files).toContain('docs/a.md')
    expect(files).toContain('docs/api/b.md')
    expect(files.some((f) => f.startsWith('.git'))).toBe(false)
    expect(files.some((f) => f.startsWith('src/'))).toBe(false)
  })

  test('listFiles 可限定子目录', async () => {
    expect(await repo.listFiles('docs/api')).toEqual(['docs/api/b.md'])
  })

  test('exists 对存在与不存在分别返回 true/false', async () => {
    expect(await repo.exists('docs/a.md')).toBe(true)
    expect(await repo.exists('docs/nope.md')).toBe(false)
  })

  test('dispose 后文件操作抛 WORKTREE_DISPOSED', async () => {
    await repo.dispose()
    expect(await codeOf(repo.readFile('docs/a.md'))).toBe('WORKTREE_DISPOSED')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/integration/fs-gateway.test.ts`
Expected: FAIL —— `repo.readFile` 不存在

- [ ] **Step 3: 实现 `src/exec/fs-gateway.ts`**

```ts
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { resolveWithin } from '../domain/path-guard'
import { GitOpError, type SparsePath } from '../types'

/**
 * 受 PathGuard 约束的文件访问。
 *
 * PathGuard 是纯函数、无法解析符号链接；本类在真正访问前额外用 realpath
 * 确认目标仍位于 worktree 内，堵住"经符号链接逃逸"这条路。
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
      return abs  // 父目录尚不存在，稍后会 mkdir 创建，路径已由 PathGuard 校验
    }
    const rootReal = await realpath(this.dir)
    const rel2 = relative(rootReal, real)
    if (rel2.startsWith('..') || resolve(rootReal, rel2) !== real) {
      throw new GitOpError('PATH_TRAVERSAL', `路径经符号链接逃出 worktree: ${rel}`)
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

  /** 递归列出相对路径；跳过 .git 与 sparse 范围外的内容。 */
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

- [ ] **Step 4: 在 `GitRepo` 上暴露文件方法**

`src/api/git-repo.ts` 中追加：

```ts
// 顶部 import
import { FsGateway } from '../exec/fs-gateway'

// 类内新增字段与方法
  readonly #fs: FsGateway

  // 在 constructor 末尾追加：
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

- [ ] **Step 5: 运行测试**

Run: `bun test tests/integration/fs-gateway.test.ts && bun run typecheck`
Expected: 12 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/exec/fs-gateway.ts src/api/git-repo.ts tests/integration/fs-gateway.test.ts
git commit -m "feat: add sparse-scoped file gateway with symlink escape guard"
```

---

### Task 11: commit / fetch+merge 拆分的 pull / 基础 push

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

**注意：`pull` 必须拆成 store 级 `fetch`（走 mutex）+ worktree 级 merge（无锁）**，否则违反"`GitRepo` 永不加锁"的约束。本任务的 `pushBranch` 是**不含重试**的基础版本；重试与冲突状态机在计划 2/3 实现。

- [ ] **Step 1: 写失败的测试**

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

describe('基础操作', () => {
  test('commit 产出 sha，作者信息正确', async () => {
    await repo.writeFile('docs/new.md', 'hi')
    const r = await repo.commit({ message: 'add new doc' })
    expect(r.changed).toBe(true)
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/)
    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>'],
      { cwd: repo.dir, encoding: 'utf8' }).trim()
    expect(author).toBe('Bot <bot@example.com>')
  })

  test('无改动时 commit 返回 changed: false 且不报错', async () => {
    const r = await repo.commit({ message: 'nothing' })
    expect(r.changed).toBe(false)
  })

  test('commit 指定 paths 只提交这些文件', async () => {
    await repo.writeFile('docs/a1.md', '1')
    await repo.writeFile('docs/a2.md', '2')
    await repo.commit({ message: 'only a1', paths: ['docs/a1.md'] })
    const st = await repo.status()
    expect(st.untracked).toContain('docs/a2.md')
  })

  test('commit 的 paths 越出 sparse 范围时抛错', async () => {
    await repo.writeFile('docs/x.md', 'x')
    await expect(repo.commit({ message: 'm', paths: ['src/index.ts'] })).rejects.toThrow()
  })

  test('pushBranch 成功后远端出现该分支', async () => {
    await repo.writeFile('docs/p.md', 'p')
    await repo.commit({ message: 'push me' })
    const r = await repo.pushBranch()
    expect(r.ok).toBe(true)
    const refs = execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' })
    expect(refs).toContain('refs/heads/feat/ops')
  })

  test('远端分支被他人推进后再 push 返回 rejected', async () => {
    await repo.writeFile('docs/p.md', 'v1')
    await repo.commit({ message: 'v1' })
    expect((await repo.pushBranch()).ok).toBe(true)

    // 模拟他人在同一分支上再推一次
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

  test('pull 无冲突时把远端改动合进来', async () => {
    pushToRemote(root, bare, { 'docs/ext.md': 'from other' })
    const r = await repo.pull({ ref: 'origin/main' })
    expect(r.conflicted).toBe(false)
    expect(await repo.readFile('docs/ext.md')).toBe('from other')
  })

  test('pull 冲突时返回 conflicted: true 而不抛错', async () => {
    await repo.writeFile('docs/a.md', '# mine\n')
    await repo.commit({ message: 'mine' })
    pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' })
    const r = await repo.pull({ ref: 'origin/main' })
    expect(r.conflicted).toBe(true)
    expect((await repo.status()).conflicted).toContain('docs/a.md')
  })

  test('log 返回提交列表', async () => {
    await repo.writeFile('docs/l.md', 'l')
    await repo.commit({ message: 'log entry' })
    const entries = await repo.log({ limit: 1 })
    expect(entries[0]!.message).toBe('log entry')
    expect(entries[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  test('diffSummary 用 --name-only，返回改动文件名', async () => {
    await repo.writeFile('docs/d.md', 'd')
    await repo.commit({ message: 'd' })
    const files = await repo.diffSummary({ against: 'origin/main' })
    expect(files).toContain('docs/d.md')
  })

  test('listBranches 列出本地与远端分支', async () => {
    const branches = await store.listBranches()
    expect(branches).toContain('main')
  })

  test('deleteBranch 删除未被 checkout 的分支', async () => {
    const tmp = await store.createSession({ branch: 'feat/tmp', author: AUTHOR })
    await tmp.dispose()
    await store.deleteBranch('feat/tmp')
    expect(await store.listBranches()).not.toContain('feat/tmp')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test tests/integration/basic-ops.test.ts`
Expected: FAIL —— `repo.commit` 不存在

- [ ] **Step 3: 在 `GitRepo` 上实现操作方法**

`src/api/git-repo.ts` 追加：

```ts
// 顶部 import 追加
import { resolveWithin } from '../domain/path-guard'

export type LogEntry = { sha: string; author: string; date: string; message: string }

// GitRepo 类内追加：

  async commit(opts: { message: string; paths?: string[] }): Promise<{ sha: string; changed: boolean }> {
    this._assertLive()
    if (opts.paths) {
      // 越界路径必须在触碰 git 之前拒绝
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
   * pull = store 级 fetch（由调用方持锁）+ worktree 级 merge（无锁）。
   * 冲突不抛错，返回 conflicted: true，冲突详情由计划 2 的 getConflicts 提供。
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

  /** 只用 --name-only：partial clone 下需要内容的 diff 会触发惰性拉取 blob。 */
  async diffSummary(opts: { against?: string } = {}): Promise<string[]> {
    const target = opts.against ?? 'HEAD~1'
    const out = await this._git(['diff', '--name-only', `${target}...HEAD`])
    return out ? out.split('\n').filter(Boolean) : []
  }
```

同时在 `GitRepoDeps` 中加入 `fetch: () => Promise<void>`，并在 `RepoStore#createSession` / `attachSession` 构造 `GitRepo` 时传入 `fetch: () => this.fetch()`。

- [ ] **Step 4: 在 `RepoStore` 上实现分支方法**

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

- [ ] **Step 5: 运行测试**

Run: `bun test tests/integration/basic-ops.test.ts`
Expected: 12 tests PASS

- [ ] **Step 6: 运行全部测试、类型检查与构建**

Run: `bun test && bun run typecheck && bun run build`
Expected: 全部 PASS，`dist/` 下产出 `index.js`、`index.cjs`、`index.d.ts`

- [ ] **Step 7: Commit**

```bash
git add src tests
git commit -m "feat: add commit, pull, push and branch operations"
```

---

## 计划 1 完成标准

跑通以下端到端场景即视为本计划交付完成：

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

**尚未实现（由后续计划交付）：** 结构化冲突（计划 2）、push 被拒后自动 pull 重试（计划 2）、`withSession` / `publish`（计划 2）、GitHub PR 与 merge 模式（计划 3）、CI 矩阵与发布配置（计划 3）。
