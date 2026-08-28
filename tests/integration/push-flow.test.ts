import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitOpError } from '../../src/types'
import {
  cleanup, git, makeBareRemote, pushToRemote, tempDir, urlOf,
} from '../helpers/fixtures'

let root: string, bare: string, store: RepoStore
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
})
afterEach(() => cleanup(root))

const SESSION = (branch: string) => ({
  branch, sparsePaths: ['docs'], author: AUTHOR,
})

describe('push 状态机', () => {
  test('直接成功', async () => {
    const repo = await store.createSession(SESSION('feat/p1'))
    await repo.writeFile('docs/x.md', 'x')
    await repo.commit({ message: 'x' })
    const r = await repo.push()
    expect(r).toEqual({ ok: true, pushed: true })
    await repo.dispose()
  })

  test('被拒 → 自动 pull → 无冲突 → 重试成功', async () => {
    const repo = await store.createSession(SESSION('feat/p2'))
    await repo.writeFile('docs/x.md', 'v1')
    await repo.commit({ message: 'v1' })
    expect((await repo.push()).ok).toBe(true)

    // 别人在同一分支上推了不冲突的改动
    pushToRemote(root, bare, { 'docs/other.md': 'other' },
      { branch: 'feat/p2', message: 'theirs' })

    await repo.writeFile('docs/x.md', 'v2')
    await repo.commit({ message: 'v2' })
    const r = await repo.push()
    expect(r.ok).toBe(true)
    // 对方的改动已被合进来
    expect(await repo.readFile('docs/other.md')).toBe('other')
    await repo.dispose()
  })

  test('被拒 → pull 有冲突 → 返回 conflict 并停在 merge 中', async () => {
    const repo = await store.createSession(SESSION('feat/p3'))
    await repo.writeFile('docs/x.md', 'v1')
    await repo.commit({ message: 'v1' })
    await repo.push()

    pushToRemote(root, bare, { 'docs/x.md': 'theirs' },
      { branch: 'feat/p3', message: 'theirs' })

    await repo.writeFile('docs/x.md', 'ours')
    await repo.commit({ message: 'ours' })
    const r = await repo.push()

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.reason).toBe('conflict')
    if (r.reason !== 'conflict') throw new Error('unreachable')
    expect(r.conflicts.map((c) => c.path)).toContain('docs/x.md')
    expect(r.worktreeDir).toBe(repo.dir)
    expect((await repo.status()).merging).toBe(true)
    await repo.dispose()
  })

  test('解完冲突后再 push 成功', async () => {
    const repo = await store.createSession(SESSION('feat/p4'))
    await repo.writeFile('docs/x.md', 'v1')
    await repo.commit({ message: 'v1' })
    await repo.push()
    pushToRemote(root, bare, { 'docs/x.md': 'theirs' },
      { branch: 'feat/p4', message: 'theirs' })
    await repo.writeFile('docs/x.md', 'ours')
    await repo.commit({ message: 'ours' })
    const r = await repo.push()
    expect(r.ok).toBe(false)

    await repo.resolveConflicts([{ path: 'docs/x.md', take: 'ours' }])
    await repo.commit({ message: 'merged' })
    expect((await repo.push()).ok).toBe(true)
    await repo.dispose()
  })

  test('retryOnReject: false 时被拒直接返回 rejected，不 pull', async () => {
    const repo = await store.createSession(SESSION('feat/p5'))
    await repo.writeFile('docs/x.md', 'v1')
    await repo.commit({ message: 'v1' })
    await repo.push()
    pushToRemote(root, bare, { 'docs/other.md': 'o' },
      { branch: 'feat/p5', message: 'theirs' })
    await repo.writeFile('docs/x.md', 'v2')
    await repo.commit({ message: 'v2' })

    const r = await repo.push({ retryOnReject: false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('rejected')
    // 没有 pull，所以对方的文件不在
    expect(await repo.exists('docs/other.md')).toBe(false)
    await repo.dispose()
  })

  test('session 级 retryOnReject 可被单次 push 覆盖', async () => {
    const repo = await store.createSession({ ...SESSION('feat/p6'), retryOnReject: false })
    await repo.writeFile('docs/x.md', 'v1')
    await repo.commit({ message: 'v1' })
    await repo.push()
    pushToRemote(root, bare, { 'docs/other.md': 'o' },
      { branch: 'feat/p6', message: 'theirs' })
    await repo.writeFile('docs/x.md', 'v2')
    await repo.commit({ message: 'v2' })
    expect((await repo.push({ retryOnReject: true })).ok).toBe(true)
    await repo.dispose()
  })

  test('未配置 forge 时请求建 PR 抛 FORGE_NOT_INSTALLED', async () => {
    const repo = await store.createSession(SESSION('feat/p7'))
    await repo.writeFile('docs/x.md', 'x')
    await repo.commit({ message: 'x' })
    const code = await repo
      .push({ createPR: { title: 't', base: 'main' } })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('FORGE_NOT_INSTALLED')
    await repo.dispose()
  })
})

describe('withSession 退出契约', () => {
  test('正常返回时释放 worktree', async () => {
    let dir = ''
    const out = await store.withSession(SESSION('feat/w1'), async (repo) => {
      dir = repo.dir
      await repo.writeFile('docs/w.md', 'w')
      await repo.commit({ message: 'w' })
      return 'done'
    })
    expect(out).toBe('done')
    expect(existsSync(dir)).toBe(false)
    expect(store.activeSessions).toBe(0)
  })

  test('回调抛错时也释放 worktree，并原样抛出原始错误', async () => {
    let dir = ''
    await expect(
      store.withSession(SESSION('feat/w2'), async (repo) => {
        dir = repo.dir
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(dir)).toBe(false)
    expect(store.activeSessions).toBe(0)
  })

  test('退出时仍在 merge 中 → 保留 worktree 并抛 MERGE_IN_PROGRESS', async () => {
    let dir = ''
    const code = await store
      .withSession(SESSION('feat/w3'), async (repo) => {
        dir = repo.dir
        await repo.writeFile('docs/a.md', '# ours\n')
        await repo.commit({ message: 'ours' })
        pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' }, { message: 'theirs' })
        await repo.pull({ ref: 'origin/main' })
      })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)

    expect(code).toBe('MERGE_IN_PROGRESS')
    expect(existsSync(dir)).toBe(true)
    // 引用计数已释放，冲突现场仍可被接管
    expect(store.activeSessions).toBe(0)
    const re = await store.attachSession(dir)
    expect((await re.getConflicts()).map((c) => c.path)).toContain('docs/a.md')
    await re.dispose()
    expect(existsSync(dir)).toBe(false)
  })

  test('在回调内解完冲突则正常释放', async () => {
    let dir = ''
    await store.withSession(SESSION('feat/w4'), async (repo) => {
      dir = repo.dir
      await repo.writeFile('docs/a.md', '# ours\n')
      await repo.commit({ message: 'ours' })
      pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' }, { message: 'theirs' })
      await repo.pull({ ref: 'origin/main' })
      await repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])
      await repo.commit({ message: 'merged' })
    })
    expect(existsSync(dir)).toBe(false)
    expect(store.activeSessions).toBe(0)
  })
})

