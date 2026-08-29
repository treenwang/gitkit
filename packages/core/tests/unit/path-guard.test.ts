import { describe, expect, test } from 'bun:test'
import { resolveWithin } from '../../src/domain/path-guard'
import type { GitOpError } from '../../src/types'

const WT = '/wt/task-1'
const SPARSE = [{ path: 'docs', requireChecks: true }]

function codeOf(fn: () => unknown): string {
  try { fn(); return 'NO_THROW' } catch (e) { return (e as GitOpError).code }
}

describe('resolveWithin', () => {
  test('sparse 范围内的路径通过', () => {
    expect(resolveWithin(WT, 'docs/a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('sparse 目录本身通过', () => {
    expect(resolveWithin(WT, 'docs', SPARSE)).toBe('/wt/task-1/docs')
  })

  test('规范化冗余片段', () => {
    expect(resolveWithin(WT, './docs/./a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('全量模式（sparse 为空）放行任意仓内路径', () => {
    expect(resolveWithin(WT, 'src/x.ts', [])).toBe('/wt/task-1/src/x.ts')
  })

  test('穿越到 worktree 之外 → PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '../other/a.md', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('深度穿越 → PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, 'docs/../../etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('绝对路径 → PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '/etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('仓内但不在 sparse 范围 → PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'src/index.ts', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('前缀相同但非子目录 → PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'docsite/a.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('sparse 模式下仓库根文件被拒', () => {
    expect(codeOf(() => resolveWithin(WT, 'README.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('空路径 → INVALID_ARGUMENT', () => {
    expect(codeOf(() => resolveWithin(WT, '', SPARSE))).toBe('INVALID_ARGUMENT')
  })

  test('解析为 worktree 根自身的路径被拒', () => {
    expect(codeOf(() => resolveWithin(WT, '.', []))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => resolveWithin(WT, 'docs/..', []))).toBe('INVALID_ARGUMENT')
  })

  test('.git 目录一律拒绝', () => {
    expect(codeOf(() => resolveWithin(WT, '.git/config', []))).toBe('PATH_TRAVERSAL')
  })
})
