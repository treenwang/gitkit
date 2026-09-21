import { describe, expect, test } from 'vitest'
import { assertValidRevision } from '../../src/domain/ref-guard'
import { GitOpError } from '../../src/types'

const ch = (n: number): string => String.fromCharCode(n)

describe('assertValidRevision', () => {
  const ok = [
    'main', 'origin/main', 'HEAD', 'HEAD~1', 'HEAD^', 'HEAD^^', 'HEAD~10',
    '@{u}', 'refs/heads/feat/x', 'feat/x-1', 'v1.2.3',
    'a'.repeat(40), 'skills/user-01HX3Q',
  ]
  for (const rev of ok) {
    test(`allows ${rev}`, () => expect(assertValidRevision(rev)).toBe(rev))
  }

  test('a leading - is refused - the one genuinely dangerous case', () => {
    for (const rev of ['--upload-pack=touch /tmp/pwned', '-x', '--help', '--exec=sh']) {
      expect(() => assertValidRevision(rev)).toThrow(GitOpError)
    }
  })

  const bad: Array<[string, string]> = [
    ['empty string', ''],
    ['space', 'main branch'],
    ['newline', `main${ch(10)}rm -rf`],
    ['tab', `main${ch(9)}x`],
    ['NUL', `main${ch(0)}x`],
    ['backslash', 'main' + String.fromCharCode(92) + 'x'],
    ['too long', 'a'.repeat(256)],
  ]
  for (const [name, rev] of bad) {
    test(`refuses: ${name}`, () => expect(() => assertValidRevision(rev)).toThrow(GitOpError))
  }

  test('the error code is INVALID_ARGUMENT', () => {
    try { assertValidRevision('-x') } catch (e) {
      expect((e as GitOpError).code).toBe('INVALID_ARGUMENT')
    }
  })
})
