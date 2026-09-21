import { afterEach, beforeEach, describe, expect, test } from 'vitest'
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

describe('the push state machine', () => {
  test('straightforward success', async () => {
    const repo = await store.createSession(SESSION('feat/p1'))
    await repo.writeFile('docs/x.md', 'x')
    await repo.commit({ message: 'x' })
    const r = await repo.push()
    expect(r).toEqual({ ok: true, pushed: true })
    await repo.dispose()
  })

  test('rejected, pulls automatically, no conflict, retry succeeds', async () => {
    const repo = await store.createSession(SESSION('feat/p2'))
    await repo.writeFile('docs/x.md', 'v1')
    await repo.commit({ message: 'v1' })
    expect((await repo.push()).ok).toBe(true)

    // Someone else pushed a non-conflicting change to the same branch
    pushToRemote(root, bare, { 'docs/other.md': 'other' },
      { branch: 'feat/p2', message: 'theirs' })

    await repo.writeFile('docs/x.md', 'v2')
    await repo.commit({ message: 'v2' })
    const r = await repo.push()
    expect(r.ok).toBe(true)
    // Their change has been merged in
    expect(await repo.readFile('docs/other.md')).toBe('other')
    await repo.dispose()
  })

  test('rejected, the pull conflicts, returns conflict and stops mid-merge', async () => {
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

  test('pushing again after resolving the conflicts succeeds', async () => {
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

  test('with retryOnReject: false a rejection returns rejected without pulling', async () => {
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
    // Nothing was pulled, so their file is absent
    expect(await repo.exists('docs/other.md')).toBe(false)
    await repo.dispose()
  })

  test('retryOnReject: false at the session level applies without repeating it per push', async () => {
    const repo = await store.createSession({ ...SESSION('feat/p6b'), retryOnReject: false })
    await repo.writeFile('docs/x.md', 'v1')
    await repo.commit({ message: 'v1' })
    await repo.push()
    pushToRemote(root, bare, { 'docs/other.md': 'o' },
      { branch: 'feat/p6b', message: 'theirs' })
    await repo.writeFile('docs/x.md', 'v2')
    await repo.commit({ message: 'v2' })

    const r = await repo.push()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('rejected')
    // No retry, so their file was never pulled in
    expect(await repo.exists('docs/other.md')).toBe(false)
    await repo.dispose()
  })

  test('a single push can override the session-level retryOnReject', async () => {
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

  test('asking for a pull request without a forge throws FORGE_NOT_INSTALLED', async () => {
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

describe('concurrent pushes', () => {
  test('twelve sessions pushing their own branches concurrently all succeed', async () => {
    const repos = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.createSession(SESSION(`feat/cp${i}`))),
    )
    await Promise.all(repos.map(async (r, i) => {
      await r.writeFile(`docs/cp${i}.md`, `c${i}`)
      await r.commit({ message: `c${i}` })
    }))
    const results = await Promise.all(repos.map((r) => r.push()))
    expect(results.every((r) => r.ok)).toBe(true)

    const refs = git(root, 'ls-remote', '--heads', bare)
    for (let i = 0; i < 12; i += 1) expect(refs).toContain(`refs/heads/feat/cp${i}`)
    await Promise.all(repos.map((r) => r.dispose()))
  })

  test('push does not write the shared .git/config and does not rely on upstream tracking', async () => {
    const repo = await store.createSession(SESSION('feat/noup'))
    await repo.writeFile('docs/x.md', 'x')
    await repo.commit({ message: 'x' })
    await repo.push()
    let value = 'PRESENT'
    try {
      value = git(store.storeDir, 'config', '--local', '--get', 'branch.feat/noup.remote').trim()
    } catch {
      value = 'ABSENT'
    }
    expect(value).toBe('ABSENT')
    await repo.dispose()
  })
})

describe('the withSession exit contract', () => {
  test('a normal return releases the worktree', async () => {
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

  test('a throwing callback still releases the worktree and rethrows the original error', async () => {
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

  test('still mid-merge on exit keeps the worktree and throws MERGE_IN_PROGRESS', async () => {
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
    // The refcount is released while the conflict state remains available to take over
    expect(store.activeSessions).toBe(0)
    const re = await store.attachSession(dir)
    expect((await re.getConflicts()).map((c) => c.path)).toContain('docs/a.md')
    await re.dispose()
    expect(existsSync(dir)).toBe(false)
  })

  test('resolving the conflicts inside the callback releases normally', async () => {
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
  test('one call for writing files, committing and pushing', async () => {
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

  test('a conflict returns the conflict result and keeps the worktree', async () => {
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

  test('a failure inside publish releases the worktree', async () => {
    await expect(store.publish({
      branch: 'feat/pub3', sparsePaths: ['docs'], author: AUTHOR,
      message: 'bad', files: [{ path: 'src/nope.ts', content: 'x' }],
    })).rejects.toThrow()
    expect(store.activeSessions).toBe(0)
  })
})
