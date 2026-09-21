import type { GitRepo } from '@treenwang/gitkit'
import { OP_NAMES, type OpName } from '@treenwang/gitkit-client'
import { TransportError, toWireError } from './errors'
import { OPS, type OpContext } from './ops'

/**
 * The security boundary.
 *
 * The protocol has no url, root, worktreeDir or token. The browser sends an
 * opaque sessionId and nothing else; the host resolves it here and does its own
 * authentication and tenant isolation. Returning null means 404 - deliberately
 * not distinguishing "does not exist" from "not allowed", so the existence of a
 * session never leaks.
 */
export type ResolveSession = (
  req: Request,
  sessionId: string,
) => Promise<GitRepo | null> | GitRepo | null

export type HandlerConfig = {
  resolveSession: ResolveSession
  /** Allowed ops. Anything unlisted answers 404 rather than revealing that it exists. All ops by default. */
  allow?: readonly OpName[]
  /** A fine-grained per-request decision, applied after allow. */
  can?: (req: Request, op: OpName) => boolean | Promise<boolean>
  /** Serialize per sessionId, so concurrent writes cannot collide on index.lock. True by default. */
  serialize?: boolean
  /** Byte ceiling for content fields in a single response. 1 MB by default. */
  maxContentBytes?: number
  /**
   * Whether to send GitOpError.detail to the browser. detail holds absolute
   * server paths, so this is false by default and meant for internal tools
   * only.
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
        throw new TransportError('OP_NOT_ALLOWED', 'only POST is accepted')
      }

      const op = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? ''
      if (!allowed.has(op as OpName) || !(op in OPS)) {
        throw new TransportError('OP_NOT_ALLOWED', `operation not available: ${op}`)
      }
      if (cfg.can && !(await cfg.can(req, op as OpName))) {
        throw new TransportError('OP_NOT_ALLOWED', `operation not available: ${op}`)
      }

      const body = await readJson(req)
      const sessionId = body.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new TransportError('INVALID_ARGUMENT', 'sessionId is missing')
      }

      const run = async (): Promise<Response> => {
        const repo = await cfg.resolveSession(req, sessionId)
        if (!repo) {
          throw new TransportError('SESSION_NOT_FOUND', 'no such session, or access is not allowed')
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
    throw new TransportError('INVALID_ARGUMENT', 'the request body could not be read')
  }
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new TransportError('INVALID_ARGUMENT', 'the request body is not a valid JSON object')
  }
}
