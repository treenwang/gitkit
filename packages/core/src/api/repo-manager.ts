import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { planLayout } from '../domain/layout-planner'
import { GitExecutor } from '../exec/git-executor'
import { StoreMutex } from '../exec/store-mutex'
import { GitHubProvider, type GitHubProviderConfig } from '../forge/github-provider'
import type { ForgeProvider } from '../forge/types'
import { GitOpError, type ProgressEvent } from '../types'
import { RepoStore } from './repo-store'

export type ManagerConfig = {
  root: string
  auth?: { token: string }
  gitPath?: string
  timeout?: number
  onProgress?: (e: ProgressEvent) => void
  /** 仅供测试覆盖；生产环境不要传。 */
  minGitVersion?: { major: number; minor: number; patch: number }
}

export type StoreConfig = {
  url: string
  auth?: { token: string }
  depth?: number
  /** partial clone filter，默认 'blob:none'；传 false 关闭。 */
  filter?: string | false
  /** 启用 GitHub PR 功能。token 省略时复用 git 的 token。 */
  github?: Omit<GitHubProviderConfig, 'url' | 'token'> & { token?: string }
  /** 直接注入自定义 ForgeProvider；优先于 github。 */
  forge?: ForgeProvider
}

export type GcReport = { removed: string[]; skippedActive: string[] }

const MIN_GIT = { major: 2, minor: 32, patch: 0 }

/** store 是共享对象库，同一 URL 只能有一份；配置不一致必须报错而非静默沿用。 */
function storeSignature(cfg: StoreConfig, fallbackToken?: string): string {
  return JSON.stringify({
    token: cfg.auth?.token ?? fallbackToken ?? null,
    depth: cfg.depth ?? null,
    filter: cfg.filter ?? 'blob:none',
    github: cfg.github ? { baseUrl: cfg.github.baseUrl ?? null, token: cfg.github.token ?? null } : null,
    forge: cfg.forge ? 'custom' : null,
  })
}

export class RepoManager {
  readonly #cfg: ManagerConfig
  readonly #exec: GitExecutor
  readonly #mutex = new StoreMutex()
  readonly #stores = new Map<string, Promise<RepoStore>>()
  readonly #signatures = new Map<string, string>()
  #preflight?: Promise<void>

