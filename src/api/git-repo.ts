import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveWithin } from '../domain/path-guard'
import type { ExecOptions, GitExecutor } from '../exec/git-executor'
import { FsGateway } from '../exec/fs-gateway'
import { GitOpError, type SparsePath } from '../types'

export type StatusResult = {
  branch: string
  staged: string[]
  modified: string[]
  untracked: string[]
  conflicted: string[]
  merging: boolean
  clean: boolean
}

export type LogEntry = { sha: string; author: string; date: string; message: string }

export type PushBranchResult =
  | { ok: true }
  | { ok: false; reason: 'rejected' | 'auth' | 'network'; detail: string }

export type GitRepoDeps = {
  dir: string
  branch: string
  sparse: SparsePath[]
  author: { name: string; email: string }
  exec: GitExecutor
  token?: string
  fetch: () => Promise<void>
  onDispose: () => Promise<void>
}

/** 绑定到单个 worktree 的操作门面。永不加锁 —— store 级操作请走 RepoStore。 */
export class GitRepo {
  readonly #d: GitRepoDeps
  #fs: FsGateway
  #disposed = false

  constructor(deps: GitRepoDeps) {
    this.#d = deps
    this.#fs = new FsGateway(deps.dir, deps.sparse)
  }

  get dir(): string { return this.#d.dir }
  get branch(): string { return this.#d.branch }
  get sparsePaths(): readonly SparsePath[] { return this.#d.sparse }
  get disposed(): boolean { return this.#disposed }

  assertLive(): void {
    if (this.#disposed) {
      throw new GitOpError('WORKTREE_DISPOSED', `session 已释放: ${this.#d.dir}`)
    }
  }

  /** 在本 worktree 中执行 git；供包内其他模块（冲突层）复用。 */
  async git(args: string[], opts: Omit<ExecOptions, 'cwd'> = {}): Promise<string> {
    this.assertLive()
    return this.#d.exec.run(args, { ...opts, cwd: this.#d.dir, token: this.#d.token })
  }

  // ------------------------------------------------------------ 文件

  async readFile(rel: string): Promise<string> {
    this.assertLive()
    return this.#fs.readFile(rel)
  }

  async writeFile(rel: string, content: string): Promise<void> {
    this.assertLive()
    await this.#fs.writeFile(rel, content)
  }

  async listFiles(rel?: string): Promise<string[]> {
    this.assertLive()
    return this.#fs.listFiles(rel)
  }

  async exists(rel: string): Promise<boolean> {
    this.assertLive()
    return this.#fs.exists(rel)
  }

  // ------------------------------------------------------------ 状态

  async isMerging(): Promise<boolean> {
    const p = await this.git(['rev-parse', '--git-path', 'MERGE_HEAD']).catch(() => '')
    if (!p) return false
    return existsSync(isAbsolute(p) ? p : join(this.#d.dir, p))
  }

  async status(): Promise<StatusResult> {
    const out = await this.git(['status', '--porcelain=v1', '-z'])
    const staged: string[] = []
    const modified: string[] = []
    const untracked: string[] = []
    const conflicted: string[] = []

    for (const entry of out.split('\0').filter(Boolean)) {
      if (entry.length < 3) continue
      const x = entry[0]!
      const y = entry[1]!
      const path = entry.slice(3)
      if (x === '?' && y === '?') {
        untracked.push(path)
      } else if (
        x === 'U' || y === 'U' ||
        (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
      ) {
        conflicted.push(path)
      } else {
        if (x !== ' ') staged.push(path)
        if (y !== ' ') modified.push(path)
      }
    }

    const merging = await this.isMerging()
    return {
      branch: this.#d.branch,
      staged, modified, untracked, conflicted, merging,
      clean:
        staged.length === 0 && modified.length === 0 &&
        untracked.length === 0 && conflicted.length === 0,
    }
  }

  // ------------------------------------------------------------ 操作

  async commit(opts: { message: string; paths?: string[] }): Promise<{ sha: string; changed: boolean }> {
    this.assertLive()
    if (opts.paths) {
      for (const p of opts.paths) resolveWithin(this.#d.dir, p, this.#d.sparse)
      await this.git(['add', '--', ...opts.paths])
    } else {
      await this.git(['add', '-A'])
    }

    const staged = await this.git(['diff', '--cached', '--name-only'])
    const merging = await this.isMerging()
    if (!staged && !merging) {
      return { sha: await this.git(['rev-parse', 'HEAD']), changed: false }
    }

    await this.git([
      '-c', `user.name=${this.#d.author.name}`,
      '-c', `user.email=${this.#d.author.email}`,
      'commit', '--no-verify', '-m', opts.message,
    ])
    return { sha: await this.git(['rev-parse', 'HEAD']), changed: true }
  }

  /**
   * pull = store 级 fetch（由 RepoStore 持锁）+ worktree 级 merge（无锁）。
   * 冲突不抛错，返回 conflicted: true。
   */
  async pull(
    opts: { strategy?: 'merge' | 'rebase'; ref?: string } = {},
  ): Promise<{ conflicted: boolean }> {
    this.assertLive()
    await this.#d.fetch()
    const ref = opts.ref ?? `origin/${this.#d.branch}`
    const args = opts.strategy === 'rebase'
      ? ['rebase', ref]
      : ['merge', '--no-edit', ref]
    try {
      await this.git(args, { phase: 'pull' })
      return { conflicted: false }
    } catch (e) {
      const unmerged = await this.git(['ls-files', '-u']).catch(() => '')
      if (unmerged) return { conflicted: true }
      throw e
    }
  }

  async pushBranch(opts: { force?: boolean } = {}): Promise<PushBranchResult> {
    this.assertLive()
    const args = ['push', '--set-upstream']
    if (opts.force) args.push('--force-with-lease')
    args.push('origin', `${this.#d.branch}:${this.#d.branch}`)
    try {
      await this.git(args, { phase: 'push' })
      return { ok: true }
    } catch (e) {
      const err = e as GitOpError
      if (err.code === 'AUTH_FAILED') return { ok: false, reason: 'auth', detail: err.detail }
      if (err.code === 'NETWORK') return { ok: false, reason: 'network', detail: err.detail }
      if (/non-fast-forward|fetch first|\[rejected\]|failed to push/i.test(err.detail)) {
        return { ok: false, reason: 'rejected', detail: err.detail }
      }
      throw e
    }
  }

  async log(opts: { limit?: number } = {}): Promise<LogEntry[]> {
    const out = await this.git([
      'log', `-${opts.limit ?? 20}`, '--format=%H%x1f%an%x1f%aI%x1f%s',
    ])
    if (!out) return []
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, author, date, message] = line.split('\x1f')
      return { sha: sha!, author: author!, date: date!, message: message ?? '' }
    })
  }

  /** 只用 --name-only：partial clone 下需要内容的 diff 会触发惰性拉取 blob。 */
  async diffSummary(opts: { against?: string } = {}): Promise<string[]> {
    const target = opts.against ?? 'HEAD~1'
    const out = await this.git(['diff', '--name-only', `${target}...HEAD`])
    return out ? out.split('\n').filter(Boolean) : []
  }

  async setSparsePaths(paths: SparsePath[]): Promise<void> {
    this.assertLive()
    if (paths.length === 0) {
      await this.git(['sparse-checkout', 'disable'])
    } else {
      await this.git(['sparse-checkout', 'init', '--cone'])
      await this.git(['sparse-checkout', 'set', ...paths.map((p) => p.path)])
    }
    this.#d.sparse.length = 0
    this.#d.sparse.push(...paths)
    this.#fs = new FsGateway(this.#d.dir, this.#d.sparse)
  }

  async abortMerge(): Promise<void> {
    this.assertLive()
    await this.git(['merge', '--abort'])
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#d.onDispose()
  }
}
