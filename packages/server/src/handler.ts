import type { GitRepo } from '@aaxis/gitkit'
import { OP_NAMES, type OpName } from '@aaxis/gitkit-client'
import { TransportError, toWireError } from './errors'
import { OPS, type OpContext } from './ops'

/**
 * 安全边界。
 *
 * 协议中不存在 url / root / worktreeDir / token —— 浏览器只发送一个不透明的
 * sessionId，由宿主在此解析并完成鉴权与租户隔离。返回 null 即 404
 * （不区分「不存在」与「无权限」，避免泄露 session 是否存在）。
 */
export type ResolveSession = (
  req: Request,
  sessionId: string,
) => Promise<GitRepo | null> | GitRepo | null

export type HandlerConfig = {
  resolveSession: ResolveSession
  /** 开放的 op 白名单。未列出的一律 404，不暴露其存在。默认全开。 */
  allow?: readonly OpName[]
  /** 逐请求的细粒度判断，在 allow 之后执行。 */
  can?: (req: Request, op: OpName) => boolean | Promise<boolean>
  /** 按 sessionId 串行化，防止并发写撞 index.lock。默认 true。 */
  serialize?: boolean
  /** 单次响应中内容字段的字节上限。默认 1 MB。 */
  maxContentBytes?: number
  /**
   * 是否把 GitOpError.detail 发给浏览器。detail 含服务端文件系统绝对路径，
   * 默认 false，仅供内部工具开启。
   */
  exposeDetail?: boolean
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export function createHandler(cfg: HandlerConfig): (req: Request) => Promise<Response> {
  const allowed = new Set<OpName>(cfg.allow ?? OP_NAMES)
  const serialize = cfg.serialize ?? true
  const maxContentBytes = cfg.maxContentBytes ?? 1_048_576
  const exposeDetail = cfg.exposeDetail ?? false
  const queues = new Map<string, Promise<unknown>>()

  async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!serialize) return fn()
    const prev = queues.get(key) ?? Promise.resolve()
    const result = prev.then(fn, fn)
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    queues.set(key, tail)
    return result
  }

  return async function handle(req: Request): Promise<Response> {
    try {
      if (req.method !== 'POST') {
        throw new TransportError('OP_NOT_ALLOWED', '只接受 POST')
      }

      const op = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''
      if (!allowed.has(op as OpName) || !(op in OPS)) {
        throw new TransportError('OP_NOT_ALLOWED', `未开放的操作: ${op}`)
      }
      if (cfg.can && !(await cfg.can(req, op as OpName))) {
        throw new TransportError('OP_NOT_ALLOWED', `未开放的操作: ${op}`)
      }

      const body = await readJson(req)
      const sessionId = body.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new TransportError('INVALID_ARGUMENT', '缺少 sessionId')
      }

      const run = async (): Promise<Response> => {
        const repo = await cfg.resolveSession(req, sessionId)
        if (!repo) {
          throw new TransportError('SESSION_NOT_FOUND', 'session 不存在或无权访问')
        }
        const ctx: OpContext = { repo, maxContentBytes }
        const impl = OPS[op as OpName] as (c: OpContext, p: unknown) => Promise<unknown>
        const { sessionId: _omit, ...params } = body
        const result = await impl(ctx, params)
        return new Response(JSON.stringify(result ?? {}), { status: 200, headers: JSON_HEADERS })
      }

      return await serialized(sessionId, run)
    } catch (err) {
      const { status, body } = toWireError(err, { exposeDetail })
      return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
    }
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await req.text()
  } catch {
    throw new TransportError('INVALID_ARGUMENT', '无法读取请求体')
  }
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new TransportError('INVALID_ARGUMENT', '请求体不是合法的 JSON 对象')
  }
}
