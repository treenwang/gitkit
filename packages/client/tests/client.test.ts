import { describe, expect, test } from 'bun:test'
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

describe('请求形状', () => {
  test('op 拼进 URL，sessionId 与参数合并进 body', async () => {
    const log: Recorded[] = []
    const c = mk(fakeFetch(() => json({ etag: 'e1' }), log))
    await c.call('files.write', { path: 'docs/a.md', content: 'x', baseEtag: 'e0' })

    expect(log[0]!.url).toBe('/api/git/files.write')
    expect(log[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(log[0]!.init.body))).toEqual({
      sessionId: 'sess_1', path: 'docs/a.md', content: 'x', baseEtag: 'e0',
    })
  })

  test('baseUrl 尾部斜杠不会产生双斜杠', async () => {
    const log: Recorded[] = []
    await createClient({ baseUrl: '/api/git/', sessionId: 's', fetch: fakeFetch(() => json({}), log) })
      .call('status', {})
    expect(log[0]!.url).toBe('/api/git/status')
  })

  test('默认带 credentials: include，让宿主 cookie 生效', async () => {
    const log: Recorded[] = []
    await mk(fakeFetch(() => json({}), log)).call('status', {})
    expect(log[0]!.init.credentials).toBe('include')
  })

  test('静态 headers 被合并', async () => {
    const log: Recorded[] = []
    await createClient({
      baseUrl: '/g', sessionId: 's', headers: { 'x-csrf': 'tok' },
      fetch: fakeFetch(() => json({}), log),
    }).call('status', {})
    expect((log[0]!.init.headers as Record<string, string>)['x-csrf']).toBe('tok')
  })

  test('函数式 headers 每次请求求值（支持刷新令牌）', async () => {
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

  test('keepalive 透传（页面隐藏时的最后一次保存）', async () => {
    const log: Recorded[] = []
    await mk(fakeFetch(() => json({ etag: 'e' }), log))
      .call('files.write', { path: 'a', content: 'b' }, { keepalive: true })
    expect(log[0]!.init.keepalive).toBe(true)
  })

  test('未绑定 sessionId 时不发请求，直接抛错', async () => {
    const log: Recorded[] = []
    const c = createClient({ baseUrl: '/g', fetch: fakeFetch(() => json({}), log) })
    await expect(c.call('status', {})).rejects.toThrow(GitkitClientError)
    expect(log).toHaveLength(0)
  })

  test('withSession 派生出新实例，原实例不受影响', async () => {
    const log: Recorded[] = []
    const base = createClient({ baseUrl: '/g', sessionId: 'a', fetch: fakeFetch(() => json({}), log) })
    const derived = base.withSession('b')
    expect(base.sessionId).toBe('a')
    expect(derived.sessionId).toBe('b')
    await derived.call('status', {})
    expect(JSON.parse(String(log[0]!.init.body)).sessionId).toBe('b')
  })
})

describe('错误反序列化', () => {
  test('结构化错误被还原为 GitkitClientError', async () => {
    const c = mk(fakeFetch(() =>
      json({ error: { code: 'PATH_OUTSIDE_SPARSE', message: '不在范围内' } }, 400)))
    try {
      await c.call('files.read', { path: 'src/x.ts' })
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as GitkitClientError
      expect(err).toBeInstanceOf(GitkitClientError)
      expect(err.code).toBe('PATH_OUTSIDE_SPARSE')
      expect(err.status).toBe(400)
      expect(err.message).toBe('不在范围内')
    }
  })

  test('STALE_ETAG 带回服务端当前内容，isStale 为 true', async () => {
    const c = mk(fakeFetch(() =>
      json({ error: {
        code: 'STALE_ETAG', message: '文件已被改动',
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

  test('WORKTREE_DISPOSED 与 SESSION_NOT_FOUND 的 isGone 为 true', async () => {
    for (const [code, status] of [['WORKTREE_DISPOSED', 410], ['SESSION_NOT_FOUND', 404]] as const) {
      const c = mk(fakeFetch(() => json({ error: { code, message: 'gone' } }, status)))
      const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
      expect((err as GitkitClientError).isGone).toBe(true)
    }
  })

  test('非结构化响应退化为 UNKNOWN 并保留状态码', async () => {
    const c = mk(fakeFetch(() => new Response('<html>502</html>', { status: 502 })))
    const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
    expect((err as GitkitClientError).code).toBe('UNKNOWN')
    expect((err as GitkitClientError).status).toBe(502)
  })

  test('网络层失败映射为 NETWORK，status 为 0', async () => {
    const c = mk(fakeFetch(() => { throw new TypeError('Failed to fetch') }))
    const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
    expect((err as GitkitClientError).code).toBe('NETWORK')
    expect((err as GitkitClientError).status).toBe(0)
  })

  test('中止映射为 TIMEOUT', async () => {
    const c = mk(fakeFetch(() => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }))
    const err = await c.call('status', {}).catch((e: GitkitClientError) => e)
    expect((err as GitkitClientError).code).toBe('TIMEOUT')
  })

  test('signal 透传给 fetch', async () => {
    const log: Recorded[] = []
    const ac = new AbortController()
    await mk(fakeFetch(() => json({}), log)).call('status', {}, { signal: ac.signal })
    expect(log[0]!.init.signal).toBe(ac.signal)
  })
})

describe('成功响应', () => {
  test('直接返回反序列化后的结果', async () => {
    const c = mk(fakeFetch(() => json({ patch: 'diff --git …', truncated: false })))
    expect(await c.call('changes.diff', {})).toEqual({ patch: 'diff --git …', truncated: false })
  })

  test('空响应体不报错', async () => {
    const c = mk(fakeFetch(() => new Response('', { status: 200 })))
    expect(await c.call('status', {})).toBeUndefined()
  })
})

describe('协议表', () => {
  test('OP_NAMES 无重复', () => {
    expect(new Set(OP_NAMES).size).toBe(OP_NAMES.length)
  })

  test('OP_NAMES 覆盖阶段 1 与阶段 2 的全部 op', () => {
    for (const op of ['status', 'files.read', 'files.write', 'files.delete', 'commit',
      'push', 'sync.pull', 'conflicts.list', 'conflicts.resolve']) {
      expect(OP_NAMES).toContain(op as never)
    }
  })
})
