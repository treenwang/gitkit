import { describe, expect, test } from 'vitest'
import { mapGitError } from '../../src/domain/error-mapper'

describe('mapGitError', () => {
  const cases: Array<[string, string, string]> = [
    ['authentication failure', "fatal: Authentication failed for 'https://github.com/a/b.git/'", 'AUTH_FAILED'],
    ['403', 'fatal: unable to access: The requested URL returned error: 403', 'AUTH_FAILED'],
    ['DNS failure', 'fatal: unable to access: Could not resolve host: github.com', 'NETWORK'],
    ['connection timeout', 'fatal: unable to access: Failed to connect to github.com port 443: Connection timed out', 'NETWORK'],
    ['not a repository', 'fatal: not a git repository (or any of the parent directories): .git', 'NOT_A_REPO'],
    ['dirty worktree', 'error: Your local changes to the following files would be overwritten by merge:', 'DIRTY_WORKTREE'],
    ['merge in progress', 'fatal: You have not concluded your merge (MERGE_HEAD exists).', 'MERGE_IN_PROGRESS'],
    ['branch already in use', "fatal: 'feat/x' is already checked out at '/data/wt/a'", 'BRANCH_IN_USE'],
    ['branch already exists', "fatal: a branch named 'feat/x' already exists", 'BRANCH_EXISTS'],
    ['no such ref', "merge: origin/nope - not something we can merge", 'BRANCH_NOT_FOUND'],
    ['remote ref not found', "fatal: couldn't find remote ref refs/heads/nope", 'BRANCH_NOT_FOUND'],
  ]

  for (const [name, stderr, expected] of cases) {
    test(name, () => {
      expect(mapGitError(stderr)).toBe(expected as never)
    })
  }

  test('returns UNKNOWN when nothing matches, and never guesses', () => {
    expect(mapGitError('fatal: something nobody has ever seen before')).toBe('UNKNOWN')
  })

  test('empty stderr returns UNKNOWN', () => {
    expect(mapGitError('')).toBe('UNKNOWN')
  })

  test('matching ignores case', () => {
    expect(mapGitError('FATAL: AUTHENTICATION FAILED for x')).toBe('AUTH_FAILED')
  })
})
