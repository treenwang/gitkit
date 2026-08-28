import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { GitOpError } from '../../src/types'
import { cleanup, makeBareRemote, tempDir, urlOf } from '../helpers/fixtures'

let root: string, bare: string, repos: string

beforeEach(() => {
  root = tempDir()
  bare = makeBareRemote(root)
  repos = join(root, 'repos')
})
afterEach(() => cleanup(root))

describe('RepoManager', () => {
  test('首次 store() 执行 clone，目录落在预期布局', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(existsSync(join(store.storeDir, '.git'))).toBe(true)
    expect(existsSync(store.worktreeRoot)).toBe(true)
  })

  test('store 的工作区为空（--no-checkout）', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(readdirSync(store.storeDir).filter((e) => e !== '.git')).toEqual([])
  })

  test('store 设置了 extensions.worktreeConfig', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('extensions.worktreeConfig')).toBe('true')
  })

  test('保留 remote.origin.fetch refspec（证明未用 --bare）', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('remote.origin.fetch'))
      .toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  test('设置了 partial clone filter', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('remote.origin.partialclonefilter')).toBe('blob:none')
  })

  test('filter: false 时不启用 partial clone', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare), filter: false })
    expect(await store.configGet('remote.origin.partialclonefilter').catch(() => '')).toBe('')
  })

  test('第二次调用复用同一 store 实例，不重复 clone', async () => {
    const m = new RepoManager({ root: repos })
    const a = await m.store({ url: urlOf(bare) })
    expect(await m.store({ url: urlOf(bare) })).toBe(a)
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
    const s1 = await new RepoManager({ root: repos }).store({ url: urlOf(bare) })
    const s2 = await new RepoManager({ root: repos }).store({ url: urlOf(bare) })
    expect(s2.storeDir).toBe(s1.storeDir)
    expect(existsSync(join(s2.storeDir, '.git'))).toBe(true)
  })

  test('git 版本过低时 preflight 抛 GIT_VERSION_TOO_OLD', async () => {
    const m = new RepoManager({ root: repos, minGitVersion: { major: 99, minor: 0, patch: 0 } })
    try {
      await m.store({ url: urlOf(bare) })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('GIT_VERSION_TOO_OLD')
    }
  })

  test('gitPath 不存在时抛 GIT_NOT_FOUND', async () => {
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
    expect(existsSync(s.repoDir)).toBe(false)
  })

  test('有活跃 session 时 evict 拒绝删除', async () => {
    const m = new RepoManager({ root: repos })
    const s = await m.store({ url: urlOf(bare) })
    const repo = await s.createSession({
      branch: 'feat/hold', author: { name: 'B', email: 'b@e.com' },
    })
    expect(await m.evict(urlOf(bare))).toBe(false)
    expect(existsSync(s.repoDir)).toBe(true)
    await repo.dispose()
  })

  test('gc 跳过有活跃 session 的 store', async () => {
    const m = new RepoManager({ root: repos })
    const s = await m.store({ url: urlOf(bare) })
    const repo = await s.createSession({
      branch: 'feat/gc', author: { name: 'B', email: 'b@e.com' },
    })
    const r = await m.gc()
    expect(r.skippedActive).toContain(s.key)
    expect(r.removed).toEqual([])
    await repo.dispose()
    const r2 = await m.gc()
    expect(r2.removed).toContain(s.key)
  })
})
