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
  /** For tests to override; never pass this in production. */
  minGitVersion?: { major: number; minor: number; patch: number }
}

export type StoreConfig = {
  url: string
  auth?: { token: string }
  depth?: number
  /** Partial clone filter, 'blob:none' by default; pass false to disable. */
  filter?: string | false
  /** Enable GitHub pull requests. With the token omitted, git's token is reused. */
  github?: Omit<GitHubProviderConfig, 'url' | 'token'> & { token?: string }
  /** Inject a custom ForgeProvider directly; takes precedence over github. */
  forge?: ForgeProvider
}

export type GcReport = { removed: string[]; skippedActive: string[] }

const MIN_GIT = { major: 2, minor: 32, patch: 0 }

/** A store is a shared object database: one per URL. A configuration mismatch must fail rather than silently reuse the first one. */
/** The configuration that decides whether two store() calls share one copy on disk.
 *
 *  The token is deliberately not part of it. A shared object database is
 *  inherently multi-tenant - dedup exists precisely so several callers share one
 *  copy - and folding one caller's credentials into the store's identity would
 *  lock every other caller out of the same repository forever. Credentials are
 *  passed per call instead (see the token parameters on fetch and createSession).
 *
 *  The security boundary that follows is worth stating plainly: a store knows
 *  *which repository*, never *who*. Once one authorized caller has fetched it,
 *  the contents on disk are readable by any caller in this process. Deciding
 *  whether a given person may see a given repository is the caller's job; this
 *  package neither does it nor could. */
function storeSignature(cfg: StoreConfig): string {
  return JSON.stringify({
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
          `git >= ${min.major}.${min.minor} is required, found ${v.raw}`,
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

    const signature = storeSignature(cfg)
    const existing = this.#stores.get(layout.key)
    if (existing) {
      const prev = this.#signatures.get(layout.key)
      if (prev !== undefined && prev !== signature) {
        throw new GitOpError(
          'INVALID_ARGUMENT',
          `a URL may only have one store (the shared object database), and this ` +
            `configuration differs from the first one: ${cfg.url}. Pass the full ` +
            `configuration on the first call, or evict before calling store again.`,
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
        // Idempotent: make sure this setting exists even when reusing an existing store
        await this.#exec.run(['config', 'extensions.worktreeConfig', 'true'], {
          cwd: layout.storeDir,
        })
        // storeDir is the shared object database and its working tree is always
        // empty (--no-checkout). But clone points its HEAD at the default branch,
        // which makes git consider that branch "already checked out in a
        // worktree" - so createSession({ branch: 'main' }) always threw
        // BRANCH_IN_USE and the default branch became unusable. Nothing here
        // needs HEAD to sit on a branch, so detach it. Also idempotent.
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

  /** Detach storeDir's HEAD so every branch stays available to a worktree. A no-op when already detached. */
  async #detachStoreHead(storeDir: string): Promise<void> {
    const head = await this.#exec
      .run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: storeDir })
      .catch(() => 'HEAD')
    if (head.trim() === 'HEAD') return
    // update-ref rather than `checkout --detach`: the latter would materialize
    // files in the working tree, breaking storeDir's "working tree is always
    // empty" invariant, which is the whole point of --no-checkout. update-ref
    // touches the HEAD ref and nothing else - not the index, not the worktree.
    const sha = await this.#exec
      .run(['rev-parse', 'HEAD'], { cwd: storeDir })
      .catch(() => '')
    // An empty repository (a clone of a remote with no commits) has nothing to
    // point at. Leaving it alone is fine: with no commits, no branch is held.
    if (!sha.trim()) return
    await this.#exec.run(['update-ref', '--no-deref', 'HEAD', sha.trim()], { cwd: storeDir })
  }

  #buildForge(cfg: StoreConfig, token?: string): ForgeProvider | undefined {
    if (!cfg.github) return undefined
    const forgeToken = cfg.github.token ?? token
    if (!forgeToken) {
      throw new GitOpError(
        'INVALID_ARGUMENT',
        'enabling github requires a token: pass it as github.token or auth.token',
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
