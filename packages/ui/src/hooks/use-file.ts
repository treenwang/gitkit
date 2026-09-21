import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { GitkitClientError } from '@treenwang/gitkit-client'
import { useGitkit } from '../context'
import { gitkitKeys } from '../keys'

export type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error'

export type StaleConflict = {
  /** What the server currently holds - a change made elsewhere, in another tab or by a pull. */
  serverContent: string
  serverEtag: string
  /** The local content that could not be saved. */
  localContent: string
}

export type UseFileOptions = {
  /** How long after typing stops to save. 800ms by default. */
  debounceMs?: number
  /** How often to force a save while typing continues. 5000ms by default. */
  maxWaitMs?: number
  /** Turn autosave off; only an explicit save() writes. */
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
  /** Non-null means the file changed on the server and this save did not land; the user has to decide. */
  staleConflict: StaleConflict | undefined
  setContent: (next: string) => void
  /** Save now, bypassing the debounce. Used when switching files, on blur, and when the page is hidden. */
  save: () => Promise<void>
  /** Take the server's content and discard the local changes. */
  discardLocal: () => void
  /** Force the local content over whatever the server holds. */
  overwriteRemote: () => Promise<void>
}

const DEBOUNCE_MS = 800
const MAX_WAIT_MS = 5000

/**
 * Loading and autosaving a single file.
 *
 * The workspace is the single source of truth: every edit ends up on the
 * server's disk, so switching devices, reloading the page or restarting the
 * process all pick up where you left off.
 *
 * Saves carry an etag optimistic lock. When the file changes on the server
 * while you are editing - another tab, or a pull - the write is refused rather
 * than silently overwriting, and the conflict is handed to the caller through
 * staleConflict.
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

  // Both the timer and the latest value live in refs: a debounced callback runs later, when the state in its closure is stale
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const firstDirtyAt = useRef<number | undefined>(undefined)
  // A timer callback runs later, when the state in its closure is stale, so the
  // latest value is kept in a ref. The important part: setContent writes that
  // ref **synchronously** rather than waiting for a render - otherwise, with a
  // very short debounce, the timer can fire before React re-renders and save
  // the previous version.
  const latest = useRef<{ content: string | undefined; etag: string | undefined; path: string }>({
    content: undefined, etag: undefined, path,
  })

  const clearTimer = (): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
  }

  // ---------------------------------------------------------------- loading

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
          latest.current = { content: undefined, etag: undefined, path }
        } else {
          setBinary(false)
          setContentState(r.content)
          setEtag(r.etag)
          setSize(r.size)
          setTruncated(r.truncated)
          latest.current = { content: r.content, etag: r.etag, path }
        }
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => {
      cancelled = true
      // Flush before switching files, or clicking another file would silently
      // discard changes that had not cleared the debounce yet. This fires one
      // save from the previous snapshot, while latest still holds the old file.
      if (timer.current !== undefined) {
        clearTimer()
        const snap = latest.current
        if (snap.content !== undefined) {
          const params: { path: string; content: string; baseEtag?: string } = {
            path: snap.path, content: snap.content,
          }
          if (snap.etag !== undefined) params.baseEtag = snap.etag
          void client.call('files.write', params).catch(() => undefined)
        }
      }
      clearTimer()
    }
  }, [client, path])

  // ---------------------------------------------------------------- saving

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
        latest.current.etag = r.etag
        setEtag(r.etag)
        setStale(undefined)
        setSaveState('saved')
        // A save changes the working tree, so the change list and diff have to be refetched
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
      latest.current = { ...latest.current, content: next }
      setContentState(next)
      setSaveState('dirty')
      if (!autoSave) return

      const now = Date.now()
      firstDirtyAt.current ??= now
      clearTimer()

      // maxWait: keep writing at a fixed interval while typing continues, instead of being pushed back by the debounce forever
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
    latest.current = {
      ...latest.current,
      content: staleConflict.serverContent,
      etag: staleConflict.serverEtag,
    }
    setStale(undefined)
    setSaveError(undefined)
    setSaveState('clean')
  }, [staleConflict])

  // When the page is hidden, rescue the last change with keepalive
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
