import { describe, expect, test } from 'bun:test'
import { GitOpError } from '@aaxis/gitkit'
import type { GitRepo } from '@aaxis/gitkit'
import { createHandler } from '../src/handler'
import { etagOf } from '../src/ops'

const SERVER_PATH = '/data/repos/github.com/acme/web/wt/s-a3f9c1'

/** 只实现测试用到的部分；其余方法调用即失败，避免悄悄走到未预期的路径。 */
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
      // 必须让 then 保持 undefined，否则 await 会把这个对象当成 thenable
      if (typeof k !== 'string' || k === 'then') return undefined
      return () => { throw new Error(`未预期地调用了 ${k}`) }
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

describe('安全边界', () => {
  test('resolveSession 返回 null → 404（不区分不存在与无权限）', async () => {
    const res = await mk({ resolveSession: () => null })(post('status'))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('SESSION_NOT_FOUND')
  })

  test('resolveSession 收到原始 Request 与 sessionId', async () => {
    let seen: { url: string; id: string } | undefined
    await mk({
      resolveSession: (req, id) => { seen = { url: req.url, id }; return fakeRepo() },
    })(post('status', { sessionId: 'sess_abc' }))
    expect(seen!.id).toBe('sess_abc')
    expect(seen!.url).toContain('/api/git/status')
  })

  test('allow 之外的 op → 404，而不是 405（不暴露其存在）', async () => {
    const res = await mk({ allow: ['status'] })(post('files.write'))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('OP_NOT_ALLOWED')
  })

  test('未知 op → 404', async () => {
    expect((await mk()(post('rm-rf'))).status).toBe(404)
  })

  test('can 返回 false → 404', async () => {
    const res = await mk({ can: () => false })(post('status'))
    expect(res.status).toBe(404)
  })

  test('can 在 allow 之后执行，可按请求判断', async () => {
    const seen: string[] = []
    await mk({ can: (_req, op) => { seen.push(op); return true } })(post('status'))
    expect(seen).toEqual(['status'])
  })

  test('非 POST 一律拒绝', async () => {
    const res = await mk()(new Request('http://x/api/git/status', { method: 'GET' }))
    expect(res.status).toBe(404)
  })

  test('缺少 sessionId → 400，且不调用 resolveSession', async () => {
    let called = false
    const res = await mk({ resolveSession: () => { called = true; return fakeRepo() } })(
      post('status', {}),
    )
    expect(res.status).toBe(400)
    expect(called).toBe(false)
  })

  test('请求体不是 JSON 对象 → 400', async () => {
    const res = await mk()(new Request('http://x/api/git/status', {
      method: 'POST', body: '[1,2,3]',
    }))
    expect(res.status).toBe(400)
  })
})

describe('信息过滤 —— 服务端路径绝不能泄露', () => {
  test('GitOpError 的 detail 与 command 默认被剥除', async () => {
    const err = new GitOpError('NOT_A_REPO', '不是仓库', {
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
    expect(body.error).toEqual({ code: 'NOT_A_REPO', message: '不是仓库' })
  })

  test('exposeDetail: true 时才带 detail', async () => {
    const err = new GitOpError('UNKNOWN', 'x', { detail: 'server detail' })
    const res = await mk({
      exposeDetail: true,
      resolveSession: () => fakeRepo({ status: async () => { throw err } }),
    })(post('status'))
    expect((await res.json()).error.detail).toBe('server detail')
  })

  test('push 冲突结果中的 worktreeDir 被剥除', async () => {
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

  test('非 GitOpError 的意外异常也不泄露堆栈', async () => {
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

describe('错误码 → HTTP 映射', () => {
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

  test('AUTH_FAILED 是 502 而不是 401 —— 401 会让前端误判为用户会话过期', async () => {
    const res = await mk({
      resolveSession: () => fakeRepo({
        status: async () => { throw new GitOpError('AUTH_FAILED', 'token 失效') },
      }),
    })(post('status'))
    expect(res.status).toBe(502)
    expect(res.status).not.toBe(401)
  })
})

describe('串行化', () => {
  test('同一 sessionId 的请求不重叠', async () => {
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

  test('不同 sessionId 可并发', async () => {
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

  test('一个请求抛错不会卡死后续请求', async () => {
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

  test('serialize: false 时不排队', async () => {
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
  test('同内容同 etag，不同内容不同 etag', () => {
    expect(etagOf('abc')).toBe(etagOf(Buffer.from('abc')))
    expect(etagOf('abc')).not.toBe(etagOf('abd'))
    expect(etagOf('abc')).toMatch(/^[0-9a-f]{64}$/)
  })
})
