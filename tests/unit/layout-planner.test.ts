import { describe, expect, test } from 'bun:test'
import { planLayout, worktreeDirFor } from '../../src/domain/layout-planner'
import { GitOpError } from '../../src/types'

describe('planLayout', () => {
  test('标准 https url', () => {
    const l = planLayout('/data/repos', 'https://github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).toBe('/data/repos/github.com/acme/web')
    expect(l.storeDir).toBe('/data/repos/github.com/acme/web/store')
    expect(l.worktreeRoot).toBe('/data/repos/github.com/acme/web/wt')
  })

  test('去掉 .git 后缀', () => {
    expect(planLayout('/r', 'https://github.com/acme/web.git').key).toBe('github.com/acme/web')
  })

  test('去掉尾部斜杠', () => {
    expect(planLayout('/r', 'https://github.com/acme/web/').key).toBe('github.com/acme/web')
  })

  test('host 小写化，path 保留大小写', () => {
    expect(planLayout('/r', 'https://GitHub.COM/Acme/Web').key).toBe('github.com/Acme/Web')
  })

  test('带端口的自建 GHE', () => {
    expect(planLayout('/r', 'https://git.corp.io:8443/g/p').key).toBe('git.corp.io_8443/g/p')
  })

  test('url 中的凭据被丢弃，不进入路径', () => {
    const l = planLayout('/r', 'https://user:tok@github.com/acme/web')
    expect(l.key).toBe('github.com/acme/web')
    expect(l.repoDir).not.toContain('tok')
  })

  test('路径段中的可疑字符被替换', () => {
    expect(planLayout('/r', 'https://github.com/a..b/c').key).toBe('github.com/a__b/c')
  })

  test('非 http(s)/file url 抛 INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'ssh://git@github.com/acme/web.git')).toThrow(GitOpError)
  })

  test('scp 风格 url 无法解析，抛 INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'git@github.com:acme/web.git')).toThrow(GitOpError)
  })

  test('缺少 owner/repo 抛 INVALID_ARGUMENT', () => {
    expect(() => planLayout('/r', 'https://github.com/')).toThrow(GitOpError)
  })

  test('file:// url 用于本地测试', () => {
    const l = planLayout('/r', 'file:///tmp/x/remote.git')
    expect(l.key).toBe('local/tmp/x/remote')
  })
})

describe('worktreeDirFor', () => {
  test('拼接 sessionId', () => {
    expect(worktreeDirFor('/r/wt', 'abc123')).toBe('/r/wt/abc123')
  })

  test('sessionId 含分隔符时抛错', () => {
    expect(() => worktreeDirFor('/r/wt', '../escape')).toThrow(GitOpError)
  })
})
