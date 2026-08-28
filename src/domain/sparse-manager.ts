import { GitOpError, type SparsePath, type SparsePathInput } from '../types'

function validate(raw: string): string {
  const trimmed = raw.trim()
  const p = trimmed.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!p) throw new GitOpError('INVALID_ARGUMENT', 'sparse path 不能为空')
  if (trimmed.startsWith('/')) {
    throw new GitOpError('INVALID_ARGUMENT', `sparse path 必须是相对路径: ${raw}`)
  }
  if (/[*?[\]!]/.test(p)) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `sparse path 不支持通配符（只支持 cone 模式的目录前缀）: ${raw}`,
    )
  }
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new GitOpError('INVALID_ARGUMENT', `sparse path 不得包含 . 或 ..: ${raw}`)
  }
  return p
}

function isAncestor(parent: string, child: string): boolean {
  return child.startsWith(`${parent}/`)
}

export function normalizeSparsePaths(
  input?: readonly SparsePathInput[],
): SparsePath[] {
  if (!input || input.length === 0) return []

  const merged = new Map<string, boolean>()
  for (const item of input) {
    const raw = typeof item === 'string' ? item : item.path
    const requireChecks = typeof item === 'string' ? true : item.requireChecks ?? true
    const path = validate(raw)
    merged.set(path, (merged.get(path) ?? false) || requireChecks)
  }

  const sorted = [...merged.keys()].sort()
  const kept: SparsePath[] = []
  for (const path of sorted) {
    const ancestor = kept.find((k) => isAncestor(k.path, path))
    if (ancestor) {
      ancestor.requireChecks = ancestor.requireChecks || merged.get(path)!
      continue
    }
    kept.push({ path, requireChecks: merged.get(path)! })
  }
  return kept
}

export function isFullCheckout(paths: readonly SparsePath[]): boolean {
  return paths.length === 0
}
