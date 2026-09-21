import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { GitkitClient, GitkitClientError } from '@treenwang/gitkit-client'
import { GitkitProvider } from '../src/context'
import { useFile } from '../src/hooks/use-file'

type Call = { op: string; params: any; keepalive?: boolean }

/** Replacing client.call directly sits closer to what the hook actually depends on than stubbing fetch. */
function fakeClient(handlers: Record<string, (p: any) => any>, calls: Call[] = []) {
  const c = new GitkitClient({ baseUrl: '/g', sessionId: 'sess_1' })
  ;(c as any).call = async (op: string, params: any, opts: any = {}) => {
    calls.push({ op, params, keepalive: opts.keepalive })
    const h = handlers[op]
    if (!h) throw new Error(`op not stubbed: ${op}`)
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

describe('loading', () => {
  test('fills in content and etag after loading a text file', async () => {
    const client = fakeClient({ 'files.read': () => READ_OK }, calls)
    const { result } = renderHook(() => useFile('docs/a.md'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.content).toBe('hello')
    expect(result.current.etag).toBe('e1')
    expect(result.current.binary).toBe(false)
    expect(result.current.saveState).toBe('clean')
  })

  test('withholds content for a binary file', async () => {
    const client = fakeClient({ 'files.read': () => ({ binary: true, size: 42 }) }, calls)
    const { result } = renderHook(() => useFile('docs/x.bin'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.binary).toBe(true)
    expect(result.current.content).toBeUndefined()
    expect(result.current.size).toBe(42)
  })

  test('exposes loadError when loading fails', async () => {
    const client = fakeClient({
      'files.read': () => { throw new GitkitClientError(400, { code: 'PATH_OUTSIDE_SPARSE', message: 'out of range' }) },
    }, calls)
    const { result } = renderHook(() => useFile('src/x.ts'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect((result.current.loadError as GitkitClientError).code).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('passes truncated through', async () => {
    const client = fakeClient({
      'files.read': () => ({ ...READ_OK, truncated: true, size: 999999 }),
    }, calls)
    const { result } = renderHook(() => useFile('docs/big.md'), { wrapper: wrapper(client) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.truncated).toBe(true)
  })
})

describe('the autosave state machine', () => {
  async function mounted(opts = {}) {
    const client = fakeClient({
      'files.read': () => READ_OK,
      'files.write': () => ({ etag: 'e2' }),
    }, calls)
    const r = renderHook(() => useFile('docs/a.md', opts), { wrapper: wrapper(client) })
    await waitFor(() => expect(r.result.current.loading).toBe(false))
    return r
  }

  test('goes dirty as soon as you type, before any save', async () => {
    const { result } = await mounted({ debounceMs: 50 })
    act(() => { result.current.setContent('x') })
    expect(result.current.saveState).toBe('dirty')
    expect(calls.filter((c) => c.op === 'files.write')).toHaveLength(0)
  })

  test('saves once the debounce elapses, moving to saved and updating the etag', async () => {
    const { result } = await mounted({ debounceMs: 30 })
    act(() => { result.current.setContent('changed') })
    await waitFor(() => expect(result.current.saveState).toBe('saved'))
    const w = calls.find((c) => c.op === 'files.write')!
    expect(w.params).toEqual({ path: 'docs/a.md', content: 'changed', baseEtag: 'e1' })
    expect(result.current.etag).toBe('e2')
  })

  test('typing continuously saves only once, so the debounce works', async () => {
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

  test('maxWait still forces a write while typing continues', async () => {
    const { result } = await mounted({ debounceMs: 1000, maxWaitMs: 60 })
    for (let i = 0; i < 6; i += 1) {
      act(() => { result.current.setContent(`v${i}`) })
      await act(async () => { await tick(15) })
    }
    // The debounce is 1000ms, so without maxWait nothing would ever be saved
    await waitFor(() => expect(calls.filter((c) => c.op === 'files.write').length).toBeGreaterThan(0))
  })

  test('save() writes immediately, without waiting for the debounce', async () => {
    const { result } = await mounted({ debounceMs: 10_000 })
    act(() => { result.current.setContent('now') })
    await act(async () => { await result.current.save() })
    expect(calls.filter((c) => c.op === 'files.write')).toHaveLength(1)
    expect(result.current.saveState).toBe('saved')
  })

  test('typing triggers no save when autoSave is false', async () => {
    const { result } = await mounted({ autoSave: false, debounceMs: 10 })
    act(() => { result.current.setContent('x') })
    await act(async () => { await tick(60) })
    expect(calls.filter((c) => c.op === 'files.write')).toHaveLength(0)
    expect(result.current.saveState).toBe('dirty')
  })

  test('a failed save moves to error, keeps the local content, and can be retried', async () => {
    let fail = true
    const client = fakeClient({
      'files.read': () => READ_OK,
      'files.write': () => {
        if (fail) { fail = false; throw new GitkitClientError(504, { code: 'NETWORK', message: 'offline' }) }
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

  test('switching path resets the state and loads the new file', async () => {
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

  test('flushes unsaved changes before switching files instead of discarding them silently', async () => {
    const client = fakeClient({
      'files.read': (p: any) => ({
        binary: false, content: `body of ${p.path}`, etag: `etag-${p.path}`,
        size: 1, truncated: false,
      }),
      'files.write': () => ({ etag: 'e2' }),
    }, calls)
    const { result, rerender } = renderHook(({ path }) => useFile(path, { debounceMs: 10_000 }), {
      wrapper: wrapper(client), initialProps: { path: 'docs/a.md' },
    })
    await waitFor(() => expect(result.current.content).toBe('body of docs/a.md'))
    act(() => { result.current.setContent('unsaved edit') })

    rerender({ path: 'docs/b.md' })
    await waitFor(() => expect(calls.some((c) => c.op === 'files.write')).toBe(true))
    const w = calls.find((c) => c.op === 'files.write')!
    // What gets saved has to be the **previous** file's path and content
    expect(w.params.path).toBe('docs/a.md')
    expect(w.params.content).toBe('unsaved edit')
    expect(w.params.baseEtag).toBe('etag-docs/a.md')
  })

  test('switching files writes nothing when there is nothing pending', async () => {
    const client = fakeClient({
      'files.read': (p: any) => ({
        binary: false, content: 'x', etag: 'e', size: 1, truncated: false,
      }),
    }, calls)
    const { result, rerender } = renderHook(({ path }) => useFile(path), {
      wrapper: wrapper(client), initialProps: { path: 'docs/a.md' },
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ path: 'docs/b.md' })
    await act(async () => { await tick(20) })
    expect(calls.filter((c) => c.op === 'files.write')).toHaveLength(0)
  })

  test('with a very short debounce it saves the latest content, not the previous version', async () => {
    const client = fakeClient({
      'files.read': () => READ_OK,
      'files.write': () => ({ etag: 'e2' }),
    }, calls)
    const { result } = renderHook(() => useFile('docs/a.md', { debounceMs: 0 }), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => { result.current.setContent('final') })
    await waitFor(() => expect(calls.some((c) => c.op === 'files.write')).toBe(true))
    expect(calls.find((c) => c.op === 'files.write')!.params.content).toBe('final')
  })

  test('rescues unsaved changes with keepalive when the page is hidden', async () => {
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

describe('the three ways out of an etag conflict', () => {
  function staleClient() {
    return fakeClient({
      'files.read': () => READ_OK,
      'files.write': (p: any) => {
        if (p.baseEtag === 'e1') {
          throw new GitkitClientError(409, {
            code: 'STALE_ETAG', message: 'the file changed',
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

  test('exposes both the server content and the local content, in the error state', async () => {
    const { result } = await conflicted()
    expect(result.current.saveState).toBe('error')
    expect(result.current.staleConflict).toEqual({
      serverContent: 'server wins',
      serverEtag: 'e-server',
      localContent: 'my edit',
    })
    // The local content is still in the editor, not swallowed
    expect(result.current.content).toBe('my edit')
  })

  test('first way out: overwrite - force the write with no baseEtag', async () => {
    const { result } = await conflicted()
    await act(async () => { await result.current.overwriteRemote() })
    const forced = calls.filter((c) => c.op === 'files.write').at(-1)!
    expect('baseEtag' in forced.params).toBe(false)
    expect(result.current.saveState).toBe('saved')
    expect(result.current.staleConflict).toBeUndefined()
    expect(result.current.etag).toBe('e-forced')
  })

  test('second way out: discard - take the server\'s content and etag', async () => {
    const { result } = await conflicted()
    act(() => { result.current.discardLocal() })
    expect(result.current.content).toBe('server wins')
    expect(result.current.etag).toBe('e-server')
    expect(result.current.staleConflict).toBeUndefined()
    expect(result.current.saveState).toBe('clean')
  })

  test('third way out: compare - both sides are present for the caller to render', async () => {
    const { result } = await conflicted()
    const c = result.current.staleConflict!
    expect(c.localContent).not.toBe(c.serverContent)
  })

  test('editing again after a discard saves with the new etag and does not conflict', async () => {
    const { result } = await conflicted()
    act(() => { result.current.discardLocal() })
    act(() => { result.current.setContent('after discard') })
    await waitFor(() => expect(result.current.saveState).toBe('saved'))
    const last = calls.filter((c) => c.op === 'files.write').at(-1)!
    expect(last.params.baseEtag).toBe('e-server')
  })
})
