import { GitOpError } from '@treenwang/gitkit'
import type { WireError, WireErrorCode } from '@treenwang/gitkit-client'

/** Failures the transport owns, with no counterpart in the core package. */
export class TransportError extends Error {
  constructor(
    readonly code: Extract<
      WireErrorCode,
      'SESSION_NOT_FOUND' | 'OP_NOT_ALLOWED' | 'STALE_ETAG' | 'ALREADY_EXISTS' | 'INVALID_ARGUMENT'
    >,
    message: string,
    readonly extra: { current?: { content: string; etag: string } } = {},
  ) {
    super(message)
    this.name = 'TransportError'
  }
}

const STATUS: Partial<Record<WireErrorCode, number>> = {
  SESSION_NOT_FOUND: 404,
  OP_NOT_ALLOWED: 404,
  INVALID_ARGUMENT: 400,
  PATH_OUTSIDE_SPARSE: 400,
  PATH_TRAVERSAL: 400,
  STALE_ETAG: 409,
  ALREADY_EXISTS: 409,
  BRANCH_IN_USE: 409,
  BRANCH_EXISTS: 409,
  BRANCH_NOT_FOUND: 409,
  MERGE_IN_PROGRESS: 409,
  DIRTY_WORKTREE: 409,
  WORKTREE_DISPOSED: 410,
  // An upstream git auth failure, not a browser user who is signed out.
  // Mapping it to 401 would make frontend interceptors read it as an expired
  // session and start a re-login.
  AUTH_FAILED: 502,
  NETWORK: 504,
  TIMEOUT: 504,
  FORGE_NOT_INSTALLED: 501,
  FORGE_API_ERROR: 502,
  GIT_NOT_FOUND: 500,
  GIT_VERSION_TOO_OLD: 500,
  NOT_A_REPO: 500,
  UNKNOWN: 500,
}

export function statusFor(code: WireErrorCode): number {
  return STATUS[code] ?? 500
}

/**
 * Turn any exception into a shape that is safe to send to a browser.
 *
 * detail and command hold absolute server paths, so they are stripped by
 * default.
 */
export function toWireError(
  err: unknown,
  opts: { exposeDetail: boolean },
): { status: number; body: { error: WireError } } {
  if (err instanceof TransportError) {
    const wire: WireError = { code: err.code, message: err.message }
    if (err.extra.current) wire.current = err.extra.current
    return { status: statusFor(err.code), body: { error: wire } }
  }

  if (err instanceof GitOpError) {
    const code = err.code as WireErrorCode
    const wire: WireError = { code, message: err.message }
    if (opts.exposeDetail && err.detail) wire.detail = err.detail
    return { status: statusFor(code), body: { error: wire } }
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
      },
    },
  }
}
