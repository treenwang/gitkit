import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
    expect(existsSync(join(repo.dir, 'README.md'))).toBe(true)
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

  test('创建 sparse worktree 期间不发生全量 blob 拉取', async () => {
    const repo = await store.createSession({
      branch: 'feat/a', sparsePaths: ['docs'], author: AUTHOR,
    })
    const missing = git(store.storeDir, 'rev-list', '--objects', '--missing=print', 'HEAD')
    const missingCount = missing.split('\n').filter((l) => l.startsWith('?')).length
    // src/index.ts 与 assets/logo.bin 的 blob 应仍未被取回。
    // 注意 README.md 会被取回：cone 模式的 sparse-checkout 总是包含仓库根目录的文件。
    expect(missingCount).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(repo.dir, 'src'))).toBe(false)
    expect(existsSync(join(repo.dir, 'assets'))).toBe(false)
    await repo.dispose()
  })

  test('cone 模式下仓库根目录的文件仍会 checkout（git 固有行为）', async () => {
    const repo = await store.createSession({
      branch: 'feat/cone', sparsePaths: ['docs'], author: AUTHOR,
    })
    expect(existsSync(join(repo.dir, 'README.md'))).toBe(true)
    // 但本包的 PathGuard 仍拒绝对根文件的写入，避免越出声明的范围
    expect(await codeOf(repo.writeFile('README.md', 'x'))).toBe('PATH_OUTSIDE_SPARSE')
    await repo.dispose()
  })

  test('同一分支在两个 session 中 checkout → BRANCH_IN_USE', async () => {
    const a = await store.createSession({ branch: 'feat/dup', author: AUTHOR })
    expect(await codeOf(store.createSession({ branch: 'feat/dup', author: AUTHOR })))
      .toBe('BRANCH_IN_USE')
    await a.dispose()
  })

  test("branchMode: 'create' 遇已存在分支 → BRANCH_EXISTS", async () => {
    const a = await store.createSession({ branch: 'feat/x', author: AUTHOR })
    await a.dispose()
    expect(await codeOf(
      store.createSession({ branch: 'feat/x', branchMode: 'create', author: AUTHOR }),
    )).toBe('BRANCH_EXISTS')
  })

  test("branchMode: 'reuse' 遇不存在分支 → BRANCH_NOT_FOUND", async () => {
    expect(await codeOf(
      store.createSession({ branch: 'feat/nope', branchMode: 'reuse', author: AUTHOR }),
    )).toBe('BRANCH_NOT_FOUND')
  })

  test('默认 createOrReuse：不存在则建，存在则复用', async () => {
    const a = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    await a.dispose()
    const b = await store.createSession({ branch: 'feat/r', author: AUTHOR })
    expect(b.branch).toBe('feat/r')
    await b.dispose()
  })

  test('复用远端已存在的分支', async () => {
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
    expect(await codeOf(repo.status())).toBe('WORKTREE_DISPOSED')
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
    expect(list.find((s) => s.dir === a.dir)!.branch).toBe('feat/l')
    await a.dispose()
  })

  test('每个 session 有独立的 author，互不覆盖', async () => {
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

    // attachSession 也应恢复各自的 author，而不是最后一个写入者
    const ra = await store.attachSession(a.dir)
    await ra.writeFile('x2.md', 'a2'); await ra.commit({ message: 'a2' })
    expect(git(a.dir, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Alice <alice@e.com>')
    await ra.dispose(); await b.dispose()
  })

  test('author 写入 worktree 私有配置，不污染共享 .git/config', async () => {
    const a = await store.createSession({
      branch: 'feat/cfg', author: { name: 'Alice', email: 'alice@e.com' },
    })
    // 键不存在时 git config 以退出码 1 结束 —— 这正是期望的结果
    let sharedValue = 'PRESENT'
    try {
      sharedValue = git(store.storeDir, 'config', '--local', '--get-all', 'user.name').trim()
    } catch {
      sharedValue = 'ABSENT'
    }
    expect(sharedValue).toBe('ABSENT')
    await a.dispose()
  })

  test('并发创建 20 个 session 全部成功且互不干扰', async () => {
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

  test('并发在各自 session 中提交互不干扰', async () => {
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
      // 每个 worktree 只应看到自己写的文件
      expect(await r.exists(`docs/w${(i + 1) % 6}.md`)).toBe(false)
    }
    await Promise.all(repos.map((r) => r.dispose()))
  })

  test('attachSession 可重新接管已存在的 worktree', async () => {
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

  test('pruneOrphans 回收无主目录', async () => {
    const orphan = join(store.worktreeRoot, 'orphan-xyz')
    mkdirSync(join(orphan, 'sub'), { recursive: true })
    writeFileSync(join(orphan, 'sub', 'f.txt'), 'x')
    const removed = await store.pruneOrphans()
    expect(removed).toContain(orphan)
    expect(existsSync(orphan)).toBe(false)
  })

  test('pruneOrphans 不误删活跃 worktree', async () => {
    const a = await store.createSession({ branch: 'feat/keep', author: AUTHOR })
    const removed = await store.pruneOrphans()
    expect(removed).not.toContain(a.dir)
    expect(existsSync(a.dir)).toBe(true)
    await a.dispose()
  })
})
