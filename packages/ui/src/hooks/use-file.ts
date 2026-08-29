import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { GitkitClientError } from '@aaxis/gitkit-client'
import { useGitkit } from '../context'
import { gitkitKeys } from '../keys'

export type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error'

export type StaleConflict = {
  /** 服务端当前内容 —— 别处（另一个标签页、一次 pull）产生的改动。 */
  serverContent: string
  serverEtag: string
  /** 用户本地未能保存的内容。 */
  localContent: string
}

export type UseFileOptions = {
  /** 停止输入后多久保存。默认 800ms。 */
  debounceMs?: number
  /** 连续输入时至少多久强制保存一次。默认 5000ms。 */
  maxWaitMs?: number
  /** 关闭自动保存，只能显式调用 save()。 */
  autoSave?: boolean
}

export type UseFileResult = {
  content: string | undefined
  etag: string | undefined
  binary: boolean
  size: number | undefined
  truncated: boolean
  loading: boolean
  loadError: Error | undefined
  saveState: SaveState
  saveError: Error | undefined
  /** 非空表示服务端文件已被改动，本次保存未生效，需用户决策。 */
  staleConflict: StaleConflict | undefined
  setContent: (next: string) => void
  /** 立即保存（防抖之外）。切换文件、失焦、页面隐藏时使用。 */
  save: () => Promise<void>
  /** 以服务端内容为准，丢弃本地改动。 */
  discardLocal: () => void
  /** 强制用本地内容覆盖服务端。 */
  overwriteRemote: () => Promise<void>
}

const DEBOUNCE_MS = 800
const MAX_WAIT_MS = 5000

/**
 * 单个文件的加载与自动保存。
 *
 * 工作区是唯一真相：编辑最终都落到服务端磁盘，因此换设备、刷新页面、进程重启都能续上。
 * 保存带 etag 乐观锁 —— 服务端文件在编辑期间被改动时（另一个标签页、一次 pull），
 * 写入会被拒绝而不是无声覆盖，冲突通过 staleConflict 交给调用方决策。
 */
export function useFile(path: string, opts: UseFileOptions = {}): UseFileResult {
  const { client, } = useGitkit()
  const qc = useQueryClient()
  const session = client.sessionId ?? ''

  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS
  const maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS
  const autoSave = opts.autoSave ?? true

  const [content, setContentState] = useState<string | undefined>(undefined)
  const [etag, setEtag] = useState<string | undefined>(undefined)
  const [binary, setBinary] = useState(false)
  const [size, setSize] = useState<number | undefined>(undefined)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<Error | undefined>(undefined)
  const [saveState, setSaveState] = useState<SaveState>('clean')
  const [saveError, setSaveError] = useState<Error | undefined>(undefined)
  const [staleConflict, setStale] = useState<StaleConflict | undefined>(undefined)

  // 定时器与「最新值」都用 ref：回调被防抖延后执行，闭包里的 state 会是旧的
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const firstDirtyAt = useRef<number | undefined>(undefined)
  const latest = useRef({ content, etag, path })
  latest.current = { content, etag, path }

  const clearTimer = (): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
  }

  // ---------------------------------------------------------------- 加载

  useEffect(() => {
    let cancelled = false
    clearTimer()
    firstDirtyAt.current = undefined
    setLoading(true)
    setLoadError(undefined)
    setStale(undefined)
    setSaveError(undefined)
    setSaveState('clean')

    void client
      .call('files.read', { path })
      .then((r) => {
        if (cancelled) return
        if (r.binary) {
          setBinary(true)
          setContentState(undefined)
          setEtag(undefined)
          setSize(r.size)
          setTruncated(false)
        } else {
          setBinary(false)
          setContentState(r.content)
          setEtag(r.etag)
          setSize(r.size)
          setTruncated(r.truncated)
        }
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true; clearTimer() }
  }, [client, path])

  // ---------------------------------------------------------------- 保存

  const doSave = useCallback(
    async (force: boolean): Promise<void> => {
      const snapshot = latest.current
      if (snapshot.content === undefined) return
      clearTimer()
      firstDirtyAt.current = undefined
      setSaveState('saving')
      setSaveError(undefined)

      try {
        const params: {
          path: string; content: string; baseEtag?: string
        } = { path: snapshot.path, content: snapshot.content }
        if (!force && snapshot.etag !== undefined) params.baseEtag = snapshot.etag

        const r = await client.call('files.write', params)
        setEtag(r.etag)
        setStale(undefined)
        setSaveState('saved')
        // 保存改变了工作区状态，改动列表与 diff 需要重新拉取
        void qc.invalidateQueries({ queryKey: gitkitKeys.changes(session) })
        void qc.invalidateQueries({ queryKey: gitkitKeys.status(session) })
        void qc.invalidateQueries({ queryKey: gitkitKeys.diff(session) })
      } catch (e) {
        const err = e as GitkitClientError
        if (err instanceof GitkitClientError && err.isStale && err.current) {
          setStale({
            serverContent: err.current.content,
            serverEtag: err.current.etag,
            localContent: snapshot.content,
          })
        }
        setSaveError(err)
        setSaveState('error')
      }
    },
    [client, qc, session],
  )

  const setContent = useCallback(
    (next: string) => {
      setContentState(next)
      setSaveState('dirty')
      if (!autoSave) return

      const now = Date.now()
      firstDirtyAt.current ??= now
      clearTimer()

      // maxWait：连续输入时也保证按固定间隔落盘，不会一直被防抖推迟
      const elapsed = now - firstDirtyAt.current
      const wait = Math.max(0, Math.min(debounceMs, maxWaitMs - elapsed))
      timer.current = setTimeout(() => { void doSave(false) }, wait)
    },
    [autoSave, debounceMs, doSave, maxWaitMs],
  )

  const save = useCallback(async () => { await doSave(false) }, [doSave])
  const overwriteRemote = useCallback(async () => { await doSave(true) }, [doSave])

  const discardLocal = useCallback(() => {
    if (!staleConflict) return
    setContentState(staleConflict.serverContent)
    setEtag(staleConflict.serverEtag)
    setStale(undefined)
    setSaveError(undefined)
    setSaveState('clean')
  }, [staleConflict])

  // 页面隐藏时用 keepalive 抢救最后一次改动
  useEffect(() => {
    if (!autoSave || typeof document === 'undefined') return
    const onHide = (): void => {
      if (document.visibilityState !== 'hidden') return
      if (timer.current === undefined) return
      clearTimer()
      const snapshot = latest.current
      if (snapshot.content === undefined) return
      const params: { path: string; content: string; baseEtag?: string } = {
        path: snapshot.path, content: snapshot.content,
      }
      if (snapshot.etag !== undefined) params.baseEtag = snapshot.etag
      void client.call('files.write', params, { keepalive: true }).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [autoSave, client])

  return {
    content, etag, binary, size, truncated,
    loading, loadError, saveState, saveError, staleConflict,
    setContent, save, discardLocal, overwriteRemote,
  }
}
