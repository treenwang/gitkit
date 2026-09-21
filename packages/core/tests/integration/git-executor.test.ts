import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { GitExecutor } from '../../src/exec/git-executor'
import { GitOpError, type ProgressEvent } from '../../src/types'
import { cleanup, makeBareRemote, tempDir } from '../helpers/fixtures'

let root: string
beforeEach(() => { root = tempDir() })
afterEach(() => { cleanup(root) })

describe('GitExecutor', () => {
  test('version parses the version number', async () => {
    const v = await new GitExecutor().version()
    expect(v.major).toBeGreaterThanOrEqual(2)
    expect(typeof v.raw).toBe('string')
  })

  test('run returns trimmed stdout', async () => {
    const bare = makeBareRemote(root)
    const out = await new GitExecutor().run(['ls-remote', '--heads', bare])
    expect(out).toContain('refs/heads/main')
    expect(out.endsWith('\n')).toBe(false)
  })

  test('a failure throws GitOpError with the mapped code', async () => {
    try {
      await new GitExecutor().run(['status'], { cwd: root })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(GitOpError)
      expect((e as GitOpError).code).toBe('NOT_A_REPO')
    }
  })

  test('neither the message nor command contains the token', async () => {
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

  test('a timeout throws TIMEOUT', async () => {
    try {
      await new GitExecutor({ timeout: 1 }).run(['ls-remote', 'https://10.255.255.1/x.git'])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('TIMEOUT')
    }
  })

  test('onProgress receives events with the right phase', async () => {
    const events: ProgressEvent[] = []
    const bare = makeBareRemote(root)
    const exec = new GitExecutor({ onProgress: (e) => events.push(e) })
    await exec.run(['clone', '--progress', bare, `${root}/c`], { phase: 'clone' })
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((e) => e.phase === 'clone')).toBe(true)
  })

  test('injects merge.conflictStyle=diff3 and the auth header', () => {
    const exec = new GitExecutor()
    expect(exec.buildArgs(['status'], {})).toContain('merge.conflictStyle=diff3')
    const withAuth = exec.buildArgs(['fetch'], { token: 'T' }).join(' ')
    expect(withAuth).toContain('http.extraheader=AUTHORIZATION: basic')
  })

  test('allowExitCodes lets an expected non-zero exit through', async () => {
    const bare = makeBareRemote(root)
    const exec = new GitExecutor()
    await exec.run(['clone', bare, `${root}/c`])
    const r = await exec.exec(['diff', '--quiet', 'HEAD'], {
      cwd: `${root}/c`, allowExitCodes: [1],
    })
    expect(r.exitCode).toBe(0)
  })

  test('a missing gitPath throws GIT_NOT_FOUND', async () => {
    try {
      await new GitExecutor({ gitPath: '/nonexistent/git' }).run(['--version'])
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as GitOpError).code).toBe('GIT_NOT_FOUND')
    }
  })
})
