/**
 * The protocol contract - the single definition shared by client and server.
 *
 * It lives in the client package on purpose: it has to be **types only, with
 * zero runtime dependencies**, so a browser can import it safely. The server
 * package reuses it through `import type`, which means any disagreement about
 * an op name, its parameters or its result fails `npm run typecheck` - the
 * contract test is the typecheck.
 */
import type {
  Conflict,
  ConflictHunk,
  ConflictSide,
  HunkChoice,
  MergeMethod,
  MergeMode,
  PullRequest,
  Resolution,
} from '@treenwang/gitkit'

/**
 * Re-export the core types that appear in the protocol, so the browser side
 * gets the full type surface from the client package alone. These are types
 * only and add no runtime dependency.
 */
export type {
  Conflict, ConflictHunk, ConflictSide, HunkChoice,
  MergeMethod, MergeMode, PullRequest, Resolution,
}

// ---------------------------------------------------------------- own types

export type FileStatus = 'clean' | 'modified' | 'added' | 'deleted' | 'conflicted'

export type FileEntry = {
  path: string
  type: 'file' | 'dir'
  status: FileStatus
}

export type ChangeEntry = {
  path: string
  status: Exclude<FileStatus, 'clean'>
  staged: boolean
}

export type SessionStatus = {
  branch: string
  operation: 'merge' | 'rebase' | 'cherry-pick' | null
  clean: boolean
  staged: string[]
  modified: string[]
  untracked: string[]
  conflicted: string[]
}

export type ReadResult =
  | { binary: false; content: string; etag: string; size: number; truncated: boolean }
  | { binary: true; size: number }

/**
 * PushResult with worktreeDir removed.
 * worktreeDir is an absolute server path and must never reach the browser,
 * which holds nothing but a sessionId.
 */
export type ClientPushResult =
  | { ok: true; pushed: true; pr?: PullRequest; autoMerge?: AutoMergeOutcomeWire }
  | { ok: false; pushed: false; reason: 'conflict'; conflicts: Conflict[] }
  | { ok: false; pushed: false; reason: 'rejected' | 'auth' | 'network'; detail: string }

export type AutoMergeOutcomeWire =
  | { ok: true; merged: boolean; scheduled: boolean }
  | {
      ok: false
      reason: 'blocked_by_checks' | 'not_allowed' | 'conflict' | 'api_error'
      detail: string
    }

// ---------------------------------------------------------------- op table

export type Ops = {
  'status': { params: Record<string, never>; result: SessionStatus }
  'files.list': { params: { dir?: string }; result: { entries: FileEntry[] } }
  'files.read': { params: { path: string }; result: ReadResult }
  'files.write': {
    params: { path: string; content: string; baseEtag?: string; ifNotExists?: boolean }
    result: { etag: string }
  }
  'files.delete': { params: { path: string }; result: { deleted: true } }
  'changes.list': { params: Record<string, never>; result: { files: ChangeEntry[] } }
  'changes.diff': {
    params: { path?: string; against?: string; context?: number }
    result: { patch: string; truncated: boolean }
  }
  'commit': {
    params: { message: string; paths?: string[] }
    result: { sha: string; changed: boolean }
  }
  'push': {
    params: {
      createPR?: { title: string; body?: string; base: string; draft?: boolean } | false
      merge?: MergeMode
      method?: MergeMethod
      retryOnReject?: boolean
    }
    result: ClientPushResult
  }
  'sync.pull': {
    /**
     * Omitted, ref is `origin/<current branch>`. It enters the git command as a
     * positional argument, so the server validates it with assertValidRevision -
     * a leading `-` in particular.
     */
    params: { strategy?: 'merge' | 'rebase'; ref?: string }
    result: { conflicted: boolean }
  }
  'conflicts.list': { params: Record<string, never>; result: { conflicts: Conflict[] } }
  'conflicts.resolve': {
    params: { resolutions: Resolution[] }
    result: { remaining: string[] }
  }
  'conflicts.resolveByHunks': {
    params: { path: string; choices: HunkChoice[] }
    result: { remaining: string[] }
  }
  'conflicts.continue': { params: Record<string, never>; result: { done: boolean; conflicted: boolean } }
  'conflicts.abort': { params: Record<string, never>; result: { ok: true } }
}

export type OpName = keyof Ops
export type OpParams<K extends OpName> = Ops[K]['params']
export type OpResult<K extends OpName> = Ops[K]['result']

/** The op list, enumerable at runtime, for server validation and client tests. */
export const OP_NAMES = [
  'status',
  'files.list', 'files.read', 'files.write', 'files.delete',
  'changes.list', 'changes.diff',
  'commit', 'push', 'sync.pull',
  'conflicts.list', 'conflicts.resolve', 'conflicts.resolveByHunks',
  'conflicts.continue', 'conflicts.abort',
] as const satisfies readonly OpName[]

// ---------------------------------------------------------------- errors

/** Every GitErrorCode, plus the few the transport owns. */
export type WireErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'OP_NOT_ALLOWED'
  | 'STALE_ETAG'
  | 'ALREADY_EXISTS'
  | 'GIT_NOT_FOUND' | 'GIT_VERSION_TOO_OLD'
  | 'AUTH_FAILED' | 'NETWORK' | 'TIMEOUT'
  | 'NOT_A_REPO' | 'DIRTY_WORKTREE' | 'MERGE_IN_PROGRESS'
  | 'BRANCH_IN_USE' | 'BRANCH_EXISTS' | 'BRANCH_NOT_FOUND'
  | 'WORKTREE_DISPOSED'
  | 'PATH_OUTSIDE_SPARSE' | 'PATH_TRAVERSAL'
  | 'INVALID_ARGUMENT'
  | 'FORGE_NOT_INSTALLED' | 'FORGE_API_ERROR'
  | 'UNKNOWN'

export type WireError = {
  code: WireErrorCode
  message: string
  /** Present only when the server explicitly enables exposeDetail. */
  detail?: string
  /** On STALE_ETAG, carries the server's current content so the UI can offer overwrite, view the difference, or discard. */
  current?: { content: string; etag: string }
}
