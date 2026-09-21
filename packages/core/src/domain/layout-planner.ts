import { posix } from 'node:path'
import { GitOpError } from '../types'

export type Layout = {
  key: string
  repoDir: string
  storeDir: string
  worktreeRoot: string
}

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'file:'])

/** Keep only safe characters in a path segment, so `..` and separators cannot reach a filesystem path. */
function safeSegment(seg: string): string {
  return seg.replace(/\.\./g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
}

export function planLayout(root: string, url: string): Layout {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GitOpError('INVALID_ARGUMENT', `cannot parse the repository URL: ${url}`)
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `only http(s) and file URLs are supported, got: ${parsed.protocol}`,
    )
  }

  const rawHost = parsed.hostname || (parsed.protocol === 'file:' ? 'local' : '')
  if (!rawHost) throw new GitOpError('INVALID_ARGUMENT', `URL has no host: ${url}`)
  const host = parsed.port
    ? `${rawHost.toLowerCase()}_${parsed.port}`
    : rawHost.toLowerCase()

  const segments = decodeURIComponent(parsed.pathname)
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
    .map(safeSegment)

  if (segments.length === 0) {
    throw new GitOpError('INVALID_ARGUMENT', `URL has no path: ${url}`)
  }
  if (parsed.protocol !== 'file:' && segments.length < 2) {
    throw new GitOpError('INVALID_ARGUMENT', `URL has no owner/repo: ${url}`)
  }

  const key = [safeSegment(host), ...segments].join('/')
  const repoDir = posix.join(root, key)
  return {
    key,
    repoDir,
    storeDir: posix.join(repoDir, 'store'),
    worktreeRoot: posix.join(repoDir, 'wt'),
  }
}

export function worktreeDirFor(worktreeRoot: string, sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) {
    throw new GitOpError('INVALID_ARGUMENT', `invalid sessionId: ${sessionId}`)
  }
  return posix.join(worktreeRoot, sessionId)
}
