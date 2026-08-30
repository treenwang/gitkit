import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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

  test('store 的 HEAD 是游离的，不占用默认分支', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    // storeDir 只是共享对象库（--no-checkout，工作区为空）。让它的 HEAD 停在 main 上，
    // 会让 git 认为 main 已被 checkout，于是没有任何 session 能开在默认分支上。
    expect(await store.configGet('remote.origin.fetch')).toBeTruthy()
    const head = await store.currentHead()
    expect(head).toBe('HEAD')
  })

  test('默认分支可以开 session（HEAD 游离的直接后果）', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    const repo = await store.createSession({
      branch: 'main', branchMode: 'reuse',
      author: { name: 'T', email: 't@x' },
      sparsePaths: [{ path: 'docs' }],
    })
    expect(existsSync(join(repo.dir, 'docs', 'a.md'))).toBe(true)
    await repo.dispose()
  })

  test('同一仓库、不同调用者的 token，共用同一个 store', async () => {
    // 共享对象库天生是多租户的：dedup 的全部意义就是多个调用者共用一份。把某一个调用者的
    // 凭据算进 store 的身份，等于让第二个用户永远无法打开同一个仓库。
    // 访问控制属于调用方（它知道「谁」），不属于这里（它只知道「哪个仓库」）。
    const m = new RepoManager({ root: repos })
    const first = await m.store({ url: urlOf(bare), auth: { token: 'token-of-user-a' } })
    const second = await m.store({ url: urlOf(bare), auth: { token: 'token-of-user-b' } })
    expect(second).toBe(first)
  })

  test('配置上的实质差异仍然被拒绝', async () => {
    const m = new RepoManager({ root: repos })
    await m.store({ url: urlOf(bare) })
    // filter 决定磁盘上的对象集合，两个调用者不能各要一份
    await expect(m.store({ url: urlOf(bare), filter: false })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  /** 一个记录 argv 的 git 包装脚本。token 在日志与错误信息里都被脱敏，所以想验证「这次调用
   *  确实带上了这个 token」，只能看真正交给 git 的参数。 */
  function recordingGit(): { gitPath: string; argvOf: () => string[][] } {
    const bin = join(root, 'git-spy.sh')
    const logFile = join(root, 'git-spy.log')
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logFile)}\nexec git "$@"\n`)
    chmodSync(bin, 0o755)
    return {
      gitPath: bin,
      argvOf: () =>
        (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
          .split('\n').filter(Boolean).map((l) => l.split(' ')),
    }
  }

  const hasHeaderFor = (argv: string[][], token: string) => {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    return argv.some((a) => a.some((w) => w.includes(basic)))
  }

  test('fetch 用本次调用者的 token，而不是建 store 时那个', async () => {
    const spy = recordingGit()
    const m = new RepoManager({ root: repos, gitPath: spy.gitPath })
    const store = await m.store({ url: urlOf(bare), auth: { token: 'store-token' } })
    await store.fetch(undefined, { token: 'caller-token' })
    const argv = spy.argvOf()
    const fetches = argv.filter((a) => a.includes('fetch'))
    expect(fetches.length).toBeGreaterThan(0)
    expect(hasHeaderFor(fetches, 'caller-token')).toBe(true)
    expect(hasHeaderFor(fetches, 'store-token')).toBe(false)
  })

  test('createSession 用本次调用者的 token', async () => {
    const spy = recordingGit()
    const m = new RepoManager({ root: repos, gitPath: spy.gitPath })
    const store = await m.store({ url: urlOf(bare), auth: { token: 'store-token' } })
    const repo = await store.createSession({
      branch: 'main', branchMode: 'reuse', token: 'caller-token',
      author: { name: 'T', email: 't@x' }, sparsePaths: [{ path: 'docs' }],
    })
    expect(existsSync(join(repo.dir, 'docs', 'a.md'))).toBe(true)
    const checkouts = spy.argvOf().filter((a) => a.includes('checkout') || a.includes('worktree'))
    expect(hasHeaderFor(checkouts, 'caller-token')).toBe(true)
    await repo.dispose()
  })

  test('defaultBranch 给出默认分支的短名', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.defaultBranch()).toBe('main')
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

  test('同一 URL 用不同配置再次 store() 时报错，而非静默沿用', async () => {
    const m = new RepoManager({ root: repos })
    await m.store({ url: urlOf(bare) })
    const code = await m
      .store({ url: urlOf(bare), github: { token: 'T' } })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('INVALID_ARGUMENT')
  })

  test('配置相同时重复调用仍复用', async () => {
    const m = new RepoManager({ root: repos })
    const a = await m.store({ url: urlOf(bare), depth: undefined })
    expect(await m.store({ url: urlOf(bare) })).toBe(a)
  })

  test('evict 后可用新配置重新 store()', async () => {
    const m = new RepoManager({ root: repos })
    await m.store({ url: urlOf(bare) })
    await m.evict(urlOf(bare))
    const s2 = await m.store({ url: urlOf(bare), github: { token: 'T' } })
    expect(s2.forge).toBeDefined()
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
