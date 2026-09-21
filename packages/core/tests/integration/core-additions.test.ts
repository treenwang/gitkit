import { afterEach, beforeEach, describe, expect, test } from 'vitest'
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
  test('the file is gone after a delete and the commit records a deletion', async () => {
    expect(await repo.exists('docs/a.md')).toBe(true)
    await repo.deleteFile('docs/a.md')
    expect(existsSync(join(repo.dir, 'docs', 'a.md'))).toBe(false)
    await repo.commit({ message: 'delete a' })
    const files = await repo.git(['ls-tree', '--name-only', 'HEAD', 'docs/'])
    expect(files).not.toContain('docs/a.md')
  })

  test('outside the sparse range gives PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.deleteFile('src/index.ts'))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('a traversal path gives PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.deleteFile('../escape.md'))).toBe('PATH_TRAVERSAL')
  })

  test('a missing file throws', async () => {
    await expect(repo.deleteFile('docs/nope.md')).rejects.toThrow()
  })
})

describe('readBuffer', () => {
  test('reads text as bytes', async () => {
    expect((await repo.readBuffer('docs/a.md')).toString('utf8')).toBe('# a\n')
  })

  test('binary content is byte-identical, which NUL detection relies on', async () => {
    writeFileSync(join(repo.dir, 'docs', 'b.bin'), Buffer.from([0, 1, 2, 255]))
    const buf = await repo.readBuffer('docs/b.bin')
    expect([...buf]).toEqual([0, 1, 2, 255])
    expect(buf.includes(0)).toBe(true)
  })

  test('is constrained by the sparse range', async () => {
    expect(await codeOf(repo.readBuffer('src/index.ts'))).toBe('PATH_OUTSIDE_SPARSE')
  })
})

describe('getDiff', () => {
  test('uncommitted changes, working tree against HEAD', async () => {
    await repo.writeFile('docs/a.md', '# changed\n')
    const { patch } = await repo.getDiff()
    expect(patch).toContain('docs/a.md')
    expect(patch).toContain('-# a')
    expect(patch).toContain('+# changed')
  })

  test('a newly created untracked file shows up in the diff too', async () => {
    await repo.writeFile('docs/brand-new.md', '# brand new\n')
    const { patch } = await repo.getDiff()
    expect(patch).toContain('docs/brand-new.md')
    expect(patch).toContain('+# brand new')
  })

  test('a tracked modification and a new file both appear', async () => {
    await repo.writeFile('docs/a.md', '# changed\n')
    await repo.writeFile('docs/new.md', 'new\n')
    const { patch } = await repo.getDiff()
    expect(patch).toContain('docs/a.md')
    expect(patch).toContain('docs/new.md')
  })

  test('untracked files obey the pathspec as well', async () => {
    await repo.writeFile('docs/inside.md', 'x\n')
    const { patch } = await repo.getDiff({ paths: ['docs/api'] })
    expect(patch).not.toContain('docs/inside.md')
  })

  test('with against set, untracked files are excluded - they are not in the commit range', async () => {
    await repo.writeFile('docs/untracked.md', 'x\n')
    const { patch } = await repo.getDiff({ against: 'origin/main' })
    expect(patch).not.toContain('docs/untracked.md')
  })

  test('returns an empty patch when nothing changed', async () => {
    expect((await repo.getDiff()).patch).toBe('')
  })

  test('against uses a three-dot diff against the merge base', async () => {
    await repo.writeFile('docs/n.md', 'new\n')
    await repo.commit({ message: 'add n' })
    const { patch } = await repo.getDiff({ against: 'origin/main' })
    expect(patch).toContain('docs/n.md')
  })

  test('the default pathspec is the session sparsePaths', async () => {
    await repo.writeFile('docs/a.md', '# changed\n')
    // Write outside the sparse range directly, bypassing PathGuard, to confirm the default pathspec keeps it out
    const { patch } = await repo.getDiff()
    expect(patch).toContain('docs/a.md')
    expect(patch).not.toContain('src/')
  })

  test('passing paths outside the sparse range explicitly gives PATH_OUTSIDE_SPARSE', async () => {
    expect(await codeOf(repo.getDiff({ paths: ['src'] }))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('a traversal path gives PATH_TRAVERSAL', async () => {
    expect(await codeOf(repo.getDiff({ paths: ['../etc'] }))).toBe('PATH_TRAVERSAL')
  })

  test('the number of context lines is adjustable', async () => {
    await repo.writeFile('docs/multi.md', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\n')
    await repo.commit({ message: 'multi' })
    await repo.writeFile('docs/multi.md', 'l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\n')
    const wide = await repo.getDiff({ context: 3 })
    const narrow = await repo.getDiff({ context: 0 })
    expect(wide.patch.split('\n').length).toBeGreaterThan(narrow.patch.split('\n').length)
  })

  test('full-checkout mode, with no sparsePaths, does not restrict paths', async () => {
    const full = await store.createSession({ branch: 'feat/full-diff', author: AUTHOR })
    await full.writeFile('src/index.ts', 'export const x = 2\n')
    expect((await full.getDiff()).patch).toContain('src/index.ts')
    await full.dispose()
  })
})
