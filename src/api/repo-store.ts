import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { Layout } from '../domain/layout-planner'
import { worktreeDirFor } from '../domain/layout-planner'
import { normalizeSparsePaths } from '../domain/sparse-manager'
import type { GitExecutor } from '../exec/git-executor'
import type { StoreMutex } from '../exec/store-mutex'
import { GitOpError, type SparsePath, type SparsePathInput } from '../types'
import { GitRepo } from './git-repo'

export type SessionConfig = {
  branch: string
  branchMode?: 'create' | 'reuse' | 'createOrReuse'
  base?: string
  sparsePaths?: SparsePathInput[]
  author: { name: string; email: string }
  retryOnReject?: boolean
}

export type SessionInfo = {
  dir: string
  branch: string
  state: 'clean' | 'conflicted' | 'merging'
}

export type RepoStoreDeps = {
  layout: Layout
  exec: GitExecutor
  mutex: StoreMutex
  token?: string
  url: string
}

/** 一个 URL 对应的共享对象库。负责 store 级状态（refs、worktree 注册表）。 */
export class RepoStore {
  readonly #d: RepoStoreDeps
  #active = 0
  #lastUsed = Date.now()

  constructor(deps: RepoStoreDeps) {
    this.#d = deps
  }

  get repoDir(): string { return this.#d.layout.repoDir }
  get storeDir(): string { return this.#d.layout.storeDir }
  get worktreeRoot(): string { return this.#d.layout.worktreeRoot }
  get key(): string { return this.#d.layout.key }
  get url(): string { return this.#d.url }
  get activeSessions(): number { return this.#active }
  get idleMs(): number { return Date.now() - this.#lastUsed }

  #touch(): void { this.#lastUsed = Date.now() }
  #retain(): void { this.#active += 1; this.#touch() }
  #release(): void { this.#active = Math.max(0, this.#active - 1); this.#touch() }

  async configGet(name: string): Promise<string> {
    return this.#d.exec.run(['config', '--get', name], { cwd: this.storeDir })
  }

  // ------------------------------------------------------- store 级操作（加锁）

  /** 写 refs 与对象，必须串行。 */
  async fetch(refspec?: string): Promise<void> {
    this.#touch()
    await this.#d.mutex.run(this.key, () =>
      this.#d.exec.run(
        refspec ? ['fetch', 'origin', refspec] : ['fetch', '--prune', 'origin'],
        { cwd: this.storeDir, token: this.#d.token, phase: 'fetch' },
      ),
    )
  }

  async listBranches(): Promise<string[]> {
    const out = await this.#d.exec.run(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'],
      { cwd: this.storeDir },
    )
    const names = out.split('\n').filter(Boolean).map((r) => r.replace(/^origin\//, ''))
    return [...new Set(names)].filter((b) => b !== 'HEAD').sort()
  }

  async deleteBranch(name: string): Promise<void> {
    await this.#d.mutex.run(this.key, () =>
      this.#d.exec.run(['branch', '-D', name], { cwd: this.storeDir }),
    )
  }

  /** 启动清理：回收进程被 kill 后残留的孤儿 worktree。 */
  async pruneOrphans(): Promise<string[]> {
    return this.#d.mutex.run(this.key, async () => {
      await this.#d.exec.run(['worktree', 'prune'], { cwd: this.storeDir })
      if (!existsSync(this.worktreeRoot)) return []
      const registered = new Set(await this.#listRegisteredWorktrees())
      const removed: string[] = []
      for (const entry of await readdir(this.worktreeRoot)) {
        const dir = join(this.worktreeRoot, entry)
        if (registered.has(dir)) continue
        await rm(dir, { recursive: true, force: true })
        removed.push(dir)
      }
      return removed
    })
  }

  // ------------------------------------------------------- session 生命周期

  async createSession(cfg: SessionConfig): Promise<GitRepo> {
    const sparse = normalizeSparsePaths(cfg.sparsePaths)
    const mode = cfg.branchMode ?? 'createOrReuse'
    const dir = worktreeDirFor(this.worktreeRoot, `s-${randomBytes(6).toString('hex')}`)

    await this.fetch()

    const created = await this.#d.mutex.run(this.key, async () => {
      if ((await this.#checkedOutBranches()).has(cfg.branch)) {
        throw new GitOpError(
          'BRANCH_IN_USE',
          `分支 ${cfg.branch} 已在另一个 worktree 中 checkout`,
        )
      }
      const existing = await this.#branchExists(cfg.branch)
      if (mode === 'create' && existing !== 'none') {
        throw new GitOpError('BRANCH_EXISTS', `分支已存在: ${cfg.branch}`)
      }
      if (mode === 'reuse' && existing === 'none') {
        throw new GitOpError('BRANCH_NOT_FOUND', `分支不存在: ${cfg.branch}`)
      }

      // 关键顺序：先建空 worktree，再配 sparse，最后才 checkout。
      // 若先 checkout，partial clone 会向 promisor remote 批量拉取全部 blob。
      const addArgs = ['worktree', 'add', '--no-checkout']
      if (existing === 'local') {
        addArgs.push(dir, cfg.branch)
      } else if (existing === 'remote') {
        addArgs.push('-b', cfg.branch, dir, `origin/${cfg.branch}`)
      } else {
        addArgs.push('-b', cfg.branch, dir, cfg.base ?? (await this.#defaultBase()))
      }
      await this.#d.exec.run(addArgs, {
        cwd: this.storeDir, token: this.#d.token, phase: 'worktree',
      })
      return dir
    })

    try {
      if (sparse.length > 0) {
        await this.#d.exec.run(['sparse-checkout', 'init', '--cone'], { cwd: created })
        await this.#d.exec.run(
          ['sparse-checkout', 'set', ...sparse.map((s) => s.path)],
          { cwd: created },
        )
      }
      await this.#d.exec.run(['checkout'], {
        cwd: created, token: this.#d.token, phase: 'checkout',
      })
      await this.#d.exec.run(['config', 'user.name', cfg.author.name], { cwd: created })
      await this.#d.exec.run(['config', 'user.email', cfg.author.email], { cwd: created })
    } catch (e) {
      await this.#removeWorktree(created).catch(() => undefined)
      throw e
    }

    return this.#wrap(created, cfg.branch, sparse, cfg.author)
  }

  /** 重新接管一个已存在的 worktree（例如进程重启后恢复冲突现场）。 */
  async attachSession(worktreeDir: string): Promise<GitRepo> {
    if (!existsSync(worktreeDir)) {
      throw new GitOpError('INVALID_ARGUMENT', `worktree 不存在: ${worktreeDir}`)
    }
    const branch = await this.#d.exec.run(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreeDir,
    })
    const raw = await this.#d.exec
      .run(['sparse-checkout', 'list'], { cwd: worktreeDir })
      .catch(() => '')
    const sparse = normalizeSparsePaths(
      raw.split('\n').map((s) => s.trim()).filter(Boolean),
    )
    const name = await this.#d.exec
      .run(['config', '--get', 'user.name'], { cwd: worktreeDir })
      .catch(() => 'unknown')
    const email = await this.#d.exec
      .run(['config', '--get', 'user.email'], { cwd: worktreeDir })
      .catch(() => 'unknown@example.com')

