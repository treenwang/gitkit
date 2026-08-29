import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitRepo } from '../../src/api/git-repo'
import type { Conflict, GitOpError } from '../../src/types'
import {
  cleanup, git, makeBareRemote, pushToRemote, seedConflictBase, tempDir, urlOf,
} from '../helpers/fixtures'

let root: string, bare: string, store: RepoStore, repo: GitRepo
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  seedConflictBase(root, bare)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
  repo = await store.createSession({ branch: 'feat/c', sparsePaths: ['docs'], author: AUTHOR })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'NO_THROW', (e: GitOpError) => e.code)
}

/** 制造冲突：我方改动 + 远端改动，然后 pull。 */
async function conflict(
  ours: Record<string, string | null>,
  theirs: Record<string, string | null>,
): Promise<Conflict[]> {
  for (const [p, c] of Object.entries(ours)) {
    if (c === null) await repo.git(['rm', '-f', '--', p])
    else await repo.writeFile(p, c)
  }
  await repo.commit({ message: 'ours' })
  pushToRemote(root, bare, theirs, { message: 'theirs' })
  const r = await repo.pull({ ref: 'origin/main' })
  expect(r.conflicted).toBe(true)
  return repo.getConflicts()
}

describe('getConflicts —— 五类冲突', () => {
  test('both_modified：带 hunks 与三方内容', async () => {
    const cs = await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    const c = cs.find((x) => x.path === 'docs/both.txt')!
    expect(c.type).toBe('both_modified')
    expect(c.binary).toBe(false)
    expect(c.ours!.content).toBe('l1\nOUR2\nl3\nl4\nl5\n')
    expect(c.theirs!.content).toBe('l1\nTHEIR2\nl3\nl4\nl5\n')
    expect(c.base!.content).toBe('l1\nl2\nl3\nl4\nl5\n')
    expect(c.hunks).toHaveLength(1)
    expect(c.hunks![0]!.ourLines).toEqual(['OUR2'])
    expect(c.hunks![0]!.theirLines).toEqual(['THEIR2'])
    expect(c.hunks![0]!.baseLines).toEqual(['l2'])
    expect(c.raw).toContain('<<<<<<<')
  })

  test('both_added：无 base，有 hunks', async () => {
    const cs = await conflict(
      { 'docs/new.txt': 'ours-new\n' },
      { 'docs/new.txt': 'theirs-new\n' },
    )
    const c = cs.find((x) => x.path === 'docs/new.txt')!
    expect(c.type).toBe('both_added')
    expect(c.base).toBeUndefined()
    expect(c.ours!.content).toBe('ours-new\n')
    expect(c.hunks!.length).toBeGreaterThan(0)
  })

  test('deleted_by_them：无标记、无 hunks，但有 base 与 ours', async () => {
    const cs = await conflict(
      { 'docs/delmod.txt': 'our-mod\n' },
      { 'docs/delmod.txt': null },
    )
    const c = cs.find((x) => x.path === 'docs/delmod.txt')!
    expect(c.type).toBe('deleted_by_them')
    expect(c.hunks).toBeUndefined()
    expect(c.theirs).toBeUndefined()
    expect(c.ours!.content).toBe('our-mod\n')
    expect(c.base!.content).toBe('del\n')
    // 工作区保留的是 ours 的完整内容，没有冲突标记
    expect(await repo.readFile('docs/delmod.txt')).toBe('our-mod\n')
  })

  test('deleted_by_us：有 base 与 theirs，无 ours', async () => {
    const cs = await conflict(
      { 'docs/moddel.txt': null },
      { 'docs/moddel.txt': 'their-mod\n' },
    )
    const c = cs.find((x) => x.path === 'docs/moddel.txt')!
    expect(c.type).toBe('deleted_by_us')
    expect(c.ours).toBeUndefined()
    expect(c.theirs!.content).toBe('their-mod\n')
    expect(c.hunks).toBeUndefined()
  })

  test('rename/rename：三条单 stage 记录归并为一条', async () => {
    await repo.git(['mv', 'docs/orig.txt', 'docs/our-name.txt'])
    await repo.commit({ message: 'rename ours' })
    pushToRemote(root, bare, { 'docs/orig.txt': null, 'docs/their-name.txt': 'rename me\n' },
      { message: 'rename theirs' })
    expect((await repo.pull({ ref: 'origin/main' })).conflicted).toBe(true)

    const c = (await repo.getConflicts()).find((x) => x.type === 'rename')!
    expect(c).toBeDefined()
    expect(c.path).toBe('docs/orig.txt')
    expect(c.ourPath).toBe('docs/our-name.txt')
    expect(c.theirPath).toBe('docs/their-name.txt')
    expect(c.hunks).toBeUndefined()
  })

  test('二进制冲突：binary=true，不填 content，无 hunks', async () => {
    pushToRemote(root, bare, {}, { message: 'noop' })
    writeFileSync(join(repo.dir, 'docs', 'b.bin'), Buffer.from([0, 1, 2]))
    await repo.commit({ message: 'ours bin' })

    const clone = join(root, 'binclone')
    git(root, 'clone', '-b', 'main', bare, clone)
    writeFileSync(join(clone, 'docs', 'b.bin'), Buffer.from([0, 9, 9]))
    git(clone, 'add', '-A'); git(clone, 'commit', '-m', 'theirs bin'); git(clone, 'push')

    expect((await repo.pull({ ref: 'origin/main' })).conflicted).toBe(true)
    const c = (await repo.getConflicts()).find((x) => x.path === 'docs/b.bin')!
    expect(c.binary).toBe(true)
    expect(c.ours!.content).toBeUndefined()
    expect(c.ours!.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(c.hunks).toBeUndefined()
  })

  test('无冲突时返回空数组', async () => {
    expect(await repo.getConflicts()).toEqual([])
  })
})

describe('resolveConflicts', () => {
  test("take: 'ours' 写回我方内容并解除冲突", async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    const r = await repo.resolveConflicts([{ path: 'docs/both.txt', take: 'ours' }])
    expect(r.remaining).toEqual([])
    expect(await repo.readFile('docs/both.txt')).toBe('l1\nOUR2\nl3\nl4\nl5\n')
    const c = await repo.commit({ message: 'resolved' })
    expect(c.changed).toBe(true)
    expect((await repo.status()).merging).toBe(false)
  })

  test("take: 'theirs'", async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    await repo.resolveConflicts([{ path: 'docs/both.txt', take: 'theirs' }])
    expect(await repo.readFile('docs/both.txt')).toBe('l1\nTHEIR2\nl3\nl4\nl5\n')
  })

  test("take: 'base'", async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    await repo.resolveConflicts([{ path: 'docs/both.txt', take: 'base' }])
    expect(await repo.readFile('docs/both.txt')).toBe('l1\nl2\nl3\nl4\nl5\n')
  })

  test('content 写回手改内容', async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    await repo.resolveConflicts([{ path: 'docs/both.txt', content: 'MERGED\n' }])
    expect(await repo.readFile('docs/both.txt')).toBe('MERGED\n')
    expect((await repo.getConflicts())).toEqual([])
  })

  test("delete/modify 用 take: 'delete' 解决", async () => {
    await conflict({ 'docs/delmod.txt': 'our-mod\n' }, { 'docs/delmod.txt': null })
    const r = await repo.resolveConflicts([{ path: 'docs/delmod.txt', take: 'delete' }])
    expect(r.remaining).toEqual([])
    expect(existsSync(join(repo.dir, 'docs', 'delmod.txt'))).toBe(false)
    await repo.commit({ message: 'deleted' })
  })

  test("delete/modify 用 take: 'ours' 保留我方版本", async () => {
    await conflict({ 'docs/delmod.txt': 'our-mod\n' }, { 'docs/delmod.txt': null })
    await repo.resolveConflicts([{ path: 'docs/delmod.txt', take: 'ours' }])
    expect(await repo.readFile('docs/delmod.txt')).toBe('our-mod\n')
    await repo.commit({ message: 'kept ours' })
  })

  test("deleted_by_them 选 'theirs' 时抛错并提示改用 delete", async () => {
    await conflict({ 'docs/delmod.txt': 'our-mod\n' }, { 'docs/delmod.txt': null })
    expect(await codeOf(repo.resolveConflicts([{ path: 'docs/delmod.txt', take: 'theirs' }])))
      .toBe('INVALID_ARGUMENT')
  })

  test('多个冲突部分解决时 remaining 报告剩余', async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n', 'docs/moddel.txt': null },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n', 'docs/moddel.txt': 'their-mod\n' },
    )
    const r = await repo.resolveConflicts([{ path: 'docs/both.txt', take: 'ours' }])
    expect(r.remaining).toEqual(['docs/moddel.txt'])
  })

  test('路径不在冲突集合中时抛 INVALID_ARGUMENT', async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    expect(await codeOf(repo.resolveConflicts([{ path: 'docs/a.md', take: 'ours' }])))
      .toBe('INVALID_ARGUMENT')
  })

  test('二进制冲突选边后内容按字节一致', async () => {
    pushToRemote(root, bare, {}, { message: 'noop' })
    writeFileSync(join(repo.dir, 'docs', 'b.bin'), Buffer.from([0, 1, 2, 255]))
    await repo.commit({ message: 'ours bin' })
    const clone = join(root, 'binclone2')
    git(root, 'clone', '-b', 'main', bare, clone)
    writeFileSync(join(clone, 'docs', 'b.bin'), Buffer.from([0, 9, 9, 9]))
    git(clone, 'add', '-A'); git(clone, 'commit', '-m', 't'); git(clone, 'push')
    await repo.pull({ ref: 'origin/main' })

    await repo.resolveConflicts([{ path: 'docs/b.bin', take: 'theirs' }])
    const bytes = await Bun.file(join(repo.dir, 'docs', 'b.bin')).bytes()
    expect([...bytes]).toEqual([0, 9, 9, 9])
  })

  test('rename 冲突选 ours 后只保留我方路径', async () => {
    await repo.git(['mv', 'docs/orig.txt', 'docs/our-name.txt'])
    await repo.commit({ message: 'rename ours' })
    pushToRemote(root, bare, { 'docs/orig.txt': null, 'docs/their-name.txt': 'rename me\n' },
      { message: 'rename theirs' })
    await repo.pull({ ref: 'origin/main' })

    const c = (await repo.getConflicts()).find((x) => x.type === 'rename')!
    const r = await repo.resolveConflicts([{ path: c.path, take: 'ours' }])
    expect(r.remaining).toEqual([])
    expect(existsSync(join(repo.dir, 'docs', 'our-name.txt'))).toBe(true)
    expect(existsSync(join(repo.dir, 'docs', 'their-name.txt'))).toBe(false)
    await repo.commit({ message: 'resolved rename' })
  })
})

