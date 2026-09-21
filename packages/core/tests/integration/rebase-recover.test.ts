import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitRepo } from '../../src/api/git-repo'
import type { GitOpError } from '../../src/types'
import { cleanup, makeBareRemote, pushToRemote, tempDir, urlOf } from '../helpers/fixtures'

let root: string, bare: string, store: RepoStore, repo: GitRepo
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
  repo = await store.createSession({ branch: 'feat/rb', sparsePaths: ['docs'], author: AUTHOR })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'NO_THROW', (e: GitOpError) => e.code)
}

/** Build a local commit that conflicts with origin/main. */
async function diverge(): Promise<void> {
  await repo.writeFile('docs/a.md', '# ours\n')
  await repo.commit({ message: 'ours' })
  pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' }, { message: 'theirs' })
}

describe('rebase conflicts', () => {
  test('a rebase conflict counts as an operation in progress, even with no MERGE_HEAD', async () => {
    await diverge()
    const r = await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    expect(r.conflicted).toBe(true)

    const st = await repo.status()
    expect(st.operation).toBe('rebase')
    expect(st.merging).toBe(true)
    expect(st.conflicted).toContain('docs/a.md')
  })

  test('commit during a rebase throws and points at continueRebase', async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])
    expect(await codeOf(repo.commit({ message: 'x' }))).toBe('INVALID_ARGUMENT')
  })

  test("during a rebase 'ours' is normalized to our change, since git's stages 2 and 3 are reversed", async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    const c = (await repo.getConflicts()).find((x) => x.path === 'docs/a.md')!
    expect(c.sidesSwapped).toBe(true)
    expect(c.ours!.content).toBe('# ours\n')      // the change on our branch
    expect(c.theirs!.content).toBe('# theirs\n')  // the upstream being rebased onto
    expect(c.hunks![0]!.ourLines).toEqual(['# ours'])
    expect(c.hunks![0]!.theirLines).toEqual(['# theirs'])
  })

  test("resolveByHunks during a rebase treats 'ours' as our change too", async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.resolveByHunks('docs/a.md', ['ours'])
    expect(await repo.readFile('docs/a.md')).toBe('# ours\n')
  })

  test("a merge does no swapping, so sidesSwapped never appears", async () => {
    await diverge()
    await repo.pull({ ref: 'origin/main' })
    const c = (await repo.getConflicts()).find((x) => x.path === 'docs/a.md')!
    expect(c.sidesSwapped).toBeUndefined()
    expect(c.ours!.content).toBe('# ours\n')
    expect(c.theirs!.content).toBe('# theirs\n')
  })

  test('continueRebase finishes and returns to a clean state', async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])
    const r = await repo.continueRebase()
    expect(r).toEqual({ done: true, conflicted: false })
    const st = await repo.status()
    expect(st.operation).toBeNull()
    expect(await repo.readFile('docs/a.md')).toBe('# ours\n')
  })

  test('continueRebase throws when no rebase is in progress', async () => {
    expect(await codeOf(repo.continueRebase())).toBe('INVALID_ARGUMENT')
  })

  test('abortMerge can abandon a rebase', async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.abortMerge()
    expect((await repo.status()).operation).toBeNull()
  })

  test('withSession does not delete a worktree stopped at a rebase conflict', async () => {
    let dir = ''
    const code = await store
      .withSession({ branch: 'feat/rb2', sparsePaths: ['docs'], author: AUTHOR }, async (r) => {
        dir = r.dir
        await r.writeFile('docs/a.md', '# ours\n')
        await r.commit({ message: 'ours' })
        pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' }, { message: 'theirs' })
        await r.pull({ strategy: 'rebase', ref: 'origin/main' })
      })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('MERGE_IN_PROGRESS')
    expect(existsSync(dir)).toBe(true)
    const re = await store.attachSession(dir)
    await re.abortMerge()
    await re.dispose()
  })
})

describe('merge()', () => {
  test('merges an arbitrary ref', async () => {
    pushToRemote(root, bare, { 'docs/m.md': 'merged' }, { message: 'theirs' })
    await store.fetch()
    const r = await repo.merge('origin/main')
    expect(r.conflicted).toBe(false)
    expect(await repo.readFile('docs/m.md')).toBe('merged')
  })

  test('returns conflicted rather than throwing on a conflict', async () => {
    await diverge()
    await store.fetch()
    expect((await repo.merge('origin/main')).conflicted).toBe(true)
  })

  test('a missing ref gives BRANCH_NOT_FOUND', async () => {
    expect(await codeOf(repo.merge('origin/does-not-exist'))).toBe('BRANCH_NOT_FOUND')
  })

  test('noFastForward produces a merge commit', async () => {
    pushToRemote(root, bare, { 'docs/m.md': 'merged' }, { message: 'theirs' })
    await store.fetch()
    await repo.merge('origin/main', { noFastForward: true })
    const parents = await repo.git(['rev-list', '--parents', '-1', 'HEAD'])
    expect(parents.trim().split(' ')).toHaveLength(3)
  })
})

describe('recover()', () => {
  test('reports the operation in progress honestly but cleans nothing up by default', async () => {
    await diverge()
    await repo.pull({ ref: 'origin/main' })
    const r = await repo.recover()
    expect(r).toEqual({ operation: 'merge', aborted: false, indexLockCleared: false })
    expect((await repo.status()).operation).toBe('merge')
  })

  test('aborts only when explicitly asked', async () => {
    await diverge()
    await repo.pull({ ref: 'origin/main' })
    const r = await repo.recover({ abortOperation: true })
    expect(r.aborted).toBe(true)
    expect((await repo.status()).operation).toBeNull()
  })

  test('clears a leftover index.lock', async () => {
    const lock = join(repo.dir, '.git')
    void lock
    const p = await repo.git(['rev-parse', '--git-path', 'index.lock'])
    const abs = p.startsWith('/') ? p : join(repo.dir, p)
    writeFileSync(abs, '')
    const r = await repo.recover({ clearIndexLock: true })
    expect(r.indexLockCleared).toBe(true)
    expect(existsSync(abs)).toBe(false)
  })

  test('reports operation: null in a clean state', async () => {
    expect(await repo.recover()).toEqual({
      operation: null, aborted: false, indexLockCleared: false,
    })
  })
})
