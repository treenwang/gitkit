import { describe, expect, test } from 'vitest'
import { planLayout, worktreeDirFor } from '../../src/domain/layout-planner'
import { GitOpError } from '../../src/types'

describe('planLayout', () => {
  test('a standard https url', () => {
    const l = planLayout('/data/repos', 'https://github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).toBe('/data/repos/github.com/acme/web')
    expect(l.storeDir).toBe('/data/repos/github.com/acme/web/store')
    expect(l.worktreeRoot).toBe('/data/repos/github.com/acme/web/wt')
  })

  test('strips the .git suffix', () => {
    expect(planLayout('/r', 'https://github.com/acme/web.git').key).toBe('github.com/acme/web')
  })

  test('strips a trailing slash', () => {
    expect(planLayout('/r', 'https://github.com/acme/web/').key).toBe('github.com/acme/web')
  })

  test('the host is lowercased and the path keeps its case', () => {
    expect(planLayout('/r', 'https://GitHub.COM/Acme/Web').key).toBe('github.com/Acme/Web')
  })

  test('a self-hosted GHE with a port', () => {
    expect(planLayout('/r', 'https://git.corp.io:8443/g/p').key).toBe('git.corp.io_8443/g/p')
  })

  test('credentials in the url are dropped and never reach the path', () => {
    const l = planLayout('/r', 'https://user:tok@github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).not.toContain('tok')
  })

  test('suspicious characters in a path segment are replaced', () => {
    expect(planLayout('/r', 'https://github.com/a..b/c').key).toBe('github.com/a__b/c')
  })

  test('a url that is neither http(s) nor file throws INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'ssh://git@github.com/acme/web.git')).toThrow(GitOpError)
  })

  test('an scp-style url cannot be parsed and throws INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'git@github.com:acme/web.git')).toThrow(GitOpError)
  })

  test('a missing owner/repo throws INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'https://github.com/')).toThrow(GitOpError)
  })

  test('file:// urls, used by the local tests', () => {
    const l = planLayout('/r', 'file:///tmp/x/remote.git')
    expect(l.key).toBe('local/tmp/x/remote')
  })
})

describe('worktreeDirFor', () => {
  test('joins on the sessionId', () => {
    expect(worktreeDirFor('/r/wt', 'abc123')).toBe('/r/wt/abc123')
  })

  test('a sessionId containing a separator throws', () => {
    expect(() => worktreeDirFor('/r/wt', '../escape')).toThrow(GitOpError)
  })
})
