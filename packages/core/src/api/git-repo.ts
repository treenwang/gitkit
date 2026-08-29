import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  buildConflictPlan,
  looksBinary,
  parseConflictHunks,
  parseRenameMap,
  parseUnmergedIndex,
  type ConflictPlan,
} from '../domain/conflict-parser'
import { buildResolvedContent } from '../domain/conflict-writer'
import { resolveWithin } from '../domain/path-guard'
import { assertValidRevision } from '../domain/ref-guard'
import { normalizeSparsePaths } from '../domain/sparse-manager'
import {
  decideRetry, deriveMergeMode, needsDerivation, resolveMergeMode,
} from '../domain/push-policy'
import type { CreatePRInput, ForgeProvider } from '../forge/types'
import type { ExecOptions, GitExecutor } from '../exec/git-executor'
import { FsGateway } from '../exec/fs-gateway'
import {
  GitOpError,
  type Conflict,
  type ConflictSide,
  type HunkChoice,
  type MergeMethod,
  type MergeMode,
  type PushResult,
  type Resolution,
  type SparsePath,
  type SparsePathInput,
} from '../types'

export type InProgressOperation = 'merge' | 'rebase' | 'cherry-pick' | null

export type StatusResult = {
  branch: string
  /** 正在进行中的多步操作；无则为 null。 */
  operation: InProgressOperation
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
  onDispose: (keepWorktree: boolean) => Promise<void>
  forge?: ForgeProvider
  retryOnReject?: boolean
}

