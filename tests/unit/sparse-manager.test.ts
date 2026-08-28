import { describe, expect, test } from 'bun:test'
import { isFullCheckout, normalizeSparsePaths } from '../../src/domain/sparse-manager'
import { GitOpError } from '../../src/types'

describe('normalizeSparsePaths', () => {
  test('undefined 与空数组都表示全量 checkout', () => {
    expect(normalizeSparsePaths(undefined)).toEqual([])
    expect(normalizeSparsePaths([])).toEqual([])
    expect(isFullCheckout([])).toBe(true)
  })

  test('字符串简写默认 requireChecks: true（保守）', () => {
    expect(normalizeSparsePaths(['docs'])).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('对象形式保留 requireChecks', () => {
    expect(normalizeSparsePaths([{ path: 'docs', requireChecks: false }]))
      .toEqual([{ path: 'docs', requireChecks: false }])
  })

  test('对象形式省略 requireChecks 时默认 true', () => {
    expect(normalizeSparsePaths([{ path: 'src' }])).toEqual([{ path: 'src', requireChecks: true }])
  })

  test('反斜杠转为正斜杠，首尾斜杠被去掉', () => {
    expect(normalizeSparsePaths(['\\docs\\api\\'])[0]!.path).toBe('docs/api')
  })

  test('重复路径去重', () => {
    expect(normalizeSparsePaths(['docs', 'docs/'])).toHaveLength(1)
  })

  test('被父目录覆盖的子路径被丢弃', () => {
    expect(normalizeSparsePaths(['docs', 'docs/api']))
      .toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('父目录的 requireChecks 取最保守值', () => {
    expect(normalizeSparsePaths([
      { path: 'docs', requireChecks: false },
      { path: 'docs/api', requireChecks: true },
    ])).toEqual([{ path: 'docs', requireChecks: true }])
  })

  test('前缀相似但非父子关系的路径都保留', () => {
    expect(normalizeSparsePaths(['docs', 'docsite']).map((p) => p.path).sort())
      .toEqual(['docs', 'docsite'])
  })

  test('输出按 path 排序，结果稳定', () => {
    expect(normalizeSparsePaths(['b', 'a']).map((p) => p.path)).toEqual(['a', 'b'])
  })

  const bad: Array<[string, string]> = [
    ['glob 星号', 'docs/*'],
    ['glob 问号', 'docs/?.md'],
    ['glob 方括号', 'docs/[ab]'],
    ['否定前缀', '!docs'],
    ['父目录穿越', '../etc'],
    ['内嵌穿越', 'docs/../../etc'],
    ['绝对路径', '/etc'],
    ['空串', ''],
    ['纯空白', '   '],
  ]
  for (const [name, p] of bad) {
    test(`拒绝：${name}`, () => {
      expect(() => normalizeSparsePaths([p])).toThrow(GitOpError)
    })
  }
})
