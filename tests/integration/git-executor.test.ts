import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GitExecutor } from '../../src/exec/git-executor'
import { GitOpError, type ProgressEvent } from '../../src/types'
import { cleanup, makeBareRemote, tempDir } from '../helpers/fixtures'

let root: string
beforeEach(() => { root = tempDir() })
afterEach(() => { cleanup(root) })

describe('GitExecutor', () => {
  test('version 解析出版本号', async () => {
    const v = await new GitExecutor().version()
    expect(v.major).toBeGreaterThanOrEqual(2)
    expect(typeof v.raw).toBe('string')
  })

  test('run 返回 trim 后的 stdout', async () => {
    const bare = makeBareRemote(root)
    const out = await new GitExecutor().run(['ls-remote', '--heads', bare])
    expect(out).toContain('refs/heads/main')
    expect(out.endsWith('\n')).toBe(false)
  })

  test('失败时抛 GitOpError 且带映射后的 code', async () => {
    try {
      await new GitExecutor().run(['status'], { cwd: root })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(GitOpError)
      expect((e as GitOpError).code).toBe('NOT_A_REPO')
    }
  })

  test('错误信息与 command 中不含 token', async () => {
    const token = 'ghp_supersecrettoken'
    try {
      await new GitExecutor().run(['ls-remote', 'https://127.0.0.1:1/nope.git'], {
        token, timeout: 20_000,
      })
      throw new Error('should have thrown')
    } catch (e) {
      const err = e as GitOpError
      const blob = `${err.message}\n${err.detail}\n${err.command ?? ''}`
      expect(blob).not.toContain(token)
      expect(err.command).toContain('***')
    }
  })

  test('超时抛 TIMEOUT', async () => {
    try {
      await new GitExecutor({ timeout: 1 }).run(['ls-remote', 'https://10.255.255.1/x.git'])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('TIMEOUT')
    }
  })

  test('onProgress 收到事件且 phase 正确', async () => {
    const events: ProgressEvent[] = []
    const bare = makeBareRemote(root)
    const exec = new GitExecutor({ onProgress: (e) => events.push(e) })
    await exec.run(['clone', '--progress', bare, `${root}/c`], { phase: 'clone' })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.phase === 'clone')).toBe(true)
  })

  test('注入 merge.conflictStyle=diff3 与认证头', () => {
    const exec = new GitExecutor()
    expect(exec.buildArgs(['status'], {})).toContain('merge.conflictStyle=diff3')
    const withAuth = exec.buildArgs(['fetch'], { token: 'T' }).join(' ')
    expect(withAuth).toContain('http.extraheader=AUTHORIZATION: basic')
  })

  test('allowExitCodes 放行预期的非零退出', async () => {
    const bare = makeBareRemote(root)
    const exec = new GitExecutor()
    await exec.run(['clone', bare, `${root}/c`])
    const r = await exec.exec(['diff', '--quiet', 'HEAD'], {
      cwd: `${root}/c`, allowExitCodes: [1],
    })
    expect(r.exitCode).toBe(0)
  })

  test('gitPath 不存在时抛 GIT_NOT_FOUND', async () => {
    try {
      await new GitExecutor({ gitPath: '/nonexistent/git' }).run(['--version'])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('GIT_NOT_FOUND')
    }
  })
})