  constructor(cfg: ManagerConfig) {
    this.#cfg = cfg
    this.#exec = new GitExecutor({
      gitPath: cfg.gitPath,
      timeout: cfg.timeout,
      onProgress: cfg.onProgress,
    })
  }

  async #ensurePreflight(): Promise<void> {
    this.#preflight ??= (async () => {
      const v = await this.#exec.version()
      const min = this.#cfg.minGitVersion ?? MIN_GIT
      const ok = v.major > min.major || (v.major === min.major && v.minor >= min.minor)
      if (!ok) {
        throw new GitOpError(
          'GIT_VERSION_TOO_OLD',
          `需要 git >= ${min.major}.${min.minor}，当前为 ${v.raw}`,
          { detail: v.raw },
        )
      }
    })()
    try {
      await this.#preflight
    } catch (e) {
      this.#preflight = undefined
      throw e
    }
  }

  async store(cfg: StoreConfig): Promise<RepoStore> {
    await this.#ensurePreflight()
    const layout = planLayout(this.#cfg.root, cfg.url)

    const signature = storeSignature(cfg, this.#cfg.auth?.token)
    const existing = this.#stores.get(layout.key)
    if (existing) {
      const prev = this.#signatures.get(layout.key)
      if (prev !== undefined && prev !== signature) {
        throw new GitOpError(
          'INVALID_ARGUMENT',
          `同一个 URL 只能有一个 store（共享对象库），但本次配置与首次不同：${cfg.url}。` +
            `请在首次调用时就给全配置，或先 evict 再重新 store。`,
        )
      }
      return existing
    }
    this.#signatures.set(layout.key, signature)

    const created = this.#mutex
      .run(layout.key, async () => {
        await mkdir(layout.worktreeRoot, { recursive: true })
        const token = cfg.auth?.token ?? this.#cfg.auth?.token

        if (!existsSync(join(layout.storeDir, '.git'))) {
          const args = ['clone', '--no-checkout']
          if (cfg.filter !== false) args.push(`--filter=${cfg.filter ?? 'blob:none'}`)
          if (cfg.depth) args.push('--depth', String(cfg.depth))
          args.push(cfg.url, layout.storeDir)
          await this.#exec.run(args, { token, phase: 'clone' })
        }
        // 幂等：即使复用已存在的 store 也确保这项配置存在
        await this.#exec.run(['config', 'extensions.worktreeConfig', 'true'], {
          cwd: layout.storeDir,
        })
        // storeDir 是共享对象库，工作区永远为空（--no-checkout）。但 clone 会把它的 HEAD
        // 指向默认分支，而 git 据此认为该分支「已在某个 worktree 中 checkout」——于是
        // createSession({ branch: 'main' }) 恒抛 BRANCH_IN_USE，默认分支变成不可用的。
        // 这里没有任何东西需要 HEAD 停在一个分支上，所以让它游离。同样是幂等的。
        await this.#detachStoreHead(layout.storeDir)

        const forge = cfg.forge ?? this.#buildForge(cfg, token)
        return new RepoStore({
          layout,
          exec: this.#exec,
          mutex: this.#mutex,
          token,
          url: cfg.url,
          ...(forge ? { forge } : {}),
        })
      })
      .then(async (store) => {
        await store.pruneOrphans()
        return store
      })
      .catch((e) => {
        this.#stores.delete(layout.key)
        this.#signatures.delete(layout.key)
        throw e
      })

    this.#stores.set(layout.key, created)
    return created
  }

  /** 让 storeDir 的 HEAD 游离，好把每一个分支都留给 worktree。已经游离时是空操作。 */
  async #detachStoreHead(storeDir: string): Promise<void> {
    const head = await this.#exec
      .run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: storeDir })
      .catch(() => 'HEAD')
    if (head.trim() === 'HEAD') return
    // 用 update-ref 而不是 `checkout --detach`：后者会把文件检出到工作区，破坏
    // storeDir 「工作区恒为空」的不变量（--no-checkout 的全部意义）。update-ref 只动
    // HEAD 这一个 ref，索引与工作区一概不碰。
    const sha = await this.#exec
      .run(['rev-parse', 'HEAD'], { cwd: storeDir })
      .catch(() => '')
    // 空仓库（clone 了一个没有提交的 remote）没有可指向的提交；保持原状即可，
    // 没有提交也就没有分支会被占用。
    if (!sha.trim()) return
    await this.#exec.run(['update-ref', '--no-deref', 'HEAD', sha.trim()], { cwd: storeDir })
  }

  #buildForge(cfg: StoreConfig, token?: string): ForgeProvider | undefined {
    if (!cfg.github) return undefined
    const forgeToken = cfg.github.token ?? token
    if (!forgeToken) {
      throw new GitOpError(
        'INVALID_ARGUMENT',
        '启用 github 需要 token：请在 github.token 或 auth.token 中提供',
      )
    }
    return new GitHubProvider({ ...cfg.github, url: cfg.url, token: forgeToken })
  }

  async evict(url: string): Promise<boolean> {
    const layout = planLayout(this.#cfg.root, url)
    const pending = this.#stores.get(layout.key)
    if (pending) {
      const store = await pending.catch(() => undefined)
      if (store && store.activeSessions > 0) return false
      this.#stores.delete(layout.key)
      this.#signatures.delete(layout.key)
    }
    if (!existsSync(layout.repoDir)) return false
    await rm(layout.repoDir, { recursive: true, force: true })
    return true
  }

  async gc(opts: { maxAgeMs?: number; maxAgeDays?: number } = {}): Promise<GcReport> {
    const maxAgeMs = opts.maxAgeMs ?? (opts.maxAgeDays !== undefined
      ? opts.maxAgeDays * 86_400_000
      : undefined)
    const report: GcReport = { removed: [], skippedActive: [] }
    for (const [key, pending] of [...this.#stores]) {
      const store = await pending.catch(() => undefined)
      if (!store) { this.#stores.delete(key); continue }
      if (store.activeSessions > 0) {
        report.skippedActive.push(key)
        continue
      }
      if (maxAgeMs !== undefined && store.idleMs < maxAgeMs) continue
      this.#stores.delete(key)
      this.#signatures.delete(key)
      await rm(store.repoDir, { recursive: true, force: true })
      report.removed.push(key)
    }
    return report
  }
}
