import { posix } from 'node:path'
import { GitOpError, type SparsePath } from '../types'

/**
 * Validate and resolve a relative path inside the worktree.
 *
 * This is a pure function and does not resolve symlinks, which would need IO.
 * FsGateway re-checks with realpath immediately before access, closing the
 * symlink escape route.
 */
export function resolveWithin(
  worktreeDir: string,
  relPath: string,
  sparse: readonly SparsePath[],
): string {
  if (!relPath || !relPath.trim()) {
    throw new GitOpError('INVALID_ARGUMENT', 'the path cannot be empty')
  }

  const normalizedInput = relPath.replace(/\\/g, '/')
  if (posix.isAbsolute(normalizedInput)) {
    throw new GitOpError('PATH_TRAVERSAL', `absolute paths are not accepted: ${relPath}`)
  }

  const rel = posix
    .normalize(normalizedInput)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')

  if (rel === '..' || rel.startsWith('../')) {
    throw new GitOpError('PATH_TRAVERSAL', `path escapes the worktree: ${relPath}`)
  }
  if (rel === '.' || rel === '') {
    throw new GitOpError('INVALID_ARGUMENT', `the path cannot be the worktree root itself: ${relPath}`)
  }
  if (rel === '.git' || rel.startsWith('.git/')) {
    throw new GitOpError('PATH_TRAVERSAL', `access to the .git directory is not allowed: ${relPath}`)
  }

  if (sparse.length > 0) {
    const inScope = sparse.some((s) => rel === s.path || rel.startsWith(`${s.path}/`))
    if (!inScope) {
      const allowed = sparse.map((s) => s.path).join(', ')
      throw new GitOpError(
        'PATH_OUTSIDE_SPARSE',
        `path ${rel} is outside the sparse range (allowed: ${allowed})`,
      )
    }
  }

  return posix.join(worktreeDir, rel)
}
