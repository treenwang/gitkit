import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { GitRepo } from '../../src/api/git-repo'
import type { GitOpError } from '../../src/types'
import { cleanup, makeBareRemote, tempDir, urlOf } from '../helpers/fixtures'

let root: string, repo: GitRepo
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  const bare = makeBareRemote(root)
  const store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
  repo = await store.createSession({ branch: 'feat/fs', sparsePaths: ['docs'], author: AUTHOR })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

function codeOf(p: Promise<unknown>): Promise<string> {
  return p.then(() => 'NO_THROW', (e: GitOpError) => e.code)
}

describe('FsGateway 经由 GitRepo', () => {
  test('读取 sparse 范围内的文件', async () => {
    expect(await repo.readFile('docs/a.md')).toBe('# a\n')
  })

  test('写入并读回', async () => {
    await repo.writeFile('docs/new.md', 'hello')
    expect(await repo.readFile('docs/new.md')).toBe('hello')
  })

  test('写入时自动创建中间目录', async () => {
    await repo.writeFile('docs/deep/nested/x.md', 'x')
    expect(await repo.readFile('docs/deep/nested/x.md')).toBe('x')
  })

  test('读取 sparse 范围外 → PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.readFile('src/index.ts'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('写入 sparse 范围外 → PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.writeFile('src/x.ts', 'x'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('穿越路径 → PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.writeFile('../escape.md', 'x'))).toBe('PATH_TRAVERSAL')
  })

  test('写入 .git 下 → PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.writeFile('.git/hooks/evil', 'x'))).toBe('PATH_TRAVERSAL')
  })

  test('经由符号链接逃逸 → PATH_TRAVERSAL', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(repo.dir, 'docs', 'link'))
    expect(await codeOf(repo.readFile('docs/link/secret.txt'))).toBe('PATH_TRAVERSAL')
  })

  test('经由符号链接写入也被拒', async () => {
    const outside = join(root, 'outside2')
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(repo.dir, 'docs', 'link2'))
    expect(await codeOf(repo.writeFile('docs/link2/evil.txt', 'x'))).toBe('PATH_TRAVERSAL')
  })

  test('listFiles 只列出 sparse 范围内的文件，且不含 .git', async () => {
    const files = await repo.listFiles()
    expect(files).toContain('docs/a.md')
    expect(files).toContain('docs/api/b.md')
    expect(files.some((f) => f.startsWith('.git'))).toBe(false)
    expect(files.some((f) => f.startsWith('src/'))).toBe(false)
    expect(files).not.toContain('README.md')
  })

  test('listFiles 可限定子目录', async () => {
    expect(await repo.listFiles('docs/api')).toEqual(['docs/api/b.md'])
  })

  test('exists 对存在与不存在分别返回 true/false', async () => {
    expect(await repo.exists('docs/a.md')).toBe(true)
    expect(await repo.exists('docs/nope.md')).toBe(false)
  })

  test('dispose 后文件操作抛 WORKTREE_DISPOSED', async () => {
    await repo.dispose()
    expect(await codeOf(repo.readFile('docs/a.md'))).toBe('WORKTREE_DISPOSED')
  })
})
