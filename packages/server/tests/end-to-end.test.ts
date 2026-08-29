import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RepoManager, type GitRepo, type RepoStore } from '@aaxis/gitkit'
import { GitkitClientError, createClient, type GitkitClient } from '@aaxis/gitkit-client'
import { createHandler } from '../src/handler'
import { toExpress } from '../src/express'
import {
  cleanup, git, makeBareRemote, pushToRemote, tempDir, urlOf,
} from '../../core/tests/helpers/fixtures'

/**
 * 端到端：真实的 GitkitClient → HTTP handler → 真 git worktree。
 * client 与 server 各自的单测都用了打桩，这里验证两者真的能对上。
 */
let root: string, bare: string, store: RepoStore, repo: GitRepo, client: GitkitClient

beforeEach(async () => {
  root = tempDir()
  bare = makeBareRemote(root)
  store = await new RepoManager({ root: join(root, 'repos') }).store({ url: urlOf(bare) })
  repo = await store.createSession({
    branch: 'skills/alice-01',
    sparsePaths: [{ path: 'docs', requireChecks: true }],
    author: { name: 'Alice', email: 'alice@example.com' },
  })

  const handler = createHandler({
    // 宿主的鉴权与租户隔离在这里；协议本身不带任何仓库信息
    resolveSession: (_req, id) => (id === 'sess_alice' ? repo : null),
  })

  client = createClient({
    baseUrl: 'http://gitkit.local/api/git',
    sessionId: 'sess_alice',
    fetch: ((req: Request | string, init?: RequestInit) =>
      handler(req instanceof Request ? req : new Request(req, init))) as typeof fetch,
  })
})
afterEach(async () => { await repo.dispose().catch(() => {}); cleanup(root) })