export type PushOptions = {
  createPR?: CreatePRInput | false
  merge?: MergeMode
  method?: MergeMethod
  retryOnReject?: boolean
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

  /** 以 Buffer 读取；用于二进制探测与不可按 UTF-8 解码的内容。 */
  async readBuffer(rel: string): Promise<Buffer> {
    this.assertLive()
    return this.#fs.readBuffer(rel)
  }

  /** 删除工作区文件。commit 时 `git add -A` 会把它记录为删除。 */
  async deleteFile(rel: string): Promise<void> {
    this.assertLive()
    await this.#fs.deleteFile(rel)
  }

  /**
   * 当前改动的 diff。
   *
   * `paths` 强制经 PathGuard 校验 —— 调用方在物理上无法 diff 声明的 sparse 范围之外的
   * 内容。这既是安全边界，也把 partial clone 的惰性 blob 拉取限制在已声明的目录内。
   */
  async getDiff(
    opts: { paths?: string[]; against?: string; context?: number } = {},
  ): Promise<{ patch: string; truncated: boolean }> {
    this.assertLive()
    const paths = opts.paths ?? this.#d.sparse.map((s) => s.path)
    for (const p of paths) resolveWithin(this.#d.dir, p, this.#d.sparse)

    const context = Number(opts.context ?? 3)
    if (!Number.isInteger(context) || context < 0 || context > 1000) {
      throw new GitOpError('INVALID_ARGUMENT', `context 必须是 0..1000 的整数: ${opts.context}`)
    }
    const args = ['diff', `--unified=${context}`]
    if (opts.against) args.push(`${assertValidRevision(opts.against)}...HEAD`)
    args.push('--')
    if (paths.length > 0) args.push(...paths)

    const patch = await this.git(args)
    return { patch, truncated: false }
  }

  // ------------------------------------------------------------ 状态

  async #gitPathExists(name: string): Promise<boolean> {
    const p = await this.git(['rev-parse', '--git-path', name]).catch(() => '')
    if (!p) return false
    return existsSync(isAbsolute(p) ? p : join(this.#d.dir, p))
  }

  /**
   * 判断是否有进行中的多步操作。
   *
   * rebase 冲突**不会**产生 MERGE_HEAD —— 只看 MERGE_HEAD 会把还在冲突中的
   * worktree 误判为干净，从而被 withSession 直接删掉。必须同时检查
   * rebase-merge / rebase-apply 目录与 CHERRY_PICK_HEAD。
   */
  async operationInProgress(): Promise<InProgressOperation> {
    if (await this.#gitPathExists('MERGE_HEAD')) return 'merge'
    if (await this.#gitPathExists('rebase-merge')) return 'rebase'
    if (await this.#gitPathExists('rebase-apply')) return 'rebase'
    if (await this.#gitPathExists('CHERRY_PICK_HEAD')) return 'cherry-pick'
    return null
  }

  async isMerging(): Promise<boolean> {
    return (await this.operationInProgress()) !== null
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

    const operation = await this.operationInProgress()
    return {
      branch: this.#d.branch,
      operation,
      staged, modified, untracked, conflicted,
      merging: operation !== null,
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

    const operation = await this.operationInProgress()
    if (operation === 'rebase') {
      throw new GitOpError(
        'INVALID_ARGUMENT',
        'rebase 进行中不能用 commit 收尾（git commit 会留下未完成的 rebase 与游离 HEAD）。' +
          '解完冲突后请调用 continueRebase()，或 abortMerge() 放弃。',
      )
    }

    const staged = await this.git(['diff', '--cached', '--name-only'])
    const merging = operation !== null
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
    // ref 可能来自不可信输入；以 - 开头会被 git 当作选项解析
    const ref = assertValidRevision(opts.ref ?? `origin/${this.#d.branch}`)
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
    // 不用 --set-upstream：它会写共享的 .git/config（branch.<name>.remote/merge），
    // 并发 push 时争抢 config.lock。本包所有操作都显式指定 refspec 与
    // origin/<branch>，不依赖 upstream 跟踪。
    const args = ['push']
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

  /**
   * 完整的 push 流程：推分支 →（被拒则 pull 一次再推）→ 建 PR → 按模式合并。
   *
   * 预期结局一律用返回值表达，不抛错：push 被拒、有冲突、PR 被保护规则挡住
   * 都是常规路径。只有真异常（认证失败之外的 git 崩溃、参数非法）才抛。
   */
  async push(opts: PushOptions = {}): Promise<PushResult> {
    this.assertLive()
    const retryOnReject = opts.retryOnReject ?? this.#d.retryOnReject ?? true

    let attempt = 0
    for (;;) {
      const pushed = await this.pushBranch()
      if (pushed.ok) break

      if (pushed.reason !== 'rejected') {
        return { ok: false, pushed: false, reason: pushed.reason, detail: pushed.detail }
      }
      if (decideRetry({ retryOnReject, attempt }) === 'give_up') {
        return { ok: false, pushed: false, reason: 'rejected', detail: pushed.detail }
      }

      attempt += 1
      const pulled = await this.pull()
      if (pulled.conflicted) {
        // 停在 merge 中，把冲突现场交给宿主处理
        return {
          ok: false,
          pushed: false,
          reason: 'conflict',
          conflicts: await this.getConflicts(),
          worktreeDir: this.#d.dir,
        }
      }
    }

    if (!opts.createPR) return { ok: true, pushed: true }

    const forge = this.#d.forge
    if (!forge) {
      throw new GitOpError(
        'FORGE_NOT_INSTALLED',
        '要创建 PR 需要在 RepoManager/RepoStore 上配置 forge（GitHubProvider）',
      )
    }

    const input = { ...opts.createPR, head: opts.createPR.head ?? this.#d.branch }
    const pr = await forge.createPR(input)

    // 只有 'auto'（或省略）才需要这次 diff；显式指定模式时省掉一次 git 调用
    const derived = needsDerivation(opts.merge)
      ? deriveMergeMode(await this.diffSummary({ against: input.base }), this.#d.sparse)
      : 'checksPass'
    const mode = resolveMergeMode(opts.merge, derived)
    if (mode === false) return { ok: true, pushed: true, pr }

    const method = opts.method ?? 'squash'
    const autoMerge =
      mode === 'now'
        ? await forge.mergePR(pr.number, method)
        : await forge.enableAutoMerge(pr.number, method)

    // PR 已创建这一事实不受 auto-merge 结果影响
    return { ok: true, pushed: true, pr, autoMerge }
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
    const target = assertValidRevision(opts.against ?? 'HEAD~1')
    const out = await this.git(['diff', '--name-only', `${target}...HEAD`])
    return out ? out.split('\n').filter(Boolean) : []
  }

  async setSparsePaths(input: readonly SparsePathInput[]): Promise<void> {
    this.assertLive()
    const paths = normalizeSparsePaths(input)
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

  // ------------------------------------------------------------ 冲突

  /**
   * 返回结构化的冲突列表。
   *
   * 三方内容一律用 `cat-file blob <oid>` 按 stage 取 —— 工作区里的文件是
   * 带标记的混合体，既不是 ours 也不是 theirs。
   */
  async getConflicts(): Promise<Conflict[]> {
    this.assertLive()
    const raw = await this.git(['ls-files', '-u'])
    if (!raw) return []

    const entries = parseUnmergedIndex(raw)
    const plans = buildConflictPlan(entries, await this.#renameMaps())
    const swapped = (await this.operationInProgress()) === 'rebase'

    const conflicts: Conflict[] = []
    for (const plan of plans) {
      conflicts.push(await this.#hydrate(plan, swapped))
    }
    return conflicts
  }

  async #renameMaps(): Promise<{ ours: Map<string, string>; theirs: Map<string, string> }> {
    // rebase 期间是 REBASE_HEAD（正在重放的提交），merge 期间是 MERGE_HEAD
    const otherRef =
      (await this.operationInProgress()) === 'rebase' ? 'REBASE_HEAD' : 'MERGE_HEAD'
    const mergeBase = await this.git(['merge-base', 'HEAD', otherRef]).catch(() => '')
    if (!mergeBase) return { ours: new Map(), theirs: new Map() }
    const [ours, theirs] = await Promise.all([
      this.git(['diff', '--name-status', '-M', mergeBase, 'HEAD']).catch(() => ''),
      this.git(['diff', '--name-status', '-M', mergeBase, otherRef]).catch(() => ''),
    ])
    return { ours: parseRenameMap(ours), theirs: parseRenameMap(theirs) }
  }

  async #blob(side: ConflictSide | undefined): Promise<{ side?: ConflictSide; binary: boolean }> {
    if (!side) return { binary: false }
    const buf = await this.#d.exec.runBuffer(['cat-file', 'blob', side.oid], {
      cwd: this.#d.dir,
    })
    const binary = looksBinary(buf)
    return {
      side: binary ? { ...side } : { ...side, content: buf.toString('utf8') },
      binary,
    }
  }

  async #hydrate(plan: ConflictPlan, swapped: boolean): Promise<Conflict> {
    const [base, ours, theirs] = await Promise.all([
      this.#blob(plan.base),
      this.#blob(plan.ours),
      this.#blob(plan.theirs),
    ])
    const binary = base.binary || ours.binary || theirs.binary

    // rebase 期间 git 的 stage 2/3 语义与 merge 相反，这里统一归一化，
    // 使 `ours` 永远是"你这条分支的改动"
    const oursSide = swapped ? theirs.side : ours.side
    const theirsSide = swapped ? ours.side : theirs.side
    const ourPath = swapped ? plan.theirPath : plan.ourPath
    const theirPath = swapped ? plan.ourPath : plan.theirPath

    const conflict: Conflict = {
      path: plan.path,
      type: swapped ? swapType(plan.type) : plan.type,
      binary,
      ...(base.side ? { base: base.side } : {}),
      ...(oursSide ? { ours: oursSide } : {}),
      ...(theirsSide ? { theirs: theirsSide } : {}),
      ...(ourPath ? { ourPath } : {}),
      ...(theirPath ? { theirPath } : {}),
      ...(swapped ? { sidesSwapped: true } : {}),
    }

    // 只有双方都改了同一个文本文件，工作区里才会有 <<<<<<< 标记
    const hasMarkers =
      !binary && (plan.type === 'both_modified' || plan.type === 'both_added')
    if (hasMarkers && plan.worktreePath) {
      const text = await this.#fs.readFile(plan.worktreePath).catch(() => undefined)
      if (text !== undefined) {
        conflict.raw = text
        const hunks = parseConflictHunks(text)
        conflict.hunks = swapped
          ? hunks.map((h) => ({ ...h, ourLines: h.theirLines, theirLines: h.ourLines }))
          : hunks
      }
    }
    return conflict
  }

  /** 写回解决结果并 `git add`；返回仍未解决的冲突路径。 */
  async resolveConflicts(resolutions: readonly Resolution[]): Promise<{ remaining: string[] }> {
    this.assertLive()
    const conflicts = await this.getConflicts()
    const known = new Map(conflicts.map((c) => [c.path, c]))

    for (const r of resolutions) {
      const conflict = known.get(r.path)
      if (!conflict) {
        throw new GitOpError(
          'INVALID_ARGUMENT',
          `路径不在当前冲突集合中: ${r.path}（当前冲突: ${[...known.keys()].join(', ') || '无'}）`,
        )
      }
      await this.#applyResolution(conflict, r)
    }

    const remaining = await this.git(['diff', '--name-only', '--diff-filter=U'])
    return { remaining: remaining ? remaining.split('\n').filter(Boolean) : [] }
  }

  async #applyResolution(conflict: Conflict, r: Resolution): Promise<void> {
    const allPaths = [...new Set(
      [conflict.path, conflict.ourPath, conflict.theirPath].filter(Boolean) as string[],
    )]
    // 非 rename 冲突只有一个路径；rename 冲突可能同时涉及旧路径与双方新路径
    const primary = conflict.ourPath ?? conflict.theirPath ?? conflict.path

    if ('content' in r) {
      await this.#fs.writeFile(primary, r.content)
      await this.#dropOtherPaths(allPaths, primary)
      await this.git(['add', '--', primary])
      return
    }

    if (r.take === 'delete') {
      await this.git(['rm', '-f', '--ignore-unmatch', '--', ...allPaths])
      return
    }

    const side =
      r.take === 'base' ? conflict.base
      : r.take === 'ours' ? conflict.ours
      : conflict.theirs
    if (!side) {
      throw new GitOpError(
        'INVALID_ARGUMENT',
        `冲突 ${conflict.path} 没有 ${r.take} 侧（type=${conflict.type}）；` +
          `若要删除该文件请用 take: 'delete'`,
      )
    }

    const target =
      r.take === 'ours' ? (conflict.ourPath ?? conflict.path)
      : r.take === 'theirs' ? (conflict.theirPath ?? conflict.path)
      : conflict.path

    // 统一走 blob → Buffer → 落盘，二进制安全，且不依赖工作区当前内容
    const buf = await this.#d.exec.runBuffer(['cat-file', 'blob', side.oid], {
      cwd: this.#d.dir,
    })
    await this.#fs.writeBuffer(target, buf)
    await this.#dropOtherPaths(allPaths, target)
    await this.git(['add', '--', target])
  }

  /** rename 冲突下，选定一侧后要把其余路径从索引与工作区移除。 */
  async #dropOtherPaths(allPaths: readonly string[], keep: string): Promise<void> {
    const others = allPaths.filter((p) => p !== keep)
    if (others.length === 0) return
    await this.git(['rm', '-f', '--ignore-unmatch', '--', ...others])
  }

  /** 逐 hunk 选边的便利方法。choices 长度必须等于 hunks 数量。 */
  async resolveByHunks(path: string, choices: readonly HunkChoice[]): Promise<{ remaining: string[] }> {
    this.assertLive()
    const conflict = (await this.getConflicts()).find((c) => c.path === path)
    if (!conflict) {
      throw new GitOpError('INVALID_ARGUMENT', `路径不在当前冲突集合中: ${path}`)
    }
    if (conflict.raw === undefined) {
      throw new GitOpError(
        'INVALID_ARGUMENT',
        `冲突 ${path} 没有可逐块解决的文本标记（type=${conflict.type}, binary=${conflict.binary}）`,
      )
    }
    // raw 中的标记仍是 git 的原始顺序；归一化过的 choices 要换回去再套用
    const effective = conflict.sidesSwapped ? choices.map(swapChoice) : choices
    return this.resolveConflicts([
      { path, content: buildResolvedContent(conflict.raw, effective) },
    ])
  }

  /** 继续被冲突中断的 rebase。解完冲突并 add 之后调用。 */
  async continueRebase(): Promise<{ done: boolean; conflicted: boolean }> {
    this.assertLive()
    if ((await this.operationInProgress()) !== 'rebase') {
      throw new GitOpError('INVALID_ARGUMENT', '当前没有进行中的 rebase')
    }
    try {
      await this.git(['-c', 'core.editor=true', 'rebase', '--continue'])
    } catch (e) {
      if (await this.git(['ls-files', '-u']).catch(() => '')) {
        return { done: false, conflicted: true }
      }
      throw e
    }
    return { done: (await this.operationInProgress()) === null, conflicted: false }
  }

  /** 放弃进行中的操作（merge / rebase / cherry-pick），回到干净状态。 */
  async abortMerge(): Promise<void> {
    this.assertLive()
    const op = await this.operationInProgress()
    if (op === null) {
      throw new GitOpError('INVALID_ARGUMENT', '当前没有进行中的 merge / rebase / cherry-pick')
    }
    const cmd = op === 'rebase' ? 'rebase' : op === 'cherry-pick' ? 'cherry-pick' : 'merge'
    await this.git([cmd, '--abort'])
  }

  /**
   * 显式合并任意 ref（不含 fetch）。需要先取到远端改动请用 pull 或 store.fetch。
   */
  async merge(
    ref: string,
    opts: { noFastForward?: boolean } = {},
  ): Promise<{ conflicted: boolean }> {
    this.assertLive()
    const args = ['merge', '--no-edit']
    if (opts.noFastForward) args.push('--no-ff')
    args.push(assertValidRevision(ref))
    try {
      await this.git(args)
      return { conflicted: false }
    } catch (e) {
      if (await this.git(['ls-files', '-u']).catch(() => '')) return { conflicted: true }
      throw e
    }
  }

  /**
   * 检查并清理中断遗留的状态。**不会自动执行**，必须由宿主显式调用 ——
   * 自动 abort 可能丢掉别人已解了一半的冲突。
   */
  async recover(
    opts: { abortOperation?: boolean; clearIndexLock?: boolean } = {},
  ): Promise<{ operation: InProgressOperation; aborted: boolean; indexLockCleared: boolean }> {
    this.assertLive()
    const operation = await this.operationInProgress()

    let indexLockCleared = false
    if (opts.clearIndexLock) {
      const p = await this.git(['rev-parse', '--git-path', 'index.lock']).catch(() => '')
      const abs = p ? (isAbsolute(p) ? p : join(this.#d.dir, p)) : ''
      if (abs && existsSync(abs)) {
        await rm(abs, { force: true })
        indexLockCleared = true
      }
    }

    let aborted = false
    if (opts.abortOperation && operation !== null) {
      await this.abortMerge()
      aborted = true
    }
    return { operation, aborted, indexLockCleared }
  }

  /**
   * 释放 session。默认删除 worktree；`keepWorktree: true` 只解除持有关系
   * 而保留磁盘上的 worktree（用于把冲突现场留给宿主后续 attachSession 接管）。
   */
  async dispose(opts: { keepWorktree?: boolean } = {}): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    await this.#d.onDispose(opts.keepWorktree ?? false)
  }
}

/** rebase 归一化：deleted_by_them 与 deleted_by_us 互换。 */
function swapType(t: Conflict['type']): Conflict['type'] {
  if (t === 'deleted_by_them') return 'deleted_by_us'
  if (t === 'deleted_by_us') return 'deleted_by_them'
  return t
}

function swapChoice(c: HunkChoice): HunkChoice {
  if (c === 'ours') return 'theirs'
  if (c === 'theirs') return 'ours'
  return c
}
