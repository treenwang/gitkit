export type GitErrorCode =
  | 'GIT_NOT_FOUND'
  | 'GIT_VERSION_TOO_OLD'
  | 'AUTH_FAILED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'NOT_A_REPO'
  | 'DIRTY_WORKTREE'
  | 'MERGE_IN_PROGRESS'
  | 'BRANCH_IN_USE'
  | 'BRANCH_EXISTS'
  | 'BRANCH_NOT_FOUND'
  | 'WORKTREE_DISPOSED'
  | 'PATH_OUTSIDE_SPARSE'
  | 'PATH_TRAVERSAL'
  | 'INVALID_ARGUMENT'
  | 'FORGE_NOT_INSTALLED'
  | 'FORGE_API_ERROR'
  | 'UNKNOWN'

export class GitOpError extends Error {
  readonly code: GitErrorCode
  readonly detail: string
  readonly command?: string

  constructor(
    code: GitErrorCode,
    message: string,
    opts: { detail?: string; command?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'GitOpError'
    this.code = code
    this.detail = opts.detail ?? ''
    this.command = opts.command
  }
}

export type SparsePath = { path: string; requireChecks: boolean }
export type SparsePathInput = string | { path: string; requireChecks?: boolean }

export type ProgressEvent = {
  phase: 'clone' | 'fetch' | 'pull' | 'push' | 'checkout' | 'worktree'
  message: string
  percent?: number
}

// ---------------------------------------------------------------- 冲突模型

export type ConflictType =
  | 'both_modified'
  | 'both_added'
  | 'deleted_by_them'
  | 'deleted_by_us'
  | 'rename'

export type ConflictSide = { oid: string; mode: string; content?: string }

export type ConflictHunk = {
  index: number
  ourLines: string[]
  theirLines: string[]
  baseLines?: string[]
  startLine: number
  endLine: number
}

export type Conflict = {
  path: string
  type: ConflictType
  binary: boolean
  base?: ConflictSide
  ours?: ConflictSide
  theirs?: ConflictSide
  ourPath?: string
  theirPath?: string
  hunks?: ConflictHunk[]
}

export type Resolution =
  | { path: string; take: 'ours' | 'theirs' | 'base' }
  | { path: string; take: 'delete' }
  | { path: string; content: string }

export type HunkChoice = 'ours' | 'theirs' | 'base' | 'both' | { content: string }

// ---------------------------------------------------------------- push

export type MergeMethod = 'squash' | 'merge' | 'rebase'
export type MergeMode = 'auto' | 'now' | 'checksPass' | false

export type PullRequest = {
  number: number
  url: string
  head: string
  base: string
  title: string
  draft: boolean
  state: string
}

export type AutoMergeOutcome =
  | { ok: true; merged: boolean; scheduled: boolean }
  | {
      ok: false
      reason: 'blocked_by_checks' | 'not_allowed' | 'conflict' | 'api_error'
      detail: string
    }

export type PushResult =
  | { ok: true; pushed: true; pr?: PullRequest; autoMerge?: AutoMergeOutcome }
  | { ok: false; pushed: false; reason: 'conflict'; conflicts: Conflict[] }
  | {
      ok: false
      pushed: false
      reason: 'rejected' | 'auth' | 'network'
      detail: string
    }