describe('client → handler → 真 git', () => {
  test('status 反映真实分支', async () => {
    const s = await client.call('status', {})
    expect(s.branch).toBe('skills/alice-01')
    expect(s.clean).toBe(true)
    expect(s.operation).toBeNull()
  })

  test('read → write → read 往返一致，etag 更新', async () => {
    const first = await client.call('files.read', { path: 'docs/a.md' })
    if (first.binary) throw new Error('unreachable')
    expect(first.content).toBe('# a\n')

    const w = await client.call('files.write', {
      path: 'docs/a.md', content: '# edited by alice\n', baseEtag: first.etag,
    })
    const second = await client.call('files.read', { path: 'docs/a.md' })
    if (second.binary) throw new Error('unreachable')
    expect(second.content).toBe('# edited by alice\n')
    expect(second.etag).toBe(w.etag)
    expect(second.etag).not.toBe(first.etag)
  })

  test('完整主链路：编辑 → 提交 → 推送', async () => {
    await client.call('files.write', {
      path: 'docs/guide.md', content: '# Guide\n\nHello.\n',
    })
    const changes = await client.call('changes.list', {})
    expect(changes.files.map((f) => f.path)).toContain('docs/guide.md')

    const diff = await client.call('changes.diff', {})
    expect(diff.patch).toContain('docs/guide.md')

    const c = await client.call('commit', { message: 'docs: add guide' })
    expect(c.changed).toBe(true)

    const p = await client.call('push', {})
    expect(p).toEqual({ ok: true, pushed: true })
    expect(git(root, 'ls-remote', '--heads', bare)).toContain('refs/heads/skills/alice-01')
  })

  test('sparse 范围外的错误穿透为带错误码的 GitkitClientError', async () => {
    const e = await client.call('files.read', { path: 'src/index.ts' })
      .catch((x: GitkitClientError) => x)
    expect(e).toBeInstanceOf(GitkitClientError)
    expect((e as GitkitClientError).code).toBe('PATH_OUTSIDE_SPARSE')
    expect((e as GitkitClientError).status).toBe(400)
  })

  test('etag 冲突时 isStale 为 true 并带回服务端内容', async () => {
    const first = await client.call('files.read', { path: 'docs/a.md' })
    if (first.binary) throw new Error('unreachable')
    await client.call('files.write', { path: 'docs/a.md', content: 'from another tab' })

    const e = await client.call('files.write', {
      path: 'docs/a.md', content: 'my edit', baseEtag: first.etag,
    }).catch((x: GitkitClientError) => x) as GitkitClientError

    expect(e.isStale).toBe(true)
    expect(e.current?.content).toBe('from another tab')
    // 本次写入必须未生效
    const now = await client.call('files.read', { path: 'docs/a.md' })
    if (now.binary) throw new Error('unreachable')
    expect(now.content).toBe('from another tab')
  })

  test('冲突结果不含服务端路径，且能被解决后推送成功', async () => {
    await client.call('files.write', { path: 'docs/x.md', content: 'v1' })
    await client.call('commit', { message: 'v1' })
    await client.call('push', {})
    pushToRemote(root, bare, { 'docs/x.md': 'theirs' },
      { branch: 'skills/alice-01', message: 'theirs' })
    await client.call('files.write', { path: 'docs/x.md', content: 'ours' })
    await client.call('commit', { message: 'ours' })

    const r = await client.call('push', {})
    expect(r.ok).toBe(false)
    if (r.ok || r.reason !== 'conflict') throw new Error('unreachable')
    expect(JSON.stringify(r)).not.toContain(repo.dir)

    const { conflicts } = await client.call('conflicts.list', {})
    expect(conflicts[0]!.ours?.content).toBe('ours')
    await client.call('conflicts.resolve', {
      resolutions: [{ path: 'docs/x.md', take: 'ours' }],
    })
    await client.call('commit', { message: 'merged' })
    expect((await client.call('push', {})).ok).toBe(true)
  })

  test('无权访问的 session → 404 SESSION_NOT_FOUND', async () => {
    const other = client.withSession('sess_bob')
    const e = await other.call('status', {}).catch((x: GitkitClientError) => x) as GitkitClientError
    expect(e.code).toBe('SESSION_NOT_FOUND')
    expect(e.isGone).toBe(true)
  })

  test('未开放的 op → 404，不暴露其存在', async () => {
    const narrow = createHandler({
      resolveSession: () => repo,
      allow: ['status'],
    })
    const limited = createClient({
      baseUrl: 'http://x/g', sessionId: 'sess_alice',
      fetch: ((req: Request | string, init?: RequestInit) =>
        narrow(req instanceof Request ? req : new Request(req, init))) as typeof fetch,
    })
    expect((await limited.call('status', {})).branch).toBe('skills/alice-01')
    const e = await limited.call('files.write', { path: 'docs/a.md', content: 'x' })
      .catch((x: GitkitClientError) => x) as GitkitClientError
    expect(e.code).toBe('OP_NOT_ALLOWED')
    expect(e.status).toBe(404)
  })
})

describe('Express 适配器', () => {
  test('转换 Express 风格的 req/res 并保留状态码', async () => {
    const handler = createHandler({ resolveSession: () => repo })
    const express = toExpress(handler)

    let captured: { status: number; body: string } | undefined
    const res = {
      status(code: number) { captured = { status: code, body: '' }; return res },
      set() { return res },
      send(body: string) { captured!.body = body },
    }
    await express(
      {
        method: 'POST',
        url: '/api/git/status',
        headers: { 'content-type': 'application/json' },
        body: { sessionId: 'sess_alice' },
      },
      res,
    )
    expect(captured!.status).toBe(200)
    expect(JSON.parse(captured!.body).branch).toBe('skills/alice-01')
  })

  test('错误状态码同样透传', async () => {
    const handler = createHandler({ resolveSession: () => null })
    const express = toExpress(handler)
    let status = 0
    const res = {
      status(c: number) { status = c; return res },
      set() { return res },
      send() {},
    }
    await express(
      { method: 'POST', url: '/g/status', headers: {}, body: { sessionId: 'x' } },
      res,
    )
    expect(status).toBe(404)
  })
})
