import { posix } from 'node:path'
import { GitOpError } from '../types'

export type Layout = {
  key: string
  repoDir: string
  storeDir: string
  worktreeRoot: string
}

const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'file:'])

/** 路径段中只保留安全字符，避免 `..`、分隔符等进入文件系统路径。 */
function safeSegment(seg: string): string {
  return seg.replace(/\.\./g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
}

export function planLayout(root: string, url: string): Layout {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GitOpError('INVALID_ARGUMENT', `无法解析仓库 URL: ${url}`)
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `只支持 http(s)/file URL，收到: ${parsed.protocol}`,
    )
  }

  const rawHost = parsed.hostname || (parsed.protocol === 'file:' ? 'local' : '')
  if (!rawHost) throw new GitOpError('INVALID_ARGUMENT', `URL 缺少 host: ${url}`)
  const host = parsed.port
    ? `${rawHost.toLowerCase()}_${parsed.port}`
    : rawHost.toLowerCase()

  const segments = decodeURIComponent(parsed.pathname)
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
    .map(safeSegment)

  if (segments.length === 0) {
    throw new GitOpError('INVALID_ARGUMENT', `URL 缺少路径: ${url}`)
  }
  if (parsed.protocol !== 'file:' && segments.length < 2) {
    throw new GitOpError('INVALID_ARGUMENT', `URL 缺少 owner/repo: ${url}`)
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
    throw new GitOpError('INVALID_ARGUMENT', `非法 sessionId: ${sessionId}`)
  }
  return posix.join(worktreeRoot, sessionId)
}
