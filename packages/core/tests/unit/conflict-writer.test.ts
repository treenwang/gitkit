import { describe, expect, test } from 'bun:test'
import { buildResolvedContent } from '../../src/domain/conflict-writer'
import { GitOpError } from '../../src/types'

const ONE = `head
<<<<<<< HEAD
OUR
||||||| base
BASE
=======
THEIR
>>>>>>> theirs
tail
`

const TWO = `l1
<<<<<<< HEAD
OUR2
||||||| b
l2
=======
THEIR2
>>>>>>> t
l3
<<<<<<< HEAD
OUR5
||||||| b
l5
=======
THEIR5
>>>>>>> t
`

describe('buildResolvedContent', () => {
  test("take ours", () => {
    expect(buildResolvedContent(ONE, ['ours'])).toBe('head\nOUR\ntail\n')
  })

  test("take theirs", () => {
    expect(buildResolvedContent(ONE, ['theirs'])).toBe('head\nTHEIR\ntail\n')
  })

  test("take base", () => {
    expect(buildResolvedContent(ONE, ['base'])).toBe('head\nBASE\ntail\n')
  })

  test("take both = ours 后接 theirs", () => {
    expect(buildResolvedContent(ONE, ['both'])).toBe('head\nOUR\nTHEIR\ntail\n')
  })

  test('手写内容替换整块', () => {
    expect(buildResolvedContent(ONE, [{ content: 'MERGED' }])).toBe('head\nMERGED\ntail\n')
  })

  test('手写多行内容', () => {
    expect(buildResolvedContent(ONE, [{ content: 'A\nB' }])).toBe('head\nA\nB\ntail\n')
  })

  test('手写空内容表示删除整块', () => {
    expect(buildResolvedContent(ONE, [{ content: '' }])).toBe('head\ntail\n')
  })

  test('多 hunk 混合选择', () => {
    expect(buildResolvedContent(TWO, ['ours', 'theirs']))
      .toBe('l1\nOUR2\nl3\nTHEIR5\n')
    expect(buildResolvedContent(TWO, ['theirs', { content: 'X' }]))
      .toBe('l1\nTHEIR2\nl3\nX\n')
    expect(buildResolvedContent(TWO, ['both', 'base']))
      .toBe('l1\nOUR2\nTHEIR2\nl3\nl5\n')
  })

  test('无冲突文本原样返回', () => {
    expect(buildResolvedContent('plain\ntext\n', [])).toBe('plain\ntext\n')
  })

  test('choices 数量不足时抛 INVALID_ARGUMENT', () => {
    expect(() => buildResolvedContent(TWO, ['ours'])).toThrow(GitOpError)
  })

  test('choices 数量过多时抛 INVALID_ARGUMENT', () => {
    expect(() => buildResolvedContent(ONE, ['ours', 'theirs'])).toThrow(GitOpError)
  })

  test("非 diff3 内容选 base 时抛 INVALID_ARGUMENT", () => {
    const noBase = '<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> t\n'
    expect(() => buildResolvedContent(noBase, ['base'])).toThrow(GitOpError)
  })

  test('CRLF 内容按字节保留', () => {
    const crlf = '<<<<<<< HEAD\r\nO\r\n=======\r\nT\r\n>>>>>>> t\r\n'
    expect(buildResolvedContent(crlf, ['ours'])).toBe('O\r\n')
  })

  test('文件末尾无换行时结果也无换行', () => {
    const noNl = 'a\n<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> t'
    expect(buildResolvedContent(noNl, ['ours'])).toBe('a\nO')
  })
})