describe('resolveByHunks', () => {
  test('逐块选边', async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nOUR5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nTHEIR5\n' },
    )
    const c = (await repo.getConflicts()).find((x) => x.path === 'docs/both.txt')!
    expect(c.hunks).toHaveLength(2)
    await repo.resolveByHunks('docs/both.txt', ['ours', 'theirs'])
    expect(await repo.readFile('docs/both.txt')).toBe('l1\nOUR2\nl3\nl4\nTHEIR5\n')
  })

  test('choices 数量不符时抛 INVALID_ARGUMENT', async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nOUR5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nTHEIR5\n' },
    )
    expect(await codeOf(repo.resolveByHunks('docs/both.txt', ['ours'])))
      .toBe('INVALID_ARGUMENT')
  })

  test('对无标记的冲突调用时抛 INVALID_ARGUMENT', async () => {
    await conflict({ 'docs/delmod.txt': 'our-mod\n' }, { 'docs/delmod.txt': null })
    expect(await codeOf(repo.resolveByHunks('docs/delmod.txt', ['ours'])))
      .toBe('INVALID_ARGUMENT')
  })
})

describe('merge 状态从磁盘实时推导', () => {
  test('attachSession 后仍能看到冲突现场', async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    const dir = repo.dir
    const re = await store.attachSession(dir)
    expect((await re.status()).merging).toBe(true)
    const cs = await re.getConflicts()
    expect(cs.map((c) => c.path)).toContain('docs/both.txt')
    await re.dispose()
  })

  test('listSessions 把冲突中的 worktree 标为 conflicted', async () => {
    await conflict(
      { 'docs/both.txt': 'l1\nOUR2\nl3\nl4\nl5\n' },
      { 'docs/both.txt': 'l1\nTHEIR2\nl3\nl4\nl5\n' },
    )
    const info = (await store.listSessions()).find((s) => s.dir === repo.dir)!
    expect(info.state).toBe('conflicted')
  })
})
