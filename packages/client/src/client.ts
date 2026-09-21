import {
  type OpName,
  type OpParams,
  type OpResult,
  type WireError,
  type WireErrorCode,
} from './protocol'

export class GitkitClientError extends Error {
  readonly code: WireErrorCode
  readonly status: number
  readonly detail?: string
  readonly current?: { content: string; etag: string }

  constructor(status: number, wire: WireError) {
    super(wire.message)
    this.name = 'GitkitClientError'
    this.status = status
    this.code = wire.code
    if (wire.detail !== undefined) this.detail = wire.detail
    if (wire.current !== undefined) this.current = wire.current
  }

  /** The file changed on the server, so this write did not land. Offer the caller overwrite, view the difference, or discard. */
  get isStale(): boolean {
    return this.code === 'STALE_ETAG'
  }

  /** The session is gone. The UI should start the user over rather than retry. */
  get isGone(): boolean {
    return this.code === 'WORKTREE_DISPOSED' || this.code === 'SESSION_NOT_FOUND'
  }
}

export type ClientConfig = {
  /** Where the handler is mounted, e.g. '/api/admin/skills/git'. */
  baseUrl: string
  /** The current session. withSession derives a client bound to a different one. */
  sessionId?: string
  /** Extra request headers, for authentication and the like. A function lets them be refreshed per request. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** Defaults to 'include', so the host's cookie session applies. */
  credentials?: RequestCredentials
  fetch?: typeof globalThis.fetch
}

export type CallOptions = {
  signal?: AbortSignal
  /** Useful for the last save when the page is being hidden. */
  keepalive?: boolean
}

export class GitkitClient {
  readonly #cfg: ClientConfig

  constructor(cfg: ClientConfig) {
    this.#cfg = cfg
  }

  get sessionId(): string | undefined {
    return this.#cfg.sessionId
  }

  /** Derive a client bound to another session. Configuration is shared; the two do not affect each other. */
  withSession(sessionId: string): GitkitClient {
    return new GitkitClient({ ...this.#cfg, sessionId })
  }

  async call<K extends OpName>(
    op: K,
    params: OpParams<K>,
    opts: CallOptions = {},
  ): Promise<OpResult<K>> {
    const sessionId = this.#cfg.sessionId
    if (!sessionId) {
      throw new GitkitClientError(0, {
        code: 'INVALID_ARGUMENT',
        message: 'this client has no sessionId; derive one with withSession(id)',
      })
    }

    const extra =
      typeof this.#cfg.headers === 'function' ? await this.#cfg.headers() : this.#cfg.headers
    const doFetch = this.#cfg.fetch ?? globalThis.fetch

    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify({ sessionId, ...params }),
      credentials: this.#cfg.credentials ?? 'include',
    }
    if (opts.signal) init.signal = opts.signal
    if (opts.keepalive) init.keepalive = true

    let res: Response
    try {
      res = await doFetch(`${this.#cfg.baseUrl.replace(/\/$/, '')}/${op}`, init)
    } catch (cause) {
      // A network-level failure (offline, CORS, aborted) has no HTTP status code
      throw new GitkitClientError(0, {
        code: (cause as Error)?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
        message: (cause as Error)?.message ?? 'the request failed',
      })
    }

    const text = await res.text()
    const body: unknown = text ? safeParse(text) : undefined

    if (!res.ok) {
      const wire = (body as { error?: WireError } | undefined)?.error
      throw new GitkitClientError(
        res.status,
        wire ?? { code: 'UNKNOWN', message: `HTTP ${res.status}` },
      )
    }
    return body as OpResult<K>
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function createClient(cfg: ClientConfig): GitkitClient {
  return new GitkitClient(cfg)
}
