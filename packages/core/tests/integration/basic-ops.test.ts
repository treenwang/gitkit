import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitRepo } from '../../src/api/git-repo'
import { cleanup, git, makeBareRemote, pushToRemote, tempDir, urlOf } from '../helpers/fixtures'

let root: string, bare: string, store: RepoStore, repo: GitRepo
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
  repo = await store.createSession({ branch: 'feat/ops', sparsePaths: ['docs'], author: AUTHOR })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

describe('basic operations', () => {
  test('commit produces a sha with the right author', async () => {
    await repo.writeFile('docs/new.md', 'hi')
    const r = await repo.commit({ message: 'add new doc' })
    expect(r.changed).toBe(true)
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(git(repo.dir, 'log', '-1', '--format=%an <%ae>').trim())
      .toBe('Bot <bot@example.com>')
  })

  test('commit with nothing changed returns changed: false without failing', async () => {
    const r = await repo.commit({ message: 'nothing' })
    expect(r.changed).toBe(false)
  })

  test('commit with paths commits only those files', async () => {
    await repo.writeFile('docs/a1.md', '1')
    await repo.writeFile('docs/a2.md', '2')
    await repo.commit({ message: 'only a1', paths: ['docs/a1.md'] })
    expect((await repo.status()).untracked).toContain('docs/a2.md')
  })

  test('commit throws when its paths leave the sparse range', async () => {
    await repo.writeFile('docs/x.md', 'x')
    await expect(repo.commit({ message: 'm', paths: ['src/index.ts'] })).rejects.toThrow()
  })

  test('after a successful pushBranch the remote has the branch', async () => {
    await repo.writeFile('docs/p.md', 'p')
    await repo.commit({ message: 'push me' })
    expect((await repo.pushBranch()).ok).toBe(true)
    expect(git(root, 'ls-remote', '--heads', bare)).toContain('refs/heads/feat/ops')
  })

  test('pushing after someone else moved the remote branch returns rejected', async () => {
    await repo.writeFile('docs/p.md', 'v1')
    await repo.commit({ message: 'v1' })
    expect((await repo.pushBranch()).ok).toBe(true)

    pushToRemote(root, bare, { 'docs/p.md': 'v2' }, { branch: 'feat/ops', message: 'v2' })

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
    const st = await repo.status()
    expect(st.conflicted).toContain('docs/a.md')
    expect(st.merging).toBe(true)
  })

  test('abortMerge returns to a clean state', async () => {
    await repo.writeFile('docs/a.md', '# mine\n')
    await repo.commit({ message: 'mine' })
    pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' })
    await repo.pull({ ref: 'origin/main' })
    await repo.abortMerge()
    const st = await repo.status()
    expect(st.merging).toBe(false)
    expect(st.conflicted).toEqual([])
    expect(await repo.readFile('docs/a.md')).toBe('# mine\n')
  })

  test('log returns the commit list', async () => {
    await repo.writeFile('docs/l.md', 'l')
    await repo.commit({ message: 'log entry' })
    const entries = await repo.log({ limit: 1 })
    expect(entries[0]!.message).toBe('log entry')
    expect(entries[0]!.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(entries[0]!.author).toBe('Bot')
  })

  test('diffSummary returns the changed file names', async () => {
    await repo.writeFile('docs/d.md', 'd')
    await repo.commit({ message: 'd' })
    expect(await repo.diffSummary({ against: 'origin/main' })).toContain('docs/d.md')
  })

  test('setSparsePaths takes effect incrementally', async () => {
    expect(await repo.exists('src/index.ts')).toBe(false)
    // The string shorthand and the object form can be mixed
    await repo.setSparsePaths(['docs', { path: 'src', requireChecks: true }])
    expect(await repo.readFile('src/index.ts')).toBe('export const x = 1\n')
    expect(repo.sparsePaths.map((p) => p.path)).toEqual(['docs', 'src'])
  })

  test('after setSparsePaths narrows the range, writes outside it are refused', async () => {
    await repo.setSparsePaths(['docs', 'src'])
    expect(await repo.exists('src/index.ts')).toBe(true)
    await repo.setSparsePaths(['docs'])
    await expect(repo.writeFile('src/x.ts', 'x')).rejects.toThrow()
  })

  test('listBranches lists local and remote branches', async () => {
    expect(await store.listBranches()).toContain('main')
  })

  test('deleteBranch removes a branch that is not checked out', async () => {
    const tmp = await store.createSession({ branch: 'feat/tmp', author: AUTHOR })
    await tmp.dispose()
    await store.deleteBranch('feat/tmp')
    expect(await store.listBranches()).not.toContain('feat/tmp')
  })
})
