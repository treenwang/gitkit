import { describe, expect, test } from 'vitest'
import { GitkitClient, GitkitClientError, createClient } from '../src/client'
import { OP_NAMES } from '../src/protocol'

type Recorded = { url: string; init: RequestInit }

function fakeFetch(
  respond: (rec: Recorded) => Response | Promise<Response>,
  log: Recorded[] = [],
): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    const rec = { url: String(url), init }
    log.push(rec)
    return respond(rec)
  }) as unknown as typeof globalThis.fetch
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function mk(fetchImpl: typeof globalThis.fetch, sessionId = 'sess_1'): GitkitClient {
  return createClient({ baseUrl: '/api/git/', sessionId, fetch: fetchImpl })
}

describe('request shape', () => {
  test('the op goes into the URL; sessionId and params merge into the body', async () => {
    const log: Recorded[] = []
    const c = mk(fakeFetch(() => json({ etag: 'e1' }), log))
    await c.call('files.write', { path: 'docs/a.md', content: 'x', baseEtag: 'e0' })

    expect(log[0]!.url).toBe('/api/git/files.write')
    expect(log[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(log[0]!.init.body))).toEqual({
      sessionId: 'sess_1', path: 'docs/a.md', content: 'x', baseEtag: 'e0',
    })
  })

  test('a trailing slash on baseUrl does not produce a double slash', async () => {
    const log: Recorded[] = []
    await createClient({ baseUrl: '/api/git/', sessionId: 's', fetch: fakeFetch(() => json({}), log) })
      .call('status', {})
    expect(log[0]!.url).toBe('/api/git/status')
  })

  test('sends credentials: include by default, so the host cookie applies', async () => {
    const log: Recorded[] = []
    await mk(fakeFetch(() => json({}), log)).call('status', {})
    expect(log[0]!.init.credentials).toBe('include')
  })

  test('static headers are merged in', async () => {
    const log: Recorded[] = []
    await createClient({
      baseUrl: '/g', sessionId: 's', headers: { 'x-csrf': 'tok' },
      fetch: fakeFetch(() => json({}), log),
    }).call('status', {})
    expect((log[0]!.init.headers as Record<string, string>)['x-csrf']).toBe('tok')
  })

  test('headers as a function are evaluated per request, which supports refreshing a token', async () => {
    const log: Recorded[] = []
    let n = 0
    const c = createClient({
      baseUrl: '/g', sessionId: 's', headers: () => ({ 'x-n': String(++n) }),
      fetch: fakeFetch(() => json({}), log),
    })
    await c.call('status', {})
    await c.call('status', {})
    expect((log[0]!.init.headers as Record<string, string>)['x-n']).toBe('1')
    expect((log[1]!.init.headers as Record<string, string>)['x-n']).toBe('2')
  })

  test('keepalive is passed through, for the last save as the page is hidden', async () => {
    const log: Recorded[] = []
    await mk(fakeFetch(() => json({ etag: 'e' }), log))
      .call('files.write', { path: 'a', content: 'b' }, { keepalive: true })
    expect(log[0]!.init.keepalive).toBe(true)
  })

  test('throws without sending a request when no sessionId is bound', async () => {
    const log: Recorded[] = []
    const c = createClient({ baseUrl: '/g', fetch: fakeFetch(() => json({}), log) })
    await expect(c.call('status', {})).rejects.toThrow(GitkitClientError)
    expect(log).toHaveLength(0)
  })

  test('withSession derives a new instance and leaves the original alone', async () => {
    const log: Recorded[] = []
    const base = createClient({ baseUrl: '/g', sessionId: 'a', fetch: fakeFetch(() => json({}), log) })
    const derived = base.withSession('b')
    expect(base.sessionId).toBe('a')
    expect(derived.sessionId).toBe('b')
    await derived.call('status', {})
    expect(JSON.parse(String(log[0]!.init.body)).sessionId).toBe('b')
  })
})

describe('error deserialization', () => {
  test('a structured error comes back as a GitkitClientError', async () => {
    const c = mk(fakeFetch(() =>
      json({ error: { code: 'PATH_OUTSIDE_SPARSE', message: 'out of range' } }, 400)))
    try {
      await c.call('files.read', { path: 'src/x.ts' })
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as GitkitClientError
      expect(err).toBeInstanceOf(GitkitClientError)
      expect(err.code).toBe('PATH_OUTSIDE_SPARSE')
      expect(err.status).toBe(400)
      expect(err.message).toBe('out of range')
    }
  })

  test('STALE_ETAG carries the server content back and isStale is true', async () => {
    const c = mk(fakeFetch(() =>
      json({ error: {
        code: 'STALE_ETAG', message: 'the file changed',
        current: { content: 'server side', etag: 'e2' },
      } }, 409)))
    try {
      await c.call('files.write', { path: 'a', content: 'b', baseEtag: 'e1' })
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as GitkitClientError
      expect(err.isStale).toBe(true)
      expect(err.current).toEqual({ content: 'server side', etag: 'e2' })
    }
  })

  test('isGone is true for WORKTREE_DISPOSED and SESSION_NOT_FOUND', async () => {
    for (const [code, status] of [['WORKTREE_DISPOSED', 410], ['SESSION_NOT_FOUND', 404]] as const) {
      const c = mk(fakeFetch(() => json({ error: { code, message: 'gone' } }, status)))
      const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
      expect((err as GitkitClientError).isGone).toBe(true)
    }
  })

  test('an unstructured response degrades to UNKNOWN and keeps the status code', async () => {
    const c = mk(fakeFetch(() => new Response('<html>502</html>', { status: 502 })))
    const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
    expect((err as GitkitClientError).code).toBe('UNKNOWN')
    expect((err as GitkitClientError).status).toBe(502)
  })

  test('a network-level failure maps to NETWORK with status 0', async () => {
    const c = mk(fakeFetch(() => { throw new TypeError('Failed to fetch') }))
    const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
    expect((err as GitkitClientError).code).toBe('NETWORK')
    expect((err as GitkitClientError).status).toBe(0)
  })

  test('an abort maps to TIMEOUT', async () => {
    const c = mk(fakeFetch(() => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }))
    const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
    expect((err as GitkitClientError).code).toBe('TIMEOUT')
  })

  test('signal is passed through to fetch', async () => {
    const log: Recorded[] = []
    const ac = new AbortController()
    await mk(fakeFetch(() => json({}), log)).call('status', {}, { signal: ac.signal })
    expect(log[0]!.init.signal).toBe(ac.signal)
  })
})

describe('successful responses', () => {
  test('returns the deserialized result directly', async () => {
    const c = mk(fakeFetch(() => json({ patch: 'diff --git …', truncated: false })))
    expect(await c.call('changes.diff', {})).toEqual({ patch: 'diff --git …', truncated: false })
  })

  test('an empty body is not an error', async () => {
    const c = mk(fakeFetch(() => new Response('', { status: 200 })))
    expect(await c.call('status', {})).toBeUndefined()
  })
})

describe('the protocol table', () => {
  test('OP_NAMES has no duplicates', () => {
    expect(new Set(OP_NAMES).size).toBe(OP_NAMES.length)
  })

  test('OP_NAMES covers every op from phase 1 and phase 2', () => {
    for (const op of ['status', 'files.read', 'files.write', 'files.delete', 'commit',
      'push', 'sync.pull', 'conflicts.list', 'conflicts.resolve']) {
      expect(OP_NAMES).toContain(op as never)
    }
  })
})
