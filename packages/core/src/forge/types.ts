import type { AutoMergeOutcome, MergeMethod, PullRequest } from '../types'

export type CreatePRInput = {
  title: string
  body?: string
  base: string
  /** Defaults to the current session's branch. */
  head?: string
  draft?: boolean
}

export type ListPRQuery = {
  state?: 'open' | 'closed' | 'all'
  head?: string
  base?: string
}

/** Abstraction over a code-hosting platform. Only GitHub is implemented so far; the interface leaves room for GitLab and Bitbucket. */
export interface ForgeProvider {
  createPR(input: CreatePRInput & { head: string }): Promise<PullRequest>
  listPRs(query?: ListPRQuery): Promise<PullRequest[]>
  getPR(number: number): Promise<PullRequest>
  mergePR(number: number, method: MergeMethod): Promise<AutoMergeOutcome>
  enableAutoMerge(number: number, method: MergeMethod): Promise<AutoMergeOutcome>
}
