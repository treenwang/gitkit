import { describe, expect, test } from 'vitest'
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

  test("take both means ours followed by theirs", () => {
    expect(buildResolvedContent(ONE, ['both'])).toBe('head\nOUR\nTHEIR\ntail\n')
  })

  test('hand-written content replaces the whole hunk', () => {
    expect(buildResolvedContent(ONE, [{ content: 'MERGED' }])).toBe('head\nMERGED\ntail\n')
  })

  test('hand-written content spanning several lines', () => {
    expect(buildResolvedContent(ONE, [{ content: 'A\nB' }])).toBe('head\nA\nB\ntail\n')
  })

  test('hand-written empty content deletes the whole hunk', () => {
    expect(buildResolvedContent(ONE, [{ content: '' }])).toBe('head\ntail\n')
  })

  test('mixed choices across several hunks', () => {
    expect(buildResolvedContent(TWO, ['ours', 'theirs']))
      .toBe('l1\nOUR2\nl3\nTHEIR5\n')
    expect(buildResolvedContent(TWO, ['theirs', { content: 'X' }]))
      .toBe('l1\nTHEIR2\nl3\nX\n')
    expect(buildResolvedContent(TWO, ['both', 'base']))
      .toBe('l1\nOUR2\nTHEIR2\nl3\nl5\n')
  })

  test('text without conflicts comes back unchanged', () => {
    expect(buildResolvedContent('plain\ntext\n', [])).toBe('plain\ntext\n')
  })

  test('too few choices throws INVALID_ARGUMENT', () => {
    expect(() => buildResolvedContent(TWO, ['ours'])).toThrow(GitOpError)
  })

  test('too many choices throws INVALID_ARGUMENT', () => {
    expect(() => buildResolvedContent(ONE, ['ours', 'theirs'])).toThrow(GitOpError)
  })

  test("choosing base on non-diff3 content throws INVALID_ARGUMENT", () => {
    const noBase = '<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> t\n'
    expect(() => buildResolvedContent(noBase, ['base'])).toThrow(GitOpError)
  })

  test('CRLF content is preserved byte for byte', () => {
    const crlf = '<<<<<<< HEAD\r\nO\r\n=======\r\nT\r\n>>>>>>> t\r\n'
    expect(buildResolvedContent(crlf, ['ours'])).toBe('O\r\n')
  })

  test('a file with no trailing newline produces none either', () => {
    const noNl = 'a\n<<<<<<< HEAD\nO\n=======\nT\n>>>>>>> t'
    expect(buildResolvedContent(noNl, ['ours'])).toBe('a\nO')
  })
})
