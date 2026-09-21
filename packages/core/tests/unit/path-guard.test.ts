import { describe, expect, test } from 'vitest'
import { resolveWithin } from '../../src/domain/path-guard'
import type { GitOpError } from '../../src/types'

const WT = '/wt/task-1'
const SPARSE = [{ path: 'docs', requireChecks: true }]

function codeOf(fn: () => unknown): string {
  try { fn(); return 'NO_THROW' } catch (e) { return (e as GitOpError).code }
}

describe('resolveWithin', () => {
  test('a path inside the sparse range passes', () => {
    expect(resolveWithin(WT, 'docs/a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('the sparse directory itself passes', () => {
    expect(resolveWithin(WT, 'docs', SPARSE)).toBe('/wt/task-1/docs')
  })

  test('normalizes redundant segments', () => {
    expect(resolveWithin(WT, './docs/./a.md', SPARSE)).toBe('/wt/task-1/docs/a.md')
  })

  test('full-checkout mode, with sparse empty, allows any path inside the repository', () => {
    expect(resolveWithin(WT, 'src/x.ts', [])).toBe('/wt/task-1/src/x.ts')
  })

  test('escaping the worktree gives PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '../other/a.md', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('a deep traversal gives PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, 'docs/../../etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('an absolute path gives PATH_TRAVERSAL', () => {
    expect(codeOf(() => resolveWithin(WT, '/etc/passwd', SPARSE))).toBe('PATH_TRAVERSAL')
  })

  test('inside the repository but outside the sparse range gives PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'src/index.ts', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('a shared prefix that is not a subdirectory gives PATH_OUTSIDE_SPARSE', () => {
    expect(codeOf(() => resolveWithin(WT, 'docsite/a.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('a file at the repository root is refused in sparse mode', () => {
    expect(codeOf(() => resolveWithin(WT, 'README.md', SPARSE))).toBe('PATH_OUTSIDE_SPARSE')
  })

  test('an empty path gives INVALID_ARGUMENT', () => {
    expect(codeOf(() => resolveWithin(WT, '', SPARSE))).toBe('INVALID_ARGUMENT')
  })

  test('a path resolving to the worktree root itself is refused', () => {
    expect(codeOf(() => resolveWithin(WT, '.', []))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => resolveWithin(WT, 'docs/..', []))).toBe('INVALID_ARGUMENT')
  })

  test('the .git directory is always refused', () => {
    expect(codeOf(() => resolveWithin(WT, '.git/config', []))).toBe('PATH_TRAVERSAL')
  })
})
