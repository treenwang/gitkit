import type { AutoMergeOutcome, MergeMethod, PullRequest } from '../types'

export type CreatePRInput = {
  title: string
  body?: string
  base: string
  /** 省略则使用当前 session 的分支。 */
  head?: string
  draft?: boolean
}

export type ListPRQuery = {
  state?: 'open' | 'closed' | 'all'
  head?: string
  base?: string
}

/** 代码托管平台的抽象。第一版只实现 GitHub，接口预留给 GitLab/Bitbucket。 */
export interface ForgeProvider {
  createPR(input: CreatePRInput & { head: string }): Promise<PullRequest>
  listPRs(query?: ListPRQuery): Promise<PullRequest[]>
  getPR(number: number): Promise<PullRequest>
  mergePR(number: number, method: MergeMethod): Promise<AutoMergeOutcome>
  enableAutoMerge(number: number, method: MergeMethod): Promise<AutoMergeOutcome>
}
