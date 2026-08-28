import type { GitErrorCode } from '../types'

/**
 * stderr 模式 → 错误码。顺序敏感：先匹配者胜。
 * 匹配不中一律返回 UNKNOWN —— 猜错的错误码比没有错误码更有害。
 */
const RULES: Array<[RegExp, GitErrorCode]> = [
  [/authentication failed|invalid username or password|could not read username|returned error: 40[13]/i, 'AUTH_FAILED'],
  [/could not resolve host|failed to connect|connection timed out|connection refused|network is unreachable|ssl certificate problem/i, 'NETWORK'],
  [/not a git repository/i, 'NOT_A_REPO'],
  [/not something we can merge|couldn't find remote ref|unknown revision or path not in the working tree/i, 'BRANCH_NOT_FOUND'],
  [/is already checked out at|is already used by worktree/i, 'BRANCH_IN_USE'],
  [/a branch named .* already exists|already exists$/im, 'BRANCH_EXISTS'],
  [/you have not concluded your merge|merge_head exists|you are in the middle of a merge/i, 'MERGE_IN_PROGRESS'],
  [/local changes to the following files would be overwritten|your local changes would be overwritten/i, 'DIRTY_WORKTREE'],
]

export function mapGitError(stderr: string): GitErrorCode {
  if (!stderr) return 'UNKNOWN'
  for (const [re, code] of RULES) {
    if (re.test(stderr)) return code
  }
  return 'UNKNOWN'
}
