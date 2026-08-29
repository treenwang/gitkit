import { describe, expect, test } from 'bun:test'
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
    test(`放行 ${rev}`, () => expect(assertValidRevision(rev)).toBe(rev))
  }

  test('以 - 开头被拒 —— 这是唯一真正危险的一条', () => {
    for (const rev of ['--upload-pack=touch /tmp/pwned', '-x', '--help', '--exec=sh']) {
      expect(() => assertValidRevision(rev)).toThrow(GitOpError)
    }
  })

  const bad: Array<[string, string]> = [
    ['空串', ''],
    ['空格', 'main branch'],
    ['换行', `main${ch(10)}rm -rf`],
    ['制表符', `main${ch(9)}x`],
    ['NUL', `main${ch(0)}x`],
    ['反斜杠', 'main' + String.fromCharCode(92) + 'x'],
    ['过长', 'a'.repeat(256)],
  ]
  for (const [name, rev] of bad) {
    test(`拒绝：${name}`, () => expect(() => assertValidRevision(rev)).toThrow(GitOpError))
  }

  test('错误码是 INVALID_ARGUMENT', () => {
    try { assertValidRevision('-x') } catch (e) {
      expect((e as GitOpError).code).toBe('INVALID_ARGUMENT')
    }
  })
})
