import { describe, expect, test } from 'vitest'
import { GitOpError } from '@treenwang/gitkit'
import type { GitRepo } from '@treenwang/gitkit'
import { createHandler } from '../src/handler'
import { etagOf } from '../src/ops'

const SERVER_PATH = '/data/repos/github.com/acme/web/wt/s-a3f9c1'

/** Only what the tests need is implemented; any other method fails loudly rather than quietly taking an unexpected path. */
function fakeRepo(over: Partial<Record<keyof GitRepo, unknown>> = {}): GitRepo {
  const base = {
    dir: SERVER_PATH,
    branch: 'feat/x',
    sparsePaths: [{ path: 'docs', requireChecks: true }],
    status: async () => ({
      branch: 'feat/x', operation: null, staged: [], modified: [], untracked: [],
      conflicted: [], merging: false, clean: true,
    }),
  }
  return new Proxy({ ...base, ...over } as Record<string, unknown>, {
    get(t, k) {
      if (k in t) return t[k as string]
      // then has to stay undefined, or await would treat this object as a thenable
      if (typeof k !== 'string' || k === 'then') return undefined
      return () => { throw new Error(`unexpected call to ${k}`) }
    },
  }) as unknown as GitRepo
}

const post = (op: string, body: unknown = { sessionId: 's1' }) =>
  new Request(`http://x/api/git/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const mk = (over: Parameters<typeof createHandler>[0] extends infer C
  ? Partial<C> : never = {}) =>
  createHandler({ resolveSession: () => fakeRepo(), ...over } as Parameters<typeof createHandler>[0])

describe('the security boundary', () => {
  test('resolveSession returning null gives 404, not distinguishing missing from forbidden', async () => {
    const res = await mk({ resolveSession: () => null })(post('status'))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SESSION_NOT_FOUND')
  })

  test('resolveSession receives the original Request and the sessionId', async () => {
    let seen: { url: string; id: string } | undefined
    await mk({
      resolveSession: (req, id) => { seen = { url: req.url, id }; return fakeRepo() },
    })(post('status', { sessionId: 'sess_abc' }))
    expect(seen!.id).toBe('sess_abc')
    expect(seen!.url).toContain('/api/git/status')
  })

  test('an op outside allow gives 404 rather than 405, so its existence stays hidden', async () => {
    const res = await mk({ allow: ['status'] })(post('files.write'))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('OP_NOT_ALLOWED')
  })

  test('an unknown op gives 404', async () => {
    expect((await mk()(post('rm-rf'))).status).toBe(404)
  })

  test('can returning false gives 404', async () => {
    const res = await mk({ can: () => false })(post('status'))
    expect(res.status).toBe(404)
  })

  test('can runs after allow and may decide per request', async () => {
    const seen: string[] = []
    await mk({ can: (_req, op) => { seen.push(op); return true } })(post('status'))
    expect(seen).toEqual(['status'])
  })

  test('anything other than POST is refused', async () => {
    const res = await mk()(new Request('http://x/api/git/status', { method: 'GET' }))
    expect(res.status).toBe(404)
  })

  test('a missing sessionId gives 400 without calling resolveSession', async () => {
    let called = false
    const res = await mk({ resolveSession: () => { called = true; return fakeRepo() } })(
      post('status', {}),
    )
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  test('a body that is not a JSON object gives 400', async () => {
    const res = await mk()(new Request('http://x/api/git/status', {
      method: 'POST', body: '[1,2,3]',
    }))
    expect(res.status).toBe(400)
  })
})

describe('information filtering - server paths must never leak', () => {
  test('detail and command on a GitOpError are stripped by default', async () => {
    const err = new GitOpError('NOT_A_REPO', 'not a repository', {
      detail: `fatal: not a git repository: ${SERVER_PATH}/.git`,
      command: `git -c http.extraheader=… status`,
    })
    const res = await mk({ resolveSession: () => fakeRepo({ status: async () => { throw err } }) })(
      post('status'),
    )
    const text = await res.text()
    expect(text).not.toContain(SERVER_PATH)
    expect(text).not.toContain('http.extraheader')
    const body = JSON.parse(text)
    expect(body.error).toEqual({ code: 'NOT_A_REPO', message: 'not a repository' })
  })

  test('detail is included only with exposeDetail: true', async () => {
    const err = new GitOpError('UNKNOWN', 'x', { detail: 'server detail' })
    const res = await mk({
      exposeDetail: true,
      resolveSession: () => fakeRepo({ status: async () => { throw err } }),
    })(post('status'))
    expect((await res.json()).error.detail).toBe('server detail')
  })

  test('worktreeDir is stripped from a push conflict result', async () => {
    const repo = fakeRepo({
      push: async () => ({
        ok: false, pushed: false, reason: 'conflict',
        conflicts: [{ path: 'docs/a.md', type: 'both_modified', binary: false }],
        worktreeDir: SERVER_PATH,
      }),
    })
    const res = await mk({ resolveSession: () => repo })(post('push', { sessionId: 's1' }))
    const text = await res.text()
    expect(text).not.toContain(SERVER_PATH)
    const body = JSON.parse(text)
    expect(body.reason).toBe('conflict')
    expect(body.conflicts).toHaveLength(1)
    expect('worktreeDir' in body).toBe(false)
  })

  test('an unexpected non-GitOpError exception does not leak a stack either', async () => {
    const res = await mk({
      resolveSession: () => fakeRepo({
        status: async () => { throw new Error(`ENOENT: ${SERVER_PATH}/index.lock`) },
      }),
    })(post('status'))
    const body = await res.json()
    expect(body.error.code).toBe('UNKNOWN')
    expect(body.error.stack).toBeUndefined()
  })
})

describe('error code to HTTP mapping', () => {
  const cases: Array<[string, number]> = [
    ['PATH_OUTSIDE_SPARSE', 400], ['PATH_TRAVERSAL', 400], ['INVALID_ARGUMENT', 400],
    ['BRANCH_IN_USE', 409], ['MERGE_IN_PROGRESS', 409], ['DIRTY_WORKTREE', 409],
    ['WORKTREE_DISPOSED', 410],
    ['AUTH_FAILED', 502], ['NETWORK', 504], ['TIMEOUT', 504],
    ['FORGE_NOT_INSTALLED', 501], ['NOT_A_REPO', 500], ['UNKNOWN', 500],
  ]
  for (const [code, status] of cases) {
    test(`${code} → ${status}`, async () => {
      const res = await mk({
        resolveSession: () => fakeRepo({
          status: async () => { throw new GitOpError(code as never, 'x') },
        }),
      })(post('status'))
      expect(res.status).toBe(status)
    })
  }

  test('AUTH_FAILED is 502, not 401 - a 401 would read to the frontend as an expired user session', async () => {
    const res = await mk({
      resolveSession: () => fakeRepo({
        status: async () => { throw new GitOpError('AUTH_FAILED', 'the token expired') },
      }),
    })(post('status'))
    expect(res.status).toBe(502)
    expect(res.status).not.toBe(401)
  })
})

describe('serialization', () => {
  test('requests for one sessionId never overlap', async () => {
    const events: string[] = []
    let n = 0
    const handler = mk({
      resolveSession: () => fakeRepo({
        status: async () => {
          const id = ++n
          events.push(`start${id}`)
          await new Promise((r) => setTimeout(r, id === 1 ? 20 : 1))
          events.push(`end${id}`)
          return { branch: 'b', operation: null, staged: [], modified: [], untracked: [],
                   conflicted: [], merging: false, clean: true }
        },
      }),
    })
    await Promise.all([handler(post('status')), handler(post('status'))])
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2'])
  })

  test('different sessionIds run concurrently', async () => {
    const events: string[] = []
    const handler = mk({
      resolveSession: (_req, id) => fakeRepo({
        status: async () => {
          events.push(`start-${id}`)
          await new Promise((r) => setTimeout(r, id === 'a' ? 20 : 1))
          events.push(`end-${id}`)
          return { branch: 'b', operation: null, staged: [], modified: [], untracked: [],
                   conflicted: [], merging: false, clean: true }
        },
      }),
    })
    await Promise.all([
      handler(post('status', { sessionId: 'a' })),
      handler(post('status', { sessionId: 'b' })),
    ])
    expect(events.slice(0, 2)).toEqual(['start-a', 'start-b'])
  })

  test('one request throwing does not wedge the ones behind it', async () => {
    let first = true
    const handler = mk({
      resolveSession: () => fakeRepo({
        status: async () => {
          if (first) { first = false; throw new Error('boom') }
          return { branch: 'ok', operation: null, staged: [], modified: [], untracked: [],
                   conflicted: [], merging: false, clean: true }
        },
      }),
    })
    expect((await handler(post('status'))).status).toBe(500)
    expect((await (await handler(post('status'))).json()).branch).toBe('ok')
  })

  test('serialize: false does not queue', async () => {
    const events: string[] = []
    const handler = mk({
      serialize: false,
      resolveSession: () => fakeRepo({
        status: async () => {
          events.push('start')
          await new Promise((r) => setTimeout(r, 5))
          return { branch: 'b', operation: null, staged: [], modified: [], untracked: [],
                   conflicted: [], merging: false, clean: true }
        },
      }),
    })
    await Promise.all([handler(post('status')), handler(post('status'))])
    expect(events).toEqual(['start', 'start'])
  })
})

describe('etag', () => {
  test('same content same etag, different content different etag', () => {
    expect(etagOf('abc')).toBe(etagOf(Buffer.from('abc')))
    expect(etagOf('abc')).not.toBe(etagOf('abd'))
    expect(etagOf('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})
