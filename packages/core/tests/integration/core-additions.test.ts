import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitRepo } from '../../src/api/git-repo'
import type { GitOpError } from '../../src/types'
import { cleanup, makeBareRemote, tempDir, urlOf } from '../helpers/fixtures'

let root: string, store: RepoStore, repo: GitRepo
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  const bare = makeBareRemote(root)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
  repo = await store.createSession({ branch: 'feat/add', sparsePaths: ['docs'], author: AUTHOR })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'NO_THROW', (e: GitOpError) => e.code)
}

describe('deleteFile', () => {
  test('删除后文件消失，commit 记录为删除', async () => {
    expect(await repo.exists('docs/a.md')).toBe(true)
    await repo.deleteFile('docs/a.md')
    expect(existsSync(join(repo.dir, 'docs', 'a.md'))).toBe(false)
    await repo.commit({ message: 'delete a' })
    const files = await repo.git(['ls-tree', '--name-only', 'HEAD', 'docs/'])
    expect(files).not.toContain('docs/a.md')
  })

  test('sparse 范围外 → PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.deleteFile('src/index.ts'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('穿越路径 → PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.deleteFile('../escape.md'))).toBe('PATH_TRAVERSAL')
  })

  test('不存在的文件抛错', async () => {
    await expect(repo.deleteFile('docs/nope.md')).rejects.toThrow()
  })
})

describe('readBuffer', () => {
  test('按字节读取文本', async () => {
    expect((await repo.readBuffer('docs/a.md')).toString('utf8')).toBe('# a\n')
  })

  test('二进制内容字节一致，可用于 NUL 探测', async () => {
    writeFileSync(join(repo.dir, 'docs', 'b.bin'), Buffer.from([0, 1, 2, 255]))
    const buf = await repo.readBuffer('docs/b.bin')
    expect([...buf]).toEqual([0, 1, 2, 255])
    expect(buf.includes(0)).toBe(true)
  })

  test('受 sparse 范围约束', async () => {
    expect(await codeOf(repo.readBuffer('src/index.ts'))).toBe('PATH_OUTSIDE_SPARSE')
  })
})

describe('getDiff', () => {
  test('工作区 vs HEAD 的未提交改动', async () => {
    await repo.writeFile('docs/a.md', '# changed\n')
    const { patch } = await repo.getDiff()
    expect(patch).toContain('docs/a.md')
    expect(patch).toContain('-# a')
    expect(patch).toContain('+# changed')
  })

  test('无改动时返回空 patch', async () => {
    expect((await repo.getDiff()).patch).toBe('')
  })

  test('against 用三点 diff 对比 merge-base', async () => {
    await repo.writeFile('docs/n.md', 'new\n')
    await repo.commit({ message: 'add n' })
    const { patch } = await repo.getDiff({ against: 'origin/main' })
    expect(patch).toContain('docs/n.md')
  })

  test('默认 pathspec 是 session 的 sparsePaths', async () => {
    await repo.writeFile('docs/a.md', '# changed\n')
    // 直接改工作区里 sparse 之外的位置（绕过 PathGuard），验证默认 pathspec 会把它挡在外面
    const { patch } = await repo.getDiff()
    expect(patch).toContain('docs/a.md')
    expect(patch).not.toContain('src/')
  })

  test('显式传入 sparse 范围外的 paths → PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.getDiff({ paths: ['src'] }))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('穿越路径 → PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.getDiff({ paths: ['../etc'] }))).toBe('PATH_TRAVERSAL')
  })

  test('context 行数可调', async () => {
    await repo.writeFile('docs/multi.md', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n')
    await repo.commit({ message: 'multi' })
    await repo.writeFile('docs/multi.md', 'l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n')
    const wide = await repo.getDiff({ context: 3 })
    const narrow = await repo.getDiff({ context: 0 })
    expect(wide.patch.split('\n').length).toBeGreaterThan(narrow.patch.split('\n').length)
  })

  test('全量模式（无 sparsePaths）下不限定路径', async () => {
    const full = await store.createSession({ branch: 'feat/full-diff', author: AUTHOR })
    await full.writeFile('src/index.ts', 'export const x = 2\n')
    expect((await full.getDiff()).patch).toContain('src/index.ts')
    await full.dispose()
  })
})
