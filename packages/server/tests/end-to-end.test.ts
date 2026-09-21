import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { RepoManager, type GitRepo, type RepoStore } from '@treenwang/gitkit'
import { GitkitClientError, createClient, type GitkitClient } from '@treenwang/gitkit-client'
import { createHandler } from '../src/handler'
import { toExpress } from '../src/express'
import {
  cleanup, git, makeBareRemote, pushToRemote, tempDir, urlOf,
} from '../../core/tests/helpers/fixtures'

/**
 * End to end: a real GitkitClient through the HTTP handler into a real git
 * worktree. The client and server unit tests both stub things out; this one
 * checks that the two halves actually meet.
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
    // The host's authentication and tenant isolation live here; the protocol itself carries no repository information
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

describe('client to handler to real git', () => {
  test('status reflects the real branch', async () => {
    const s = await client.call('status', {})
    expect(s.branch).toBe('skills/alice-01')
    expect(s.clean).toBe(true)
    expect(s.operation).toBeNull()
  })

  test('read, write, read round-trips consistently and updates the etag', async () => {
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

  test('the whole main path: edit, commit, push', async () => {
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

  test('an out-of-sparse-range error surfaces as a GitkitClientError with its code', async () => {
    const e = await client.call('files.read', { path: 'src/index.ts' })
      .catch((x: GitkitClientError) => x)
    expect(e).toBeInstanceOf(GitkitClientError)
    expect((e as GitkitClientError).code).toBe('PATH_OUTSIDE_SPARSE')
    expect((e as GitkitClientError).status).toBe(400)
  })

  test('an etag conflict sets isStale and brings the server content back', async () => {
    const first = await client.call('files.read', { path: 'docs/a.md' })
    if (first.binary) throw new Error('unreachable')
    await client.call('files.write', { path: 'docs/a.md', content: 'from another tab' })

    const e = await client.call('files.write', {
      path: 'docs/a.md', content: 'my edit', baseEtag: first.etag,
    }).catch((x: GitkitClientError) => x) as GitkitClientError

    expect(e.isStale).toBe(true)
    expect(e.current?.content).toBe('from another tab')
    // This write must not have landed
    const now = await client.call('files.read', { path: 'docs/a.md' })
    if (now.binary) throw new Error('unreachable')
    expect(now.content).toBe('from another tab')
  })

  test('the conflict result carries no server paths and can be resolved and pushed', async () => {
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

  test('a session you may not access gives 404 SESSION_NOT_FOUND', async () => {
    const other = client.withSession('sess_bob')
    const e = await other.call('status', {}).catch((x: GitkitClientError) => x) as GitkitClientError
    expect(e.code).toBe('SESSION_NOT_FOUND')
    expect(e.isGone).toBe(true)
  })

  test('an op that is not allowed gives 404 and does not reveal that it exists', async () => {
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

describe('the Express adapter', () => {
  test('converts Express-style req/res and keeps the status code', async () => {
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

  test('error status codes pass through too', async () => {
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