    return this.#wrap(worktreeDir, branch, sparse, { name, email })
  }

  async listSessions(): Promise<SessionInfo[]> {
    const dirs = await this.#listRegisteredWorktrees()
    const infos: SessionInfo[] = []
    for (const dir of dirs) {
      const branch = await this.#d.exec
        .run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
        .catch(() => 'HEAD')
      const unmerged = await this.#d.exec
        .run(['ls-files', '-u'], { cwd: dir })
        .catch(() => '')
      const mergeHeadPath = await this.#d.exec
        .run(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: dir })
        .catch(() => '')
      const merging =
        Boolean(mergeHeadPath) &&
        existsSync(isAbsolute(mergeHeadPath) ? mergeHeadPath : join(dir, mergeHeadPath))
      infos.push({
        dir,
        branch,
        state: unmerged ? 'conflicted' : merging ? 'merging' : 'clean',
      })
    }
    return infos
  }

  // ------------------------------------------------------- 内部

  #wrap(
    dir: string,
    branch: string,
    sparse: SparsePath[],
    author: { name: string; email: string },
  ): GitRepo {
    this.#retain()
    let released = false
    return new GitRepo({
      dir,
      branch,
      sparse,
      author,
      exec: this.#d.exec,
      token: this.#d.token,
      fetch: () => this.fetch(),
      onDispose: async () => {
        if (released) return
        released = true
        try {
          await this.#removeWorktree(dir)
        } finally {
          this.#release()
        }
      },
    })
  }

  async #defaultBase(): Promise<string> {
    const head = await this.#d.exec
      .run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: this.storeDir })
      .catch(() => '')
    if (head) return head
    for (const cand of ['origin/main', 'origin/master']) {
      const ok = await this.#d.exec
        .run(['rev-parse', '--verify', '--quiet', cand], { cwd: this.storeDir })
        .catch(() => '')
      if (ok) return cand
    }
    return 'HEAD'
  }

  async #branchExists(branch: string): Promise<'local' | 'remote' | 'none'> {
    const local = await this.#d.exec
      .run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: this.storeDir })
      .catch(() => '')
    if (local) return 'local'
    const remote = await this.#d.exec
      .run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
        cwd: this.storeDir,
      })
      .catch(() => '')
    return remote ? 'remote' : 'none'
  }

  async #checkedOutBranches(): Promise<Set<string>> {
    const out = await this.#d.exec.run(['worktree', 'list', '--porcelain'], {
      cwd: this.storeDir,
    })
    const set = new Set<string>()
    for (const line of out.split('\n')) {
      if (line.startsWith('branch ')) {
        set.add(line.slice('branch '.length).trim().replace(/^refs\/heads\//, ''))
      }
    }
    return set
  }

  async #listRegisteredWorktrees(): Promise<string[]> {
    const out = await this.#d.exec.run(['worktree', 'list', '--porcelain'], {
      cwd: this.storeDir,
    })
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter((p) => p !== this.storeDir)
  }

  async #removeWorktree(dir: string): Promise<void> {
    await this.#d.mutex.run(this.key, async () => {
      try {
        await this.#d.exec.run(['worktree', 'remove', '--force', dir], { cwd: this.storeDir })
      } catch {
        await rm(dir, { recursive: true, force: true })
        await this.#d.exec.run(['worktree', 'prune'], { cwd: this.storeDir })
      }
    })
  }
}
