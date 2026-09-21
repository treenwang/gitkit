import type { MergeMode, SparsePath } from '../types'

export type DerivedMergeMode = 'now' | 'checksPass'

/**
 * Derive the merge mode from the files this change touches, taking the most
 * conservative answer: if any touched sparse path has requireChecks: true, CI
 * must pass first.
 *
 * Pure function, no IO - the caller obtains the changed-file list with
 * `git diff --name-only`.
 */
export function deriveMergeMode(
  changedFiles: readonly string[],
  sparse: readonly SparsePath[],
): DerivedMergeMode {
  // In full-checkout mode (no sparsePaths declared) the blast radius is unknowable, so require CI
  if (sparse.length === 0) return 'checksPass'

  let matchedAny = false
  for (const file of changedFiles) {
    const hit = sparse.find((s) => file === s.path || file.startsWith(`${s.path}/`))
    if (!hit) {
      // The change falls outside the declared range; unknowable, so stay conservative
      return 'checksPass'
    }
    matchedAny = true
    if (hit.requireChecks) return 'checksPass'
  }

  // With no changes at all, stay conservative too
  return matchedAny ? 'now' : 'checksPass'
}

export type RetryDecision = 'retry' | 'give_up'

/** Whether to retry after a rejected push. Only once, so a remote being pushed to continuously cannot loop forever. */
export function decideRetry(opts: {
  retryOnReject: boolean
  attempt: number
}): RetryDecision {
  return opts.retryOnReject && opts.attempt === 0 ? 'retry' : 'give_up'
}

/** Whether the changed-file list has to be computed before the mode can be derived. */
export function needsDerivation(requested: MergeMode | undefined): boolean {
  return requested === undefined || requested === 'auto'
}

export function resolveMergeMode(
  requested: MergeMode | undefined,
  derived: DerivedMergeMode,
): 'now' | 'checksPass' | false {
  return needsDerivation(requested) ? derived : (requested as 'now' | 'checksPass' | false)
}
