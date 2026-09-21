import { GitOpError, type AutoMergeOutcome, type MergeMethod, type PullRequest } from '../types'
import type { CreatePRInput, ForgeProvider, ListPRQuery } from './types'

/**
 * The minimal structural interface over octokit. It depends only on request
 * and graphql, the two lowest-level methods, which keeps coupling down and lets
 * the test fake reproduce real behaviour faithfully.
 */
export interface OctokitLike {
  request(
    route: string,
    params?: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown }>
  graphql(query: string, vars?: Record<string, unknown>): Promise<unknown>
}

export type GitHubProviderConfig = {
  /** Repository URL, used to derive owner/repo. */
  url: string
  token: string
  /** API root for GitHub Enterprise, e.g. https://ghe.corp.io/api/v3 */
  baseUrl?: string
  /** Inject a ready-made octokit instance; omitted, @octokit/rest is imported dynamically on first use. */
  octokit?: OctokitLike
}

export type RepoSlug = { owner: string; repo: string }

/** Derive owner/repo from a repository URL. Pure function. */
export function parseRepoSlug(url: string): RepoSlug {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new GitOpError('INVALID_ARGUMENT', `cannot parse the repository URL: ${url}`)
  }
  const segs = parsed.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
  if (segs.length < 2) {
    throw new GitOpError('INVALID_ARGUMENT', `URL has no owner/repo: ${url}`)
  }
  // GHE may add a path prefix; owner/repo are always the last two segments
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
      // A variable specifier on purpose: @octokit/rest is an optional
      // peerDependency, so its absence must not break typechecking or bundling.
      // It should only fail when pull request features are actually used.
      const spec = '@octokit/rest'
      let mod: { Octokit: new (o: Record<string, unknown>) => OctokitLike }
      try {
        mod = (await import(/* @vite-ignore */ spec)) as never
      } catch (cause) {
        throw new GitOpError(
          'FORGE_NOT_INSTALLED',
          'Pull request support needs @octokit/rest. Install it, or inject an ' +
            'octokit instance instead. (Core git features are unaffected.)',
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

  /** Merge right away. When branch protection is unsatisfied GitHub answers 405, which is mapped to a structured result rather than thrown. */
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
   * Turn on GitHub's native auto-merge: do not merge now, let GitHub merge once
   * the required checks and reviews are satisfied. This needs "Allow auto-merge"
   * enabled in the repository settings.
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
