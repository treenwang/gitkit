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

  /** 服务端文件已被改动，本次写入未生效。调用方应呈现「覆盖 / 查看差异 / 放弃」。 */
  get isStale(): boolean {
    return this.code === 'STALE_ETAG'
  }

  /** session 已销毁，UI 应引导用户重新开始，而不是重试。 */
  get isGone(): boolean {
    return this.code === 'WORKTREE_DISPOSED' || this.code === 'SESSION_NOT_FOUND'
  }
}

export type ClientConfig = {
  /** handler 的挂载地址，例如 '/api/admin/skills/git'。 */
  baseUrl: string
  /** 当前 session。可用 withSession 派生出绑定不同 session 的 client。 */
  sessionId?: string
  /** 附加请求头（鉴权等）。可以是函数以支持每次请求刷新。 */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** 默认 'include'，使宿主的 cookie 会话生效。 */
  credentials?: RequestCredentials
  fetch?: typeof globalThis.fetch
}

export type CallOptions = {
  signal?: AbortSignal
  /** 页面隐藏时的最后一次保存用得上。 */
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

  /** 派生一个绑定到指定 session 的新 client；配置共享，互不影响。 */
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
        message: 'client 未绑定 sessionId；请用 withSession(id) 派生',
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
      // 网络层失败（离线、CORS、被中止）没有 HTTP 状态码
      throw new GitkitClientError(0, {
        code: (cause as Error)?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
        message: (cause as Error)?.message ?? '请求失败',
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
