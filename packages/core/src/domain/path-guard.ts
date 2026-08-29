import { posix } from 'node:path'
import { GitOpError, type SparsePath } from '../types'

/**
 * 校验并解析 worktree 内的相对路径。
 *
 * 这是纯函数，不解析符号链接（那需要 IO）。FsGateway 在真正访问前会额外
 * 用 realpath 复核，堵住经符号链接逃逸的路径。
 */
export function resolveWithin(
  worktreeDir: string,
  relPath: string,
  sparse: readonly SparsePath[],
): string {
  if (!relPath || !relPath.trim()) {
    throw new GitOpError('INVALID_ARGUMENT', '路径不能为空')
  }

  const normalizedInput = relPath.replace(/\\/g, '/')
  if (posix.isAbsolute(normalizedInput)) {
    throw new GitOpError('PATH_TRAVERSAL', `不接受绝对路径: ${relPath}`)
  }

  const rel = posix
    .normalize(normalizedInput)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')

  if (rel === '..' || rel.startsWith('../')) {
    throw new GitOpError('PATH_TRAVERSAL', `路径越出 worktree: ${relPath}`)
  }
  if (rel === '.' || rel === '') {
    throw new GitOpError('INVALID_ARGUMENT', `路径不能指向 worktree 根自身: ${relPath}`)
  }
  if (rel === '.git' || rel.startsWith('.git/')) {
    throw new GitOpError('PATH_TRAVERSAL', `不允许访问 .git 目录: ${relPath}`)
  }

  if (sparse.length > 0) {
    const inScope = sparse.some((s) => rel === s.path || rel.startsWith(`${s.path}/`))
    if (!inScope) {
      const allowed = sparse.map((s) => s.path).join(', ')
      throw new GitOpError(
        'PATH_OUTSIDE_SPARSE',
        `路径 ${rel} 不在 sparse 范围内（允许: ${allowed}）`,
      )
    }
  }

  return posix.join(worktreeDir, rel)
}
