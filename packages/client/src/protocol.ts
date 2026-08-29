/**
 * 协议契约 —— client 与 server 共享的唯一定义。
 *
 * 放在 client 包里是有意为之：这里必须是**纯类型、零运行时依赖**，浏览器可安全引入；
 * server 包以 `import type` 复用它，因此 op 名称、参数或返回类型任何一处不一致，
 * 都会在 `bun run typecheck` 时失败 —— 契约测试即类型检查。
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
} from '@aaxis/gitkit'

/**
 * 从核心包再导出协议里出现的类型，使浏览器侧只依赖 client 一个包
 * 即可拿到完整类型（这些是纯类型，不产生运行时依赖）。
 */
export type {
  Conflict, ConflictHunk, ConflictSide, HunkChoice,
  MergeMethod, MergeMode, PullRequest, Resolution,
}

// ---------------------------------------------------------------- 自有类型

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
 * PushResult 去掉 worktreeDir 后的形态。
 * worktreeDir 是服务端绝对路径，绝不能发给浏览器 —— 浏览器只持有 sessionId。
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

// ---------------------------------------------------------------- op 表

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
     * ref 省略时为 `origin/<当前分支>`。它会作为位置参数进入 git 命令，
     * 因此服务端用 assertValidRevision 校验（尤其是前导 `-`）。
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

/** 运行时可枚举的 op 列表，供 server 校验与 client 测试使用。 */
export const OP_NAMES = [
  'status',
  'files.list', 'files.read', 'files.write', 'files.delete',
  'changes.list', 'changes.diff',
  'commit', 'push', 'sync.pull',
  'conflicts.list', 'conflicts.resolve', 'conflicts.resolveByHunks',
  'conflicts.continue', 'conflicts.abort',
] as const satisfies readonly OpName[]

// ---------------------------------------------------------------- 错误

/** GitErrorCode 的全集，再并上传输层自有的几个。 */
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
  /** 仅当服务端显式开启 exposeDetail 时存在。 */
  detail?: string
  /** STALE_ETAG 时携带服务端当前内容，供 UI 呈现「覆盖 / 查看差异 / 放弃」。 */
  current?: { content: string; etag: string }
}
