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
  /** 省略则使用 worktree 中当前的改动。 */
  files?: { path: string; content: string }[]
} & PushOptions

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
      // 必须用 --worktree：不带该选项会写共享的 .git/config，并发创建 session
      // 时会争抢 config.lock，而且所有 session 会共用同一个 author。
      // extensions.worktreeConfig 已在 store 创建时开启。
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

    return this.#wrap(created, cfg.branch, sparse, cfg.author)
  }

  /**
   * 在一个自动释放的 session 中执行回调。
   *
   * 退出契约：回调正常返回或抛错都会 remove worktree；**但如果退出时
   * worktree 仍处于 merge 中，则保留 worktree 并抛 MERGE_IN_PROGRESS**
   * （detail 带路径）。静默删除会丢掉冲突现场和宿主已解了一半的工作，
   * 静默保留又会让宿主以为已清理干净 —— 报错是唯一诚实的选择。
   *
   * 因此程序化解冲突应当发生在回调内部；需要让冲突现场跨越调用边界存活时，
   * 改用 createSession + 手动 dispose，或事后 attachSession 接管。
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
    // 保留 worktree，但解除持有关系，否则 store 的引用计数永远降不回来
    await repo.dispose({ keepWorktree: true }).catch(() => undefined)
    // 回调本身已经抛错时不再覆盖原始错误
    if (pending) return
    throw new GitOpError(
      'MERGE_IN_PROGRESS',
      `session 退出时仍处于 merge 中，worktree 已保留: ${repo.dir}。` +
        `请用 store.attachSession('${repo.dir}') 接管，或 abortMerge() 后 dispose()。`,
      { detail: repo.dir },
    )
  }

  /**
   * 一站式：开 session → 写文件 → commit → push（可建 PR）→ 释放。
   *
   * 与 withSession 的区别：push 产生冲突时**不抛错**，而是原样返回
   * `reason: 'conflict'` 的结果并**保留 worktree**（路径在结果的
   * worktreeDir 中），因为冲突是 PushResult 的一等公民而非异常。
   * 其余情况一律释放 worktree。
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
      // 保留 worktree（冲突现场），但释放持有关系
      await repo.dispose({ keepWorktree: true }).catch(() => undefined)
      return result
    }
    await repo.dispose().catch(() => undefined)
    return result
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
      ...(this.#d.forge ? { forge: this.#d.forge } : {}),
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
