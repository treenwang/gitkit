import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitOpError } from '../../src/types'
import { cleanup, git, makeBareRemote, tempDir, urlOf } from '../helpers/fixtures'

let root: string, bare: string, store: RepoStore
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
})
afterEach(() => cleanup(root))

async function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'NO_THROW', (e: GitOpError) => e.code)
}

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
    expect(existsSync(join(repo.dir, 'README.md'))).toBe(true)
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

  test('creating a sparse worktree does not fetch every blob', async () => {
    const repo = await store.createSession({
      branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR,
    })
    const missing = git(store.storeDir, 'rev-list', '--objects', '--missing=print', 'HEAD')
    const missingCount = missing.split('\n').filter((l) => l.startsWith('?')).length
    // The blobs for src/index.ts and assets/logo.bin should still be missing.
    // README.md does get fetched: cone-mode sparse checkout always includes the
    // files at the repository root.
    expect(missingCount).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(repo.dir, 'src'))).toBe(false)
    expect(existsSync(join(repo.dir, 'assets'))).toBe(false)
    await repo.dispose()
  })

  test('cone mode still checks out the repository root files - that is git behaviour', async () => {
    const repo = await store.createSession({
      branch: 'feat/cone', sparsePaths: ['docs'], author: AUTHOR,
    })
    expect(existsSync(join(repo.dir, 'README.md'))).toBe(true)
    // PathGuard still refuses writes to those root files, keeping inside the declared range
    expect(await codeOf(repo.writeFile('README.md', 'x'))).toBe('PATH_OUTSIDE_SPARSE')
    await repo.dispose()
  })

  test('checking one branch out in two sessions gives BRANCH_IN_USE', async () => {
    const a = await store.createSession({ branch: 'feat/dup', author: AUTHOR })
    expect(await codeOf(store.createSession({ branch: 'feat/dup', author: AUTHOR })))
      .toBe('BRANCH_IN_USE')
    await a.dispose()
  })

  test("branchMode: 'create' on an existing branch gives BRANCH_EXISTS", async () => {
    const a = await store.createSession({ branch: 'feat/x', author: AUTHOR })
    await a.dispose()
    expect(await codeOf(
      store.createSession({ branch: 'feat/x', branchMode: 'create', author: AUTHOR }),
    )).toBe('BRANCH_EXISTS')
  })

  test("branchMode: 'reuse' on a missing branch gives BRANCH_NOT_FOUND", async () => {
    expect(await codeOf(
      store.createSession({ branch: 'feat/nope', branchMode: 'reuse', author: AUTHOR }),
    )).toBe('BRANCH_NOT_FOUND')
  })

  test('createOrReuse, the default: create when missing, reuse when present', async () => {
    const a = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    await a.dispose()
    const b = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    expect(b.branch).toBe('feat/r')
    await b.dispose()
  })

  test('reuses a branch that already exists on the remote', async () => {
    const a = await store.createSession({ branch: 'feat/remote', author: AUTHOR })
    await a.writeFile('docs/r.md', 'r')
    await a.commit({ message: 'r' })
    await a.pushBranch()
    await a.dispose()
    await store.deleteBranch('feat/remote')

    const b = await store.createSession({ branch: 'feat/remote', author: AUTHOR })
    expect(await b.readFile('docs/r.md')).toBe('r')
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
    expect(await codeOf(repo.status())).toBe('WORKTREE_DISPOSED')
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
    expect(list.find((s) => s.dir === a.dir)!.branch).toBe('feat/l')
    await a.dispose()
  })

  test('each session has its own author and they do not overwrite each other', async () => {
    const a = await store.createSession({
      branch: 'feat/au1', author: { name: 'Alice', email: 'alice@e.com' },
    })
    const b = await store.createSession({
      branch: 'feat/au2', author: { name: 'Bob', email: 'bob@e.com' },
    })
    await a.writeFile('x.md', 'a'); await a.commit({ message: 'a' })
    await b.writeFile('y.md', 'b'); await b.commit({ message: 'b' })
    expect(git(a.dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Alice <alice@e.com>')
    expect(git(b.dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Bob <bob@e.com>')

    // attachSession should restore each session's own author, not the last writer's
    const ra = await store.attachSession(a.dir)
    await ra.writeFile('x2.md', 'a2'); await ra.commit({ message: 'a2' })
    expect(git(a.dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Alice <alice@e.com>')
    await ra.dispose(); await b.dispose()
  })

  test('the author goes into the worktree-private config and leaves the shared .git/config alone', async () => {
    const a = await store.createSession({
      branch: 'feat/cfg', author: { name: 'Alice', email: 'alice@e.com' },
    })
    // git config exits 1 when the key is absent, which is exactly what we want here
    let sharedValue = 'PRESENT'
    try {
      sharedValue = git(store.storeDir, 'config', '--local', '--get-all', 'user.name').trim()
    } catch {
      sharedValue = 'ABSENT'
    }
    expect(sharedValue).toBe('ABSENT')
    await a.dispose()
  })

  test('twenty sessions created concurrently all succeed without interfering', async () => {
    const repos = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.createSession({ branch: `feat/p${i}`, sparsePaths: ['docs'], author: AUTHOR }),
      ),
    )
    expect(new Set(repos.map((r) => r.dir)).size).toBe(20)
    for (const r of repos) expect(existsSync(join(r.dir, 'docs', 'a.md'))).toBe(true)
    await Promise.all(repos.map((r) => r.dispose()))
    expect(store.activeSessions).toBe(0)
  })

  test('committing concurrently in separate sessions does not interfere', async () => {
    const repos = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.createSession({ branch: `feat/w${i}`, sparsePaths: ['docs'], author: AUTHOR }),
      ),
    )
    await Promise.all(repos.map(async (r, i) => {
      await r.writeFile(`docs/w${i}.md`, `w${i}`)
      await r.commit({ message: `w${i}` })
    }))
    for (const [i, r] of repos.entries()) {
      const log = await r.log({ limit: 1 })
      expect(log[0]!.message).toBe(`w${i}`)
      // Each worktree should see only the file it wrote
      expect(await r.exists(`docs/w${(i + 1) % 6}.md`)).toBe(false)
    }
    await Promise.all(repos.map((r) => r.dispose()))
  })

  test('attachSession can take an existing worktree back over', async () => {
    const a = await store.createSession({
      branch: 'feat/at', sparsePaths: ['docs'], author: AUTHOR,
    })
    const dir = a.dir
    const b = await store.attachSession(dir)
    expect(b.dir).toBe(dir)
    expect(b.branch).toBe('feat/at')
    expect(b.sparsePaths.map((s) => s.path)).toEqual(['docs'])
    await b.dispose()
    await a.dispose()
  })

  test('attachSession refuses a directory that belongs to another store', async () => {
    expect(await codeOf(store.attachSession(join(root, 'not-a-worktree'))))
      .toBe('INVALID_ARGUMENT')
    const outside = join(root, 'outside-wt')
    mkdirSync(outside, { recursive: true })
    expect(await codeOf(store.attachSession(outside))).toBe('INVALID_ARGUMENT')
  })

  test('pruneOrphans reclaims orphaned directories', async () => {
    const orphan = join(store.worktreeRoot, 'orphan-xyz')
    mkdirSync(join(orphan, 'sub'), { recursive: true })
    writeFileSync(join(orphan, 'sub', 'f.txt'), 'x')
    const removed = await store.pruneOrphans()
    expect(removed).toContain(orphan)
    expect(existsSync(orphan)).toBe(false)
  })

  test('pruneOrphans does not delete a live worktree by mistake', async () => {
    const a = await store.createSession({ branch: 'feat/keep', author: AUTHOR })
    const removed = await store.pruneOrphans()
    expect(removed).not.toContain(a.dir)
    expect(existsSync(a.dir)).toBe(true)
    await a.dispose()
  })
})
