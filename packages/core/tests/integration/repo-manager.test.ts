import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
afterEach(() => {
  delete process.env.GIT_TRACE2_EVENT
  cleanup(root)
})

describe('RepoManager', () => {
  test('the first store() clones and lands in the expected layout', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(existsSync(join(store.storeDir, '.git'))).toBe(true)
    expect(existsSync(store.worktreeRoot)).toBe(true)
  })

  test('the store working tree is empty, thanks to --no-checkout', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(readdirSync(store.storeDir).filter((e) => e !== '.git')).toEqual([])
  })

  test('the store sets extensions.worktreeConfig', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('extensions.worktreeConfig')).toBe('true')
  })

  test('the store HEAD is detached and does not hold the default branch', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    // storeDir is nothing but the shared object database (--no-checkout, empty
    // working tree). Leaving its HEAD on main makes git consider main checked
    // out, so no session could ever open on the default branch.
    expect(await store.configGet('remote.origin.fetch')).toBeTruthy()
    const head = await store.currentHead()
    expect(head).toBe('HEAD')
  })

  test('a session can open on the default branch, which follows directly from the detached HEAD', async () => {
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

  test('the same repository with different callers tokens shares one store', async () => {
    // A shared object database is inherently multi-tenant: the whole point of
    // dedup is that several callers share one copy. Folding one caller's
    // credentials into the store's identity would lock the second user out of
    // that repository forever. Access control belongs to the caller, which
    // knows *who*; this layer only knows *which repository*.
    const m = new RepoManager({ root: repos })
    const first = await m.store({ url: urlOf(bare), auth: { token: 'token-of-user-a' } })
    const second = await m.store({ url: urlOf(bare), auth: { token: 'token-of-user-b' } })
    expect(second).toBe(first)
  })

  test('a substantive configuration difference is still refused', async () => {
    const m = new RepoManager({ root: repos })
    await m.store({ url: urlOf(bare) })
    // filter decides which objects land on disk, so two callers cannot each have their own
    await expect(m.store({ url: urlOf(bare), filter: false })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  })

  /** Record the argv git actually receives. The token is scrubbed from logs and
   *  error messages alike, so the only way to verify "this call really carried
   *  that token" is to look at the arguments themselves.
   *
   *  This uses git's own trace2: every git process appends one JSON line on
   *  startup whose argv is the full, unscrubbed command line. The previous
   *  approach wrote an sh wrapper and used it as gitPath, but running tests in
   *  parallel made macOS stall exec of that script for tens of seconds - the
   *  process sat at _dyld_start without executing a single instruction - and the
   *  tests were killed by their own timeout. trace2 needs no extra process. */
  function recordingGit(): { argvOf: () => string[][] } {
    const logFile = join(root, 'git-trace2.jsonl')
    // GitExecutor passes process.env through to the child wholesale, which is how git learns where to trace.
    process.env.GIT_TRACE2_EVENT = logFile
    return {
      argvOf: () =>
        (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')
          .split('\n').filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
          .filter((e) => e.event === 'start' && e.argv)
          .map((e) => e.argv!),
    }
  }

  const hasHeaderFor = (argv: string[][], token: string) => {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    return argv.some((a) => a.some((w) => w.includes(basic)))
  }

  test('fetch uses this caller token rather than the one the store was built with', async () => {
    const spy = recordingGit()
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare), auth: { token: 'store-token' } })
    await store.fetch(undefined, { token: 'caller-token' })
    const argv = spy.argvOf()
    const fetches = argv.filter((a) => a.includes('fetch'))
    expect(fetches.length).toBeGreaterThan(0)
    expect(hasHeaderFor(fetches, 'caller-token')).toBe(true)
    expect(hasHeaderFor(fetches, 'store-token')).toBe(false)
  })

  test('createSession uses this caller token', async () => {
    const spy = recordingGit()
    const m = new RepoManager({ root: repos })
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

  test('defaultBranch gives the short name of the default branch', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.defaultBranch()).toBe('main')
  })

  test('the remote.origin.fetch refspec is kept, proving --bare was not used', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('remote.origin.fetch'))
      .toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  test('the partial clone filter is set', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare) })
    expect(await store.configGet('remote.origin.partialclonefilter')).toBe('blob:none')
  })

  test('filter: false leaves partial clone off', async () => {
    const m = new RepoManager({ root: repos })
    const store = await m.store({ url: urlOf(bare), filter: false })
    expect(await store.configGet('remote.origin.partialclonefilter').catch(() => '')).toBe('')
  })

  test('a second call reuses the same store instance instead of cloning again', async () => {
    const m = new RepoManager({ root: repos })
    const a = await m.store({ url: urlOf(bare) })
    expect(await m.store({ url: urlOf(bare) })).toBe(a)
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
    const s1 = await new RepoManager({ root: repos }).store({ url: urlOf(bare) })
    const s2 = await new RepoManager({ root: repos }).store({ url: urlOf(bare) })
    expect(s2.storeDir).toBe(s1.storeDir)
    expect(existsSync(join(s2.storeDir, '.git'))).toBe(true)
  })

  test('preflight throws GIT_VERSION_TOO_OLD when git is too old', async () => {
    const m = new RepoManager({ root: repos, minGitVersion: { major: 99, minor: 0, patch: 0 } })
    try {
      await m.store({ url: urlOf(bare) })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('GIT_VERSION_TOO_OLD')
    }
  })

  test('a missing gitPath throws GIT_NOT_FOUND', async () => {
    const m = new RepoManager({ root: repos, gitPath: '/nonexistent/git' })
    try {
      await m.store({ url: urlOf(bare) })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('GIT_NOT_FOUND')
    }
  })

  test('calling store() again for the same URL with a different configuration fails rather than silently reusing it', async () => {
    const m = new RepoManager({ root: repos })
    await m.store({ url: urlOf(bare) })
    const code = await m
      .store({ url: urlOf(bare), github: { token: 'T' } })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('INVALID_ARGUMENT')
  })

  test('repeated calls with the same configuration still reuse', async () => {
    const m = new RepoManager({ root: repos })
    const a = await m.store({ url: urlOf(bare), depth: undefined })
    expect(await m.store({ url: urlOf(bare) })).toBe(a)
  })

  test('after evict, store() can be called again with a new configuration', async () => {
    const m = new RepoManager({ root: repos })
    await m.store({ url: urlOf(bare) })
    await m.evict(urlOf(bare))
    const s2 = await m.store({ url: urlOf(bare), github: { token: 'T' } })
    expect(s2.forge).toBeDefined()
  })

  test('evict removes the store directory', async () => {
    const m = new RepoManager({ root: repos })
    const s = await m.store({ url: urlOf(bare) })
    expect(await m.evict(urlOf(bare))).toBe(true)
    expect(existsSync(s.repoDir)).toBe(false)
  })

  test('evict refuses to delete while sessions are active', async () => {
    const m = new RepoManager({ root: repos })
    const s = await m.store({ url: urlOf(bare) })
    const repo = await s.createSession({
      branch: 'feat/hold', author: { name: 'B', email: 'b@e.com' },
    })
    expect(await m.evict(urlOf(bare))).toBe(false)
    expect(existsSync(s.repoDir)).toBe(true)
    await repo.dispose()
  })

  test('gc skips a store with active sessions', async () => {
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