describe('publish', () => {
  test('一站式写文件 + commit + push', async () => {
    const r = await store.publish({
      branch: 'feat/pub1',
      sparsePaths: ['docs'],
      author: AUTHOR,
      message: 'publish docs',
      files: [{ path: 'docs/pub.md', content: 'published' }],
    })
    expect(r).toEqual({ ok: true, pushed: true })
    expect(git(root, 'ls-remote', '--heads', bare)).toContain('refs/heads/feat/pub1')
    expect(store.activeSessions).toBe(0)
  })

  test('冲突时返回 conflict 结果并保留 worktree', async () => {
    await store.publish({
      branch: 'feat/pub2', sparsePaths: ['docs'], author: AUTHOR,
      message: 'v1', files: [{ path: 'docs/x.md', content: 'v1' }],
    })
    pushToRemote(root, bare, { 'docs/x.md': 'theirs' },
      { branch: 'feat/pub2', message: 'theirs' })

    const r = await store.publish({
      branch: 'feat/pub2', sparsePaths: ['docs'], author: AUTHOR,
      message: 'v2', files: [{ path: 'docs/x.md', content: 'ours' }],
    })
    expect(r.ok).toBe(false)
    if (r.ok || r.reason !== 'conflict') throw new Error('unreachable')
    expect(existsSync(r.worktreeDir)).toBe(true)
    expect(store.activeSessions).toBe(0)

    const re = await store.attachSession(r.worktreeDir)
    await re.resolveConflicts([{ path: 'docs/x.md', take: 'ours' }])
    await re.commit({ message: 'merged' })
    expect((await re.push()).ok).toBe(true)
    await re.dispose()
  })

  test('publish 内部出错时释放 worktree', async () => {
    await expect(store.publish({
      branch: 'feat/pub3', sparsePaths: ['docs'], author: AUTHOR,
      message: 'bad', files: [{ path: 'src/nope.ts', content: 'x' }],
    })).rejects.toThrow()
    expect(store.activeSessions).toBe(0)
  })
})
