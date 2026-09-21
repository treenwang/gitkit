import { existsSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { Layout } from '../domain/layout-planner'
import { worktreeDirFor } from '../domain/layout-planner'
import { normalizeSparsePaths } from '../domain/sparse-manager'
import type { GitExecutor } from '../exec/git-executor'
import type { StoreMutex } from '../exec/store-mutex'
import type { ForgeProvider } from '../forge/types'
import { GitOpError, type PushResult, type SparsePath, type SparsePathInput } from '../types'
import { GitRepo, type PushOptions } from './git-repo'

export type SessionConfig = {
  branch: string
  branchMode?: 'create' | 'reuse' | 'createOrReuse'
  base?: string
  sparsePaths?: SparsePathInput[]
  author: { name: string; email: string }
  retryOnReject?: boolean
  /** This caller's credentials. Omitted, the token the store was built with is
   *  used, which is the single-tenant case. Callers sharing one store each bring
   *  their own token; a store's identity has nothing to do with credentials. */
  token?: string
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
  forge?: ForgeProvider
}

export type PublishConfig = SessionConfig & {
  message: string
  /** Omitted, whatever is currently changed in the worktree is used. */
  files?: { path: string; content: string }[]
} & PushOptions

/** The shared object database for one URL. Owns store-level state: refs and the worktree registry. */
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
  /** The configured forge (GitHub); undefined when not enabled. */
  get forge(): ForgeProvider | undefined { return this.#d.forge }
  get idleMs(): number { return Date.now() - this.#lastUsed }

  #touch(): void { this.#lastUsed = Date.now() }
  #retain(): void { this.#active += 1; this.#touch() }
  #release(): void { this.#active = Math.max(0, this.#active - 1); this.#touch() }

  async configGet(name: string): Promise<string> {
    return this.#d.exec.run(['config', '--get', name], { cwd: this.storeDir })
  }

  /** Short name of the repository's default branch ('main', 'master', ...).
   *  Returns null when it cannot be determined - whether to fall back to a
   *  convention or fail is the caller's call, not this package's guess. */
  async defaultBranch(): Promise<string | null> {
    const base = await this.#defaultBase()
    if (base === 'HEAD') return null
    return base.replace(/^origin\//, '')
  }

  /** storeDir's own HEAD, or 'HEAD' when detached. It should always be detached -
   *  see the detach after clone in RepoManager. */
  async currentHead(): Promise<string> {
    const out = await this.#d.exec.run(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: this.storeDir,
    })
    return out.trim()
  }

  // ------------------------------------------------------- store-level operations (locked)

  /** Writes refs and objects, so it has to be serialized.
   *  opts.token is *this caller's* credential; omitted, the token the store was
   *  built with is used, which is the single-tenant case. */
  async fetch(refspec?: string, opts: { token?: string } = {}): Promise<void> {
    this.#touch()
    const token = opts.token ?? this.#d.token
    await this.#d.mutex.run(this.key, () =>
      this.#d.exec.run(
        refspec ? ['fetch', 'origin', refspec] : ['fetch', '--prune', 'origin'],
        { cwd: this.storeDir, ...(token ? { token } : {}), phase: 'fetch' },
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

  /** Startup cleanup: reclaim orphaned worktrees left behind by a killed process. */
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

  // ------------------------------------------------------- session lifecycle

  async createSession(cfg: SessionConfig): Promise<GitRepo> {
    const sparse = normalizeSparsePaths(cfg.sparsePaths)
    const mode = cfg.branchMode ?? 'createOrReuse'
    const dir = worktreeDirFor(this.worktreeRoot, `s-${randomBytes(6).toString('hex')}`)
    // This caller's credential, carried through the three network-touching stages: fetch, worktree, checkout.
    const token = cfg.token ?? this.#d.token

    await this.fetch(undefined, ...(cfg.token ? [{ token: cfg.token }] as const : []))

    const created = await this.#d.mutex.run(this.key, async () => {
      if ((await this.#checkedOutBranches()).has(cfg.branch)) {
        throw new GitOpError(
          'BRANCH_IN_USE',
          `branch ${cfg.branch} is already checked out in another worktree`,
        )
      }
      const existing = await this.#branchExists(cfg.branch)
      if (mode === 'create' && existing !== 'none') {
        throw new GitOpError('BRANCH_EXISTS', `branch already exists: ${cfg.branch}`)
      }
      if (mode === 'reuse' && existing === 'none') {
        throw new GitOpError('BRANCH_NOT_FOUND', `no such branch: ${cfg.branch}`)
      }

      // The order matters: create an empty worktree, configure sparse, and only
      // then check out. Checking out first would make the partial clone fetch
      // every blob from the promisor remote.
      const addArgs = ['worktree', 'add', '--no-checkout']
      if (existing === 'local') {
        addArgs.push(dir, cfg.branch)
      } else {
        // --no-track: setting up tracking writes branch.<name>.* into the shared
        // .git/config, which is one more piece of shared mutable state. Every
        // operation here names its refspec and origin/<branch> explicitly and
        // does not rely on upstream tracking.
        const base = existing === 'remote'
          ? `origin/${cfg.branch}`
          : cfg.base ?? (await this.#defaultBase())
        addArgs.push('--no-track', '-b', cfg.branch, dir, base)
      }
      await this.#d.exec.run(addArgs, {
        cwd: this.storeDir, ...(token ? { token } : {}), phase: 'worktree',
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
        cwd: created, ...(token ? { token } : {}), phase: 'checkout',
      })
      // --worktree is required: without it this writes the shared .git/config,
      // so concurrent session creation fights over config.lock and every session
      // ends up with the same author. extensions.worktreeConfig was enabled when
      // the store was created.
      await this.#d.exec.run(['config', '--worktree', 'user.name', cfg.author.name], {
        cwd: created,
      })
      await this.#d.exec.run(['config', '--worktree', 'user.email', cfg.author.email], {
        cwd: created,
      })
    } catch (e) {
      await this.#removeWorktree(created).catch(() => undefined)
      throw e
    }

    return this.#wrap(created, cfg.branch, sparse, cfg.author, cfg.retryOnReject)
  }

  /**
   * Run a callback in a session that releases itself.
   *
   * The exit contract: the worktree is removed whether the callback returns or
   * throws - **except that if the worktree is still mid-merge on exit, it is
   * kept and MERGE_IN_PROGRESS is thrown** with the path in detail. Deleting
   * silently would discard the conflict state and any half-finished resolution;
   * keeping it silently would let the host believe everything was cleaned up.
   * Failing loudly is the only honest option.
   *
   * So programmatic conflict resolution belongs inside the callback. When the
   * conflict state has to outlive the call, use createSession with an explicit
   * dispose, or take the worktree over afterwards with attachSession.
   */
  async withSession<T>(cfg: SessionConfig, fn: (repo: GitRepo) => Promise<T>): Promise<T> {
    const repo = await this.createSession(cfg)
    let result: T
    try {
      result = await fn(repo)
    } catch (e) {
      await this.#disposeUnlessMerging(repo, e)
      throw e
    }
    await this.#disposeUnlessMerging(repo)
    return result
  }

  async #disposeUnlessMerging(repo: GitRepo, pending?: unknown): Promise<void> {
    let merging = false
    try {
      const st = await repo.status()
      merging = st.merging || st.conflicted.length > 0
    } catch {
      merging = false
    }
    if (!merging) {
      await repo.dispose().catch(() => undefined)
      return
    }
    // Keep the worktree but drop the claim on it, or the store's refcount never comes back down
    await repo.dispose({ keepWorktree: true }).catch(() => undefined)
    // Do not mask the original error when the callback itself already threw
    if (pending) return
    throw new GitOpError(
      'MERGE_IN_PROGRESS',
      `the session exited mid-merge, so the worktree was kept: ${repo.dir}. ` +
        `Take it over with store.attachSession('${repo.dir}'), or abortMerge() and dispose().`,
      { detail: repo.dir },
    )
  }

  /**
   * One call for the whole thing: open a session, write files, commit, push
   * (optionally opening a PR), release.
   *
   * How it differs from withSession: a push that conflicts **does not throw**.
   * It returns the `reason: 'conflict'` result as-is and **keeps the worktree**,
   * whose path is in the result's worktreeDir, because a conflict is a
   * first-class part of PushResult rather than an exception. Every other outcome
   * releases the worktree.
   */
  async publish(cfg: PublishConfig): Promise<PushResult> {
    const { message, files, createPR, merge, method, retryOnReject, ...sessionCfg } = cfg
    const repo = await this.createSession(sessionCfg)
    let result: PushResult
    try {
      for (const f of files ?? []) await repo.writeFile(f.path, f.content)
      await repo.commit({ message })
      result = await repo.push({
        ...(createPR !== undefined ? { createPR } : {}),
        ...(merge !== undefined ? { merge } : {}),
        ...(method !== undefined ? { method } : {}),
        ...(retryOnReject !== undefined ? { retryOnReject } : {}),
      })
    } catch (e) {
      await repo.dispose().catch(() => undefined)
      throw e
    }
    if (!result.ok && result.reason === 'conflict') {
      // Keep the worktree with the conflict state, but release the claim on it
      await repo.dispose({ keepWorktree: true }).catch(() => undefined)
      return result
    }
    await repo.dispose().catch(() => undefined)
    return result
  }

  /** Take over an existing worktree again, e.g. to recover conflict state after a restart. */
  async attachSession(worktreeDir: string): Promise<GitRepo> {
    if (!existsSync(worktreeDir)) {
      throw new GitOpError('INVALID_ARGUMENT', `no such worktree: ${worktreeDir}`)
    }
    const registered = await this.#listRegisteredWorktrees()
    if (!registered.includes(worktreeDir)) {
      throw new GitOpError(
        'INVALID_ARGUMENT',
        `${worktreeDir} is not a worktree registered with this store (${this.key})`,
      )
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

  // ------------------------------------------------------- internals

  #wrap(
    dir: string,
    branch: string,
    sparse: SparsePath[],
    author: { name: string; email: string },
    retryOnReject?: boolean,
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
      ...(this.#d.forge ? { forge: this.#d.forge } : {}),
      ...(retryOnReject !== undefined ? { retryOnReject } : {}),
      fetch: () => this.fetch(),
      onDispose: async (keepWorktree: boolean) => {
        if (released) return
        released = true
        try {
          if (!keepWorktree) await this.#removeWorktree(dir)
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
