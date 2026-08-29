import { GitOpError, type AutoMergeOutcome, type MergeMethod, type PullRequest } from '../types'
import type { CreatePRInput, ForgeProvider, ListPRQuery } from './types'

/**
 * octokit 的最小结构化接口。只依赖 request/graphql 这两个最底层方法，
 * 既减少耦合，也让测试用的 fake 能忠实还原真实行为。
 */
export interface OctokitLike {
  request(
    route: string,
    params?: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown }>
  graphql(query: string, vars?: Record<string, unknown>): Promise<unknown>
}

export type GitHubProviderConfig = {
  /** 仓库 URL，用于推导 owner/repo。 */
  url: string
  token: string
  /** GitHub Enterprise 的 API 根地址，如 https://ghe.corp.io/api/v3 */
  baseUrl?: string
  /** 注入现成的 octokit 实例；省略则在首次调用时动态 import @octokit/rest。 */
  octokit?: OctokitLike
}

export type RepoSlug = { owner: string; repo: string }

/** 从仓库 URL 推导 owner/repo。纯函数。 */
export function parseRepoSlug(url: string): RepoSlug {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GitOpError('INVALID_ARGUMENT', `无法解析仓库 URL: ${url}`)
  }
  const segs = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
  if (segs.length < 2) {
    throw new GitOpError('INVALID_ARGUMENT', `URL 中缺少 owner/repo: ${url}`)
  }
  // GHE 可能带路径前缀，owner/repo 永远是最后两段
  return { owner: segs[segs.length - 2]!, repo: segs[segs.length - 1]! }
}

type RawPR = {
  number: number
  html_url: string
  title: string
  draft?: boolean
  state: string
  head: { ref: string }
  base: { ref: string }
}

function toPullRequest(raw: RawPR): PullRequest {
  return {
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    draft: raw.draft ?? false,
    state: raw.state,
    head: raw.head.ref,
    base: raw.base.ref,
  }
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status
  return typeof s === 'number' ? s : undefined
}

function messageOf(e: unknown): string {
  return (e as { message?: string })?.message ?? String(e)
}

export class GitHubProvider implements ForgeProvider {
  readonly #cfg: GitHubProviderConfig
  readonly #slug: RepoSlug
  #client?: Promise<OctokitLike>

  constructor(cfg: GitHubProviderConfig) {
    this.#cfg = cfg
    this.#slug = parseRepoSlug(cfg.url)
  }

  get slug(): RepoSlug { return this.#slug }

  async #octokit(): Promise<OctokitLike> {
    if (this.#cfg.octokit) return this.#cfg.octokit
    this.#client ??= (async () => {
      // 用变量形式的说明符：@octokit/rest 是 optional peerDependency，
      // 未安装时不应让类型检查或打包失败，只在实际调用 PR 功能时才报错。
      const spec = '@octokit/rest'
      let mod: { Octokit: new (o: Record<string, unknown>) => OctokitLike }
      try {
        mod = (await import(/* @vite-ignore */ spec)) as never
      } catch (cause) {
        throw new GitOpError(
          'FORGE_NOT_INSTALLED',
          'PR 功能需要 @octokit/rest。请安装它，或改用 octokit 注入。' +
            '（核心 git 功能不受影响）',
          { cause },
        )
      }
      return new mod.Octokit({
        auth: this.#cfg.token,
        ...(this.#cfg.baseUrl ? { baseUrl: this.#cfg.baseUrl } : {}),
      })
    })()
    try {
      return await this.#client
    } catch (e) {
      this.#client = undefined
      throw e
    }
  }

  async #request(route: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const octokit = await this.#octokit()
    try {
      const res = await octokit.request(route, { ...this.#slug, ...params })
      return res.data
    } catch (e) {
      throw new GitOpError('FORGE_API_ERROR', messageOf(e), {
        detail: `${route} → HTTP ${statusOf(e) ?? '?'}`,
        cause: e,
      })
    }
  }

  async createPR(input: CreatePRInput & { head: string }): Promise<PullRequest> {
    const data = await this.#request('POST /repos/{owner}/{repo}/pulls', {
      title: input.title,
      body: input.body ?? '',
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    })
    return toPullRequest(data as RawPR)
  }

  async listPRs(query: ListPRQuery = {}): Promise<PullRequest[]> {
    const data = await this.#request('GET /repos/{owner}/{repo}/pulls', {
      state: query.state ?? 'open',
      ...(query.head ? { head: `${this.#slug.owner}:${query.head}` } : {}),
      ...(query.base ? { base: query.base } : {}),
    })
    return (data as RawPR[]).map(toPullRequest)
  }

  async getPR(number: number): Promise<PullRequest> {
    const data = await this.#request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      pull_number: number,
    })
    return toPullRequest(data as RawPR)
  }

  /** 立即合并。分支保护未满足时 GitHub 返回 405，映射成结构化结果而非抛错。 */
  async mergePR(number: number, method: MergeMethod): Promise<AutoMergeOutcome> {
    const octokit = await this.#octokit()
    try {
      await octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
        ...this.#slug,
        pull_number: number,
        merge_method: method,
      })
      return { ok: true, merged: true, scheduled: false }
    } catch (e) {
      const status = statusOf(e)
      const detail = messageOf(e)
      if (status === 405) return { ok: false, reason: 'blocked_by_checks', detail }
      if (status === 409) return { ok: false, reason: 'conflict', detail }
      if (status === 403) return { ok: false, reason: 'not_allowed', detail }
      return { ok: false, reason: 'api_error', detail }
    }
  }

  /**
   * 启用 GitHub 原生 auto-merge：不立即合，等必需检查与 review 满足后由
   * GitHub 自己合。前提是仓库设置里开了 "Allow auto-merge"。
   */
  async enableAutoMerge(number: number, method: MergeMethod): Promise<AutoMergeOutcome> {
    const octokit = await this.#octokit()
    let nodeId: string
    try {
      const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        ...this.#slug,
        pull_number: number,
      })
      nodeId = (res.data as { node_id: string }).node_id
    } catch (e) {
      return { ok: false, reason: 'api_error', detail: messageOf(e) }
    }

    const mutation = `
      mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId, mergeMethod: $mergeMethod
        }) { pullRequest { number } }
      }`

    try {
      await octokit.graphql(mutation, {
        pullRequestId: nodeId,
        mergeMethod: method.toUpperCase(),
      })
      return { ok: true, merged: false, scheduled: true }
    } catch (e) {
      const detail = messageOf(e)
      if (/auto-?merge is not allowed|not enabled/i.test(detail)) {
        return { ok: false, reason: 'not_allowed', detail }
      }
      if (/clean status|conflict/i.test(detail)) {
        return { ok: false, reason: 'conflict', detail }
      }
      return { ok: false, reason: 'api_error', detail }
    }
  }
}
