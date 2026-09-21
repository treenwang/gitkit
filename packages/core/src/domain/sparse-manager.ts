import { GitOpError, type SparsePath, type SparsePathInput } from '../types'

function validate(raw: string): string {
  const trimmed = raw.trim()
  const p = trimmed.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!p) throw new GitOpError('INVALID_ARGUMENT', 'a sparse path cannot be empty')
  if (trimmed.startsWith('/')) {
    throw new GitOpError('INVALID_ARGUMENT', `a sparse path must be relative: ${raw}`)
  }
  if (/[*?[\]!]/.test(p)) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `sparse paths do not support wildcards; only cone-mode directory prefixes: ${raw}`,
    )
  }
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new GitOpError('INVALID_ARGUMENT', `a sparse path must not contain . or ..: ${raw}`)
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
