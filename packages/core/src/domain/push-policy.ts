import type { MergeMode, SparsePath } from '../types'

export type DerivedMergeMode = 'now' | 'checksPass'

/**
 * 由本次改动涉及的文件推导 merge 模式。取最保守值：
 * 只要有任何一个被碰到的 sparse 路径 requireChecks: true，就必须等 CI。
 *
 * 纯函数，不碰 IO —— 改动文件列表由调用方用 `git diff --name-only` 取得。
 */
export function deriveMergeMode(
  changedFiles: readonly string[],
  sparse: readonly SparsePath[],
): DerivedMergeMode {
  // 全量模式（未声明 sparsePaths）无从判断影响面，保守要求跑 CI
  if (sparse.length === 0) return 'checksPass'

  let matchedAny = false
  for (const file of changedFiles) {
    const hit = sparse.find((s) => file === s.path || file.startsWith(`${s.path}/`))
    if (!hit) {
      // 改动落在声明范围之外，无法判断，保守处理
      return 'checksPass'
    }
    matchedAny = true
    if (hit.requireChecks) return 'checksPass'
  }

  // 没有任何改动时同样保守
  return matchedAny ? 'now' : 'checksPass'
}

export type RetryDecision = 'retry' | 'give_up'

/** push 被拒后是否重试。只重试一次，避免远端被持续 push 时无限循环。 */
export function decideRetry(opts: {
  retryOnReject: boolean
  attempt: number
}): RetryDecision {
  return opts.retryOnReject && opts.attempt === 0 ? 'retry' : 'give_up'
}

/** 是否需要先算出改动文件列表来推导模式。 */
export function needsDerivation(requested: MergeMode | undefined): boolean {
  return requested === undefined || requested === 'auto'
}

export function resolveMergeMode(
  requested: MergeMode | undefined,
  derived: DerivedMergeMode,
): 'now' | 'checksPass' | false {
  return needsDerivation(requested) ? derived : (requested as 'now' | 'checksPass' | false)
}
