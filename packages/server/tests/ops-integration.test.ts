import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RepoManager, type GitRepo, type RepoStore } from '@aaxis/gitkit'
import { createHandler } from '../src/handler'
import { etagOf } from '../src/ops'
import {
  cleanup, git, makeBareRemote, pushToRemote, tempDir, urlOf,
} from '../../core/tests/helpers/fixtures'

let root: string, bare: string, store: RepoStore, repo: GitRepo
let handler: (req: Request) => Promise<Response>
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
  repo = await store.createSession({ branch: 'feat/s', sparsePaths: ['docs'], author: AUTHOR })
  handler = createHandler({ resolveSession: () => repo })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

async function call(op: string, params: Record<string, unknown> = {}): Promise<Any> {
  const res = await handler(new Request(`http://x/g/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', ...params }),
  }))
  const body = await res.json()
  if (!res.ok) throw Object.assign(new Error(body.error.message), { code: body.error.code, status: res.status, body })
  return body as Any
}

describe('files 全链路（真 git）', () => {
  test('read 返回内容与 etag', async () => {
    const r = await call('files.read', { path: 'docs/a.md' })
    expect(r.binary).toBe(false)
    expect(r.content).toBe('# a\n')
    expect(r.etag).toBe(etagOf('# a\n'))
    expect(r.truncated).toBe(false)
  })

  test('write 后 read 回来一致，etag 更新', async () => {
    const w = await call('files.write', { path: 'docs/a.md', content: '# changed\n' })
    expect(w.etag).toBe(etagOf('# changed\n'))
    expect((await call('files.read', { path: 'docs/a.md' })).content).toBe('# changed\n')
  })

  test('write 新文件自动建目录', async () => {
    await call('files.write', { path: 'docs/deep/nested/x.md', content: 'x' })
    expect((await call('files.read', { path: 'docs/deep/nested/x.md' })).content).toBe('x')
  })

  test('sparse 范围外 → 400 PATH_OUTSIDE_SPARSE', async () => {
    const e = await call('files.read', { path: 'src/index.ts' }).catch((x: Any) => x)
    expect(e.code).toBe('PATH_OUTSIDE_SPARSE')
    expect(e.status).toBe(400)
  })

  test('穿越路径 → 400 PATH_TRAVERSAL', async () => {
    expect((await call('files.write', { path: '../evil', content: 'x' }).catch((x: Any) => x)).code)
      .toBe('PATH_TRAVERSAL')
  })

  test('二进制文件不返回 content', async () => {
    await Bun.write(join(repo.dir, 'docs', 'b.bin'), new Uint8Array([0, 1, 2, 255]))
    const r = await call('files.read', { path: 'docs/b.bin' })
    expect(r).toEqual({ binary: true, size: 4 })
  })

  test('delete 后文件消失', async () => {
    expect(await call('files.delete', { path: 'docs/a.md' })).toEqual({ deleted: true })
    expect((await call('files.read', { path: 'docs/a.md' }).catch((x: Any) => x)).status).toBe(500)
  })

  test('list 标注改动状态', async () => {
    await call('files.write', { path: 'docs/a.md', content: 'changed' })
    await call('files.write', { path: 'docs/new.md', content: 'new' })
    const { entries } = await call('files.list')
    const by = Object.fromEntries(entries.map((e: Any) => [e.path, e.status]))
    expect(by['docs/a.md']).toBe('modified')
    expect(by['docs/new.md']).toBe('added')
    expect(by['docs/api/b.md']).toBe('clean')
  })
})

describe('乐观并发控制', () => {
  test('baseEtag 一致时写入成功', async () => {
    const { etag } = await call('files.read', { path: 'docs/a.md' })
    await call('files.write', { path: 'docs/a.md', content: 'v2', baseEtag: etag })
    expect((await call('files.read', { path: 'docs/a.md' })).content).toBe('v2')
  })

  test('baseEtag 过期 → 409 STALE_ETAG，且带回服务端当前内容', async () => {
    const { etag } = await call('files.read', { path: 'docs/a.md' })
    // 模拟"别处改了这个文件"
    await call('files.write', { path: 'docs/a.md', content: 'from elsewhere' })

    const e = await call('files.write', {
      path: 'docs/a.md', content: 'my edit', baseEtag: etag,
    }).catch((x: Any) => x)
    expect(e.code).toBe('STALE_ETAG')
    expect(e.status).toBe(409)
    expect(e.body.error.current.content).toBe('from elsewhere')
    // 关键：本次写入必须没有生效
    expect((await call('files.read', { path: 'docs/a.md' })).content).toBe('from elsewhere')
  })

  test('省略 baseEtag 时跳过检查（明知要覆盖的场景）', async () => {
    await call('files.write', { path: 'docs/a.md', content: 'forced' })
    expect((await call('files.read', { path: 'docs/a.md' })).content).toBe('forced')
  })

  test('ifNotExists 命中已存在文件 → 409 ALREADY_EXISTS', async () => {
    const e = await call('files.write', {
      path: 'docs/a.md', content: 'x', ifNotExists: true,
    }).catch((x: Any) => x)
    expect(e.code).toBe('ALREADY_EXISTS')
    expect((await call('files.read', { path: 'docs/a.md' })).content).toBe('# a\n')
  })

  test('pull 引入的改动会让编辑中的 baseEtag 失效（这正是该机制要防的）', async () => {
    const { etag } = await call('files.read', { path: 'docs/a.md' })
    pushToRemote(root, bare, { 'docs/a.md': '# from remote\n' }, { message: 'theirs' })
    await call('sync.pull', { strategy: 'merge', ref: 'origin/main' })

    const e = await call('files.write', {
      path: 'docs/a.md', content: 'my edit', baseEtag: etag,
    }).catch((x: Any) => x)
    expect(e.code).toBe('STALE_ETAG')
    expect(e.body.error.current.content).toBe('# from remote\n')
  })
})

describe('changes / diff / commit / push', () => {
  test('changes.list 列出改动', async () => {
    await call('files.write', { path: 'docs/a.md', content: 'changed' })
    await call('files.write', { path: 'docs/n.md', content: 'new' })
    const { files } = await call('changes.list')
    const by = Object.fromEntries(files.map((f: Any) => [f.path, f.status]))
    expect(by['docs/a.md']).toBe('modified')
    expect(by['docs/n.md']).toBe('added')
  })

  test('changes.diff 返回补丁', async () => {
    await call('files.write', { path: 'docs/a.md', content: '# changed\n' })
    const { patch, truncated } = await call('changes.diff')
    expect(patch).toContain('-# a')
    expect(patch).toContain('+# changed')
    expect(truncated).toBe(false)
  })

  test('changes.diff 可限定单个文件', async () => {
    await call('files.write', { path: 'docs/a.md', content: 'x' })
    await call('files.write', { path: 'docs/api/b.md', content: 'y' })
    const { patch } = await call('changes.diff', { path: 'docs/api/b.md' })
    expect(patch).toContain('docs/api/b.md')
    expect(patch).not.toContain('docs/a.md')
  })

  test('commit → push 全链路', async () => {
    await call('files.write', { path: 'docs/a.md', content: '# committed\n' })
    const c = await call('commit', { message: 'update a' })
    expect(c.changed).toBe(true)
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/)

    expect(await call('push', {})).toEqual({ ok: true, pushed: true })
    expect(git(root, 'ls-remote', '--heads', bare)).toContain('refs/heads/feat/s')
  })

  test('无改动时 commit 返回 changed: false', async () => {
    expect((await call('commit', { message: 'nothing' })).changed).toBe(false)
  })

  test('缺 message → 400', async () => {
    expect((await call('commit', {}).catch((x: Any) => x)).status).toBe(400)
  })
})

describe('冲突链路', () => {
  test('push 冲突 → 结构化冲突，且响应中无服务端路径', async () => {
    await call('files.write', { path: 'docs/x.md', content: 'v1' })
    await call('commit', { message: 'v1' })
    await call('push', {})

    pushToRemote(root, bare, { 'docs/x.md': 'theirs' },
      { branch: 'feat/s', message: 'theirs' })

    await call('files.write', { path: 'docs/x.md', content: 'ours' })
    await call('commit', { message: 'ours' })

    const res = await handler(new Request('http://x/g/push', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    }))
    const text = await res.text()
    expect(text).not.toContain(repo.dir)
    const body = JSON.parse(text)
    expect(body.reason).toBe('conflict')
    expect(body.conflicts.map((c: Any) => c.path)).toContain('docs/x.md')
    expect('worktreeDir' in body).toBe(false)
  })

  test('conflicts.list → resolve → commit → push', async () => {
    await call('files.write', { path: 'docs/x.md', content: 'v1' })
    await call('commit', { message: 'v1' })
    await call('push', {})
    pushToRemote(root, bare, { 'docs/x.md': 'theirs' },
      { branch: 'feat/s', message: 'theirs' })
    await call('files.write', { path: 'docs/x.md', content: 'ours' })
    await call('commit', { message: 'ours' })
    await call('push', {}).catch(() => {})

    const { conflicts } = await call('conflicts.list')
    expect(conflicts[0].ours.content).toBe('ours')
    expect(conflicts[0].theirs.content).toBe('theirs')

    const r = await call('conflicts.resolve', {
      resolutions: [{ path: 'docs/x.md', take: 'ours' }],
    })
    expect(r.remaining).toEqual([])
    await call('commit', { message: 'merged' })
    expect((await call('push', {})).ok).toBe(true)
  })

  test('conflicts.abort 回到干净状态', async () => {
    await call('files.write', { path: 'docs/a.md', content: '# ours\n' })
    await call('commit', { message: 'ours' })
    pushToRemote(root, bare, { 'docs/a.md': '# theirs\n' }, { message: 'theirs' })
    await call('sync.pull', { ref: 'origin/main' })
    expect(await call('conflicts.abort')).toEqual({ ok: true })
    expect((await call('status')).operation).toBeNull()
  })
})

describe('ref 参数注入防护', () => {
  test('以 - 开头的 ref 被拒（否则会被 git 当作选项）', async () => {
    for (const ref of ['--upload-pack=touch /tmp/pwned', '--help']) {
      const e = await call('sync.pull', { ref }).catch((x: Any) => x)
      expect(e.code).toBe('INVALID_ARGUMENT')
      expect(e.status).toBe(400)
    }
  })

  test('合法 ref 正常工作', async () => {
    pushToRemote(root, bare, { 'docs/pulled.md': 'from remote' }, { message: 'theirs' })
    expect(await call('sync.pull', { ref: 'origin/main' })).toEqual({ conflicted: false })
    expect((await call('files.read', { path: 'docs/pulled.md' })).content).toBe('from remote')
  })

  test('非法 strategy 被拒', async () => {
    expect((await call('sync.pull', { strategy: 'evil' }).catch((x: Any) => x)).status).toBe(400)
  })
})

describe('体积上限', () => {
  test('超过 maxContentBytes 的文件被截断并标记', async () => {
    const big = 'x'.repeat(5000)
    await call('files.write', { path: 'docs/big.md', content: big })
    const small = createHandler({ resolveSession: () => repo, maxContentBytes: 100 })
    const res = await small(new Request('http://x/g/files.read', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', path: 'docs/big.md' }),
    }))
    const body = await res.json()
    expect(body.truncated).toBe(true)
    expect(body.content).toHaveLength(100)
    expect(body.size).toBe(5000)
    // etag 覆盖完整内容，而非截断后的内容
    expect(body.etag).toBe(etagOf(big))
  })
})

describe('并发写', () => {
  test('同一 session 并发 10 个写请求全部成功', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        call('files.write', { path: `docs/c${i}.md`, content: `c${i}` })),
    )
    expect(results.every((r) => typeof r.etag === 'string')).toBe(true)
    const { entries } = await call('files.list')
    for (let i = 0; i < 10; i += 1) {
      expect(entries.some((e: Any) => e.path === `docs/c${i}.md`)).toBe(true)
    }
  })
})
