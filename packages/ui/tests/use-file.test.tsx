import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { GitkitClient, GitkitClientError } from '@aaxis/gitkit-client'
import { GitkitProvider } from '../src/context'
import { useFile } from '../src/hooks/use-file'

type Call = { op: string; params: any; keepalive?: boolean }

/** 直接替换 client.call，比打桩 fetch 更贴近 hook 的实际依赖面。 */
function fakeClient(handlers: Record<string, (p: any) => any>, calls: Call[] = []) {
  const c = new GitkitClient({ baseUrl: '/g', sessionId: 'sess_1' })
  ;(c as any).call = async (op: string, params: any, opts: any = {}) => {
    calls.push({ op, params, keepalive: opts.keepalive })
    const h = handlers[op]
    if (!h) throw new Error(`未打桩的 op: ${op}`)
    return h(params)
  }
  return c
}

function wrapper(client: GitkitClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc },
      createElement(GitkitProvider, { client }, children))
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

let calls: Call[]
beforeEach(() => { calls = [] })
afterEach(() => { document.body.innerHTML = '' })

const READ_OK = { binary: false, content: 'hello', etag: 'e1', size: 5, truncated: false }

describe('加载', () => {
  test('加载文本文件后填充内容与 etag', async () => {
    const client = fakeClient({ 'files.read': () => READ_OK }, calls)
    const { result } = renderHook(() => useFile('docs/a.md'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.content).toBe('hello')
    expect(result.current.etag).toBe('e1')
    expect(result.current.binary).toBe(false)
    expect(result.current.saveState).toBe('clean')
  })

  test('二进制文件不给 content', async () => {
    const client = fakeClient({ 'files.read': () => ({ binary: true, size: 42 }) }, calls)
    const { result } = renderHook(() => useFile('docs/x.bin'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.binary).toBe(true)
    expect(result.current.content).toBeUndefined()
    expect(result.current.size).toBe(42)
  })

  test('加载失败暴露 loadError', async () => {
    const client = fakeClient({
      'files.read': () => { throw new GitkitClientError(400, { code: 'PATH_OUTSIDE_SPARSE', message: '越界' }) },
    }, calls)
    const { result } = renderHook(() => useFile('src/x.ts'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect((result.current.loadError as GitkitClientError).code).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('truncated 透传', async () => {
    const client = fakeClient({
      'files.read': () => ({ ...READ_OK, truncated: true, size: 999999 }),
    }, calls)
    const { result } = renderHook(() => useFile('docs/big.md'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.truncated).toBe(true)
  })
})

describe('自动保存状态机', () => {
  async function mounted(opts = {}) {
    const client = fakeClient({
      'files.read': () => READ_OK,
      'files.write': () => ({ etag: 'e2' }),
    }, calls)
    const r = renderHook(() => useFile('docs/a.md', opts), { wrapper: wrapper(client) })
    await waitFor(() => expect(r.result.current.loading).toBe(false))
    return r
  }

  test('输入后立刻变 dirty，尚未保存', async () => {
    const { result } = await mounted({ debounceMs: 50 })
    act(() => { result.current.setContent('x') })
    expect(result.current.saveState).toBe('dirty')
    expect(calls.filter((c) => c.op === 'files.write')).toHaveLength(0)
  })

  test('防抖到期后保存，状态转为 saved 并更新 etag', async () => {
    const { result } = await mounted({ debounceMs: 30 })
    act(() => { result.current.setContent('changed') })
    await waitFor(() => expect(result.current.saveState).toBe('saved'))
    const w = calls.find((c) => c.op === 'files.write')!
    expect(w.params).toEqual({ path: 'docs/a.md', content: 'changed', baseEtag: 'e1' })
    expect(result.current.etag).toBe('e2')
  })

  test('连续输入只保存一次（防抖生效）', async () => {
    const { result } = await mounted({ debounceMs: 40 })
    act(() => { result.current.setContent('a') })
    await act(async () => { await tick(10) })
    act(() => { result.current.setContent('ab') })
    await act(async () => { await tick(10) })
    act(() => { result.current.setContent('abc') })
    await waitFor(() => expect(result.current.saveState).toBe('saved'))
    const writes = calls.filter((c) => c.op === 'files.write')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.params.content).toBe('abc')
  })

  test('maxWait：持续输入时仍会按上限强制落盘', async () => {
    const { result } = await mounted({ debounceMs: 1000, maxWaitMs: 60 })
    for (let i = 0; i < 6; i += 1) {
      act(() => { result.current.setContent(`v${i}`) })
      await act(async () => { await tick(15) })
    }
    // 防抖是 1000ms，若无 maxWait 则一次都不会保存
    await waitFor(() => expect(calls.filter((c) => c.op === 'files.write').length).toBeGreaterThan(0))
  })

  test('save() 立即保存，不等防抖', async () => {
    const { result } = await mounted({ debounceMs: 10_000 })
    act(() => { result.current.setContent('now') })
    await act(async () => { await result.current.save() })
    expect(calls.filter((c) => c.op === 'files.write')).toHaveLength(1)
    expect(result.current.saveState).toBe('saved')
  })

  test('autoSave: false 时输入不触发保存', async () => {
    const { result } = await mounted({ autoSave: false, debounceMs: 10 })
    act(() => { result.current.setContent('x') })
    await act(async () => { await tick(60) })
    expect(calls.filter((c) => c.op === 'files.write')).toHaveLength(0)
    expect(result.current.saveState).toBe('dirty')
  })

  test('保存失败转为 error 且保留本地内容，可重试', async () => {
    let fail = true
    const client = fakeClient({
      'files.read': () => READ_OK,
      'files.write': () => {
        if (fail) { fail = false; throw new GitkitClientError(504, { code: 'NETWORK', message: '断网' }) }
        return { etag: 'e9' }
      },
    }, calls)
    const { result } = renderHook(() => useFile('docs/a.md', { debounceMs: 20 }), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => { result.current.setContent('keep me') })
    await waitFor(() => expect(result.current.saveState).toBe('error'))
    expect(result.current.content).toBe('keep me')

    await act(async () => { await result.current.save() })
    expect(result.current.saveState).toBe('saved')
    expect(result.current.etag).toBe('e9')
  })

  test('切换 path 时重置状态并加载新文件', async () => {
    const client = fakeClient({
      'files.read': (p: any) => ({
        binary: false, content: `body of ${p.path}`, etag: `etag-${p.path}`,
        size: 1, truncated: false,
      }),
      'files.write': () => ({ etag: 'e2' }),
    }, calls)
    const { result, rerender } = renderHook(({ path }) => useFile(path, { debounceMs: 20 }), {
      wrapper: wrapper(client), initialProps: { path: 'docs/a.md' },
    })
    await waitFor(() => expect(result.current.content).toBe('body of docs/a.md'))
    act(() => { result.current.setContent('unsaved') })
    expect(result.current.saveState).toBe('dirty')

    rerender({ path: 'docs/b.md' })
    await waitFor(() => expect(result.current.content).toBe('body of docs/b.md'))
    expect(result.current.saveState).toBe('clean')
    expect(result.current.etag).toBe('etag-docs/b.md')
  })

  test('页面隐藏时用 keepalive 抢救未落盘的改动', async () => {
    const { result } = await mounted({ debounceMs: 10_000 })
    act(() => { result.current.setContent('rescue me') })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await tick(5)
    })
    const w = calls.find((c) => c.op === 'files.write')
    expect(w).toBeDefined()
    expect(w!.keepalive).toBe(true)
    expect(w!.params.content).toBe('rescue me')
  })
})

describe('etag 冲突的三条分支', () => {
  function staleClient() {
    return fakeClient({
      'files.read': () => READ_OK,
      'files.write': (p: any) => {
        if (p.baseEtag === 'e1') {
          throw new GitkitClientError(409, {
            code: 'STALE_ETAG', message: '文件已被改动',
            current: { content: 'server wins', etag: 'e-server' },
          })
        }
        return { etag: 'e-forced' }
      },
    }, calls)
  }

  async function conflicted() {
    const client = staleClient()
    const r = renderHook(() => useFile('docs/a.md', { debounceMs: 10 }), { wrapper: wrapper(client) })
    await waitFor(() => expect(r.result.current.loading).toBe(false))
    act(() => { r.result.current.setContent('my edit') })
    await waitFor(() => expect(r.result.current.staleConflict).toBeDefined())
    return r
  }

  test('冲突时暴露服务端内容与本地内容，状态为 error', async () => {
    const { result } = await conflicted()
    expect(result.current.saveState).toBe('error')
    expect(result.current.staleConflict).toEqual({
      serverContent: 'server wins',
      serverEtag: 'e-server',
      localContent: 'my edit',
    })
    // 本地内容仍在编辑器里，没有被吞掉
    expect(result.current.content).toBe('my edit')
  })

  test('分支一：覆盖 —— 不带 baseEtag 强制写入', async () => {
    const { result } = await conflicted()
    await act(async () => { await result.current.overwriteRemote() })
    const forced = calls.filter((c) => c.op === 'files.write').at(-1)!
    expect('baseEtag' in forced.params).toBe(false)
    expect(result.current.saveState).toBe('saved')
    expect(result.current.staleConflict).toBeUndefined()
    expect(result.current.etag).toBe('e-forced')
  })

  test('分支二：放弃 —— 采用服务端内容与 etag', async () => {
    const { result } = await conflicted()
    act(() => { result.current.discardLocal() })
    expect(result.current.content).toBe('server wins')
    expect(result.current.etag).toBe('e-server')
    expect(result.current.staleConflict).toBeUndefined()
    expect(result.current.saveState).toBe('clean')
  })

  test('分支三：查看差异 —— 两侧内容都在，由调用方渲染', async () => {
    const { result } = await conflicted()
    const c = result.current.staleConflict!
    expect(c.localContent).not.toBe(c.serverContent)
  })

  test('放弃后再编辑用新 etag 保存，不再冲突', async () => {
    const { result } = await conflicted()
    act(() => { result.current.discardLocal() })
    act(() => { result.current.setContent('after discard') })
    await waitFor(() => expect(result.current.saveState).toBe('saved'))
    const last = calls.filter((c) => c.op === 'files.write').at(-1)!
    expect(last.params.baseEtag).toBe('e-server')
  })
})
