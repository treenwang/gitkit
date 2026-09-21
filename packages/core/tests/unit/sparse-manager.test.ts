import { describe, expect, test } from 'vitest'
import { isFullCheckout, normalizeSparsePaths } from '../../src/domain/sparse-manager'
import { GitOpError } from '../../src/types'

describe('normalizeSparsePaths', () => {
  test('undefined and an empty array both mean a full checkout', () => {
    expect(normalizeSparsePaths(undefined)).toEqual([])
    expect(normalizeSparsePaths([])).toEqual([])
    expect(isFullCheckout([])).toBe(true)
  })

  test('the string shorthand defaults to requireChecks: true, the conservative choice', () => {
    expect(normalizeSparsePaths(['docs'])).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('the object form keeps requireChecks', () => {
    expect(normalizeSparsePaths([{ path: 'docs', requireChecks: false }]))
      .toEqual([{ path: 'docs', requireChecks: false }])
  })

  test('the object form defaults requireChecks to true when it is omitted', () => {
    expect(normalizeSparsePaths([{ path: 'src' }])).toEqual([{ path: 'src', requireChecks: true }])
  })

  test('backslashes become forward slashes and leading and trailing slashes are stripped', () => {
    expect(normalizeSparsePaths(['\\docs\\api\\'])[0]!.path).toBe('docs/api')
  })

  test('duplicate paths are deduplicated', () => {
    expect(normalizeSparsePaths(['docs', 'docs/'])).toHaveLength(1)
  })

  test('a subpath already covered by a parent directory is dropped', () => {
    expect(normalizeSparsePaths(['docs', 'docs/api']))
      .toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('a parent directory takes the most conservative requireChecks', () => {
    expect(normalizeSparsePaths([
      { path: 'docs', requireChecks: false },
      { path: 'docs/api', requireChecks: true },
    ])).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('paths with a similar prefix but no parent relationship are all kept', () => {
    expect(normalizeSparsePaths(['docs', 'docsite']).map((p) => p.path).sort())
      .toEqual(['docs', 'docsite'])
  })

  test('output is sorted by path, so results are stable', () => {
    expect(normalizeSparsePaths(['b', 'a']).map((p) => p.path)).toEqual(['a', 'b'])
  })

  const bad: Array<[string, string]> = [
    ['glob star', 'docs/*'],
    ['glob question mark', 'docs/?.md'],
    ['glob brackets', 'docs/[ab]'],
    ['negation prefix', '!docs'],
    ['parent traversal', '../etc'],
    ['embedded traversal', 'docs/../../etc'],
    ['absolute path', '/etc'],
    ['empty string', ''],
    ['whitespace only', '   '],
  ]
  for (const [name, p] of bad) {
    test(`refuses: ${name}`, () => {
      expect(() => normalizeSparsePaths([p])).toThrow(GitOpError)
    })
  }
})
