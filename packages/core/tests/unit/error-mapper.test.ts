import { describe, expect, test } from 'bun:test'
import { mapGitError } from '../../src/domain/error-mapper'

describe('mapGitError', () => {
  const cases: Array<[string, string, string]> = [
    ['认证失败', "fatal: Authentication failed for 'https://github.com/a/b.git/'", 'AUTH_FAILED'],
    ['403', 'fatal: unable to access: The requested URL returned error: 403', 'AUTH_FAILED'],
    ['DNS 失败', 'fatal: unable to access: Could not resolve host: github.com', 'NETWORK'],
    ['连接超时', 'fatal: unable to access: Failed to connect to github.com port 443: Connection timed out', 'NETWORK'],
    ['非仓库', 'fatal: not a git repository (or any of the parent directories): .git', 'NOT_A_REPO'],
    ['工作区脏', 'error: Your local changes to the following files would be overwritten by merge:', 'DIRTY_WORKTREE'],
    ['merge 进行中', 'fatal: You have not concluded your merge (MERGE_HEAD exists).', 'MERGE_IN_PROGRESS'],
    ['分支已被占用', "fatal: 'feat/x' is already checked out at '/data/wt/a'", 'BRANCH_IN_USE'],
    ['分支已存在', "fatal: a branch named 'feat/x' already exists", 'BRANCH_EXISTS'],
    ['ref 不存在', "merge: origin/nope - not something we can merge", 'BRANCH_NOT_FOUND'],
    ['远端 ref 找不到', "fatal: couldn't find remote ref refs/heads/nope", 'BRANCH_NOT_FOUND'],
  ]

  for (const [name, stderr, expected] of cases) {
    test(name, () => {
      expect(mapGitError(stderr)).toBe(expected as never)
    })
  }

  test('无法识别时返回 UNKNOWN，绝不猜测', () => {
    expect(mapGitError('fatal: something nobody has ever seen before')).toBe('UNKNOWN')
  })

  test('空 stderr 返回 UNKNOWN', () => {
    expect(mapGitError('')).toBe('UNKNOWN')
  })

  test('匹配不区分大小写', () => {
    expect(mapGitError('FATAL: AUTHENTICATION FAILED for x')).toBe('AUTH_FAILED')
  })
})
