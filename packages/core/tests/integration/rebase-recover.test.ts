import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
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

/** 造一个与 origin/main 冲突的本地提交。 */
async function diverge(): Promise<void> {
  await repo.writeFile('docs/a.md', '# ours\n')
  await repo.commit({ message: 'ours' })
  pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' }, { message: 'theirs' })
}

describe('rebase 冲突', () => {
  test('rebase 冲突被识别为进行中的操作（没有 MERGE_HEAD 也不能漏判）', async () => {
    await diverge()
    const r = await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    expect(r.conflicted).toBe(true)

    const st = await repo.status()
    expect(st.operation).toBe('rebase')
    expect(st.merging).toBe(true)
    expect(st.conflicted).toContain('docs/a.md')
  })

  test('rebase 中调 commit 抛错并指向 continueRebase', async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])
    expect(await codeOf(repo.commit({ message: 'x' }))).toBe('INVALID_ARGUMENT')
  })

  test("rebase 中 'ours' 归一化为我方改动（git 的 stage 2/3 是反的）", async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    const c = (await repo.getConflicts()).find((x) => x.path === 'docs/a.md')!
    expect(c.sidesSwapped).toBe(true)
    expect(c.ours!.content).toBe('# ours\n')      // 我方分支的改动
    expect(c.theirs!.content).toBe('# theirs\n')  // 被 rebase 到的上游
    expect(c.hunks![0]!.ourLines).toEqual(['# ours'])
    expect(c.hunks![0]!.theirLines).toEqual(['# theirs'])
  })

  test("rebase 中 resolveByHunks 的 'ours' 同样是我方改动", async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.resolveByHunks('docs/a.md', ['ours'])
    expect(await repo.readFile('docs/a.md')).toBe('# ours\n')
  })

  test("merge 中不做交换，sidesSwapped 不出现", async () => {
    await diverge()
    await repo.pull({ ref: 'origin/main' })
    const c = (await repo.getConflicts()).find((x) => x.path === 'docs/a.md')!
    expect(c.sidesSwapped).toBeUndefined()
    expect(c.ours!.content).toBe('# ours\n')
    expect(c.theirs!.content).toBe('# theirs\n')
  })

  test('continueRebase 收尾后回到干净状态', async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])
    const r = await repo.continueRebase()
    expect(r).toEqual({ done: true, conflicted: false })
    const st = await repo.status()
    expect(st.operation).toBeNull()
    expect(await repo.readFile('docs/a.md')).toBe('# ours\n')
  })

  test('没有进行中的 rebase 时 continueRebase 抛错', async () => {
    expect(await codeOf(repo.continueRebase())).toBe('INVALID_ARGUMENT')
  })

  test('abortMerge 能放弃 rebase', async () => {
    await diverge()
    await repo.pull({ strategy: 'rebase', ref: 'origin/main' })
    await repo.abortMerge()
    expect((await repo.status()).operation).toBeNull()
  })

  test('withSession 不会删掉停在 rebase 冲突中的 worktree', async () => {
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
  test('合并任意 ref', async () => {
    pushToRemote(root, bare, { 'docs/m.md': 'merged' }, { message: 'theirs' })
    await store.fetch()
    const r = await repo.merge('origin/main')
    expect(r.conflicted).toBe(false)
    expect(await repo.readFile('docs/m.md')).toBe('merged')
  })

  test('冲突时返回 conflicted 而不抛错', async () => {
    await diverge()
    await store.fetch()
    expect((await repo.merge('origin/main')).conflicted).toBe(true)
  })

  test('不存在的 ref → BRANCH_NOT_FOUND', async () => {
    expect(await codeOf(repo.merge('origin/does-not-exist'))).toBe('BRANCH_NOT_FOUND')
  })

  test('noFastForward 产生 merge commit', async () => {
    pushToRemote(root, bare, { 'docs/m.md': 'merged' }, { message: 'theirs' })
    await store.fetch()
    await repo.merge('origin/main', { noFastForward: true })
    const parents = await repo.git(['rev-list', '--parents', '-1', 'HEAD'])
    expect(parents.trim().split(' ')).toHaveLength(3)
  })
})

describe('recover()', () => {
  test('如实报告进行中的操作但默认不清理', async () => {
    await diverge()
    await repo.pull({ ref: 'origin/main' })
    const r = await repo.recover()
    expect(r).toEqual({ operation: 'merge', aborted: false, indexLockCleared: false })
    expect((await repo.status()).operation).toBe('merge')
  })

  test('显式要求时才 abort', async () => {
    await diverge()
    await repo.pull({ ref: 'origin/main' })
    const r = await repo.recover({ abortOperation: true })
    expect(r.aborted).toBe(true)
    expect((await repo.status()).operation).toBeNull()
  })

  test('清理残留的 index.lock', async () => {
    const lock = join(repo.dir, '.git')
    void lock
    const p = await repo.git(['rev-parse', '--git-path', 'index.lock'])
    const abs = p.startsWith('/') ? p : join(repo.dir, p)
    await Bun.write(abs, '')
    const r = await repo.recover({ clearIndexLock: true })
    expect(r.indexLockCleared).toBe(true)
    expect(existsSync(abs)).toBe(false)
  })

  test('干净状态下报告 operation: null', async () => {
    expect(await repo.recover()).toEqual({
      operation: null, aborted: false, indexLockCleared: false,
    })
  })
})
