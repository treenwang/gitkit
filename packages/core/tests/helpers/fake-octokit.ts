import type { OctokitLike } from '../../src/forge/github-provider'

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export type Call = { route: string; params: Record<string, unknown> }

type Handler = (params: Record<string, unknown>) => { status?: number; data?: unknown }

/** Reproduces octokit's request/graphql behaviour faithfully, including throwing with a status field. */
export class FakeOctokit implements OctokitLike {
  readonly calls: Call[] = []
  readonly graphqlCalls: Array<{ query: string; vars: Record<string, unknown> }> = []
  #routes = new Map<string, Handler>()
  #graphql: (vars: Record<string, unknown>) => unknown = () => ({})

  on(route: string, handler: Handler): this {
    this.#routes.set(route, handler)
    return this
  }

  onGraphql(fn: (vars: Record<string, unknown>) => unknown): this {
    this.#graphql = fn
    return this
  }

  async request(route: string, params: Record<string, unknown> = {}) {
    this.calls.push({ route, params })
    const handler = this.#routes.get(route)
    if (!handler) throw new HttpError(404, `route not registered: ${route}`)
    const r = handler(params)
    return { status: r.status ?? 200, data: r.data }
  }

  async graphql(query: string, vars: Record<string, unknown> = {}) {
    this.graphqlCalls.push({ query, vars })
    return this.#graphql(vars)
  }
}

export function rawPR(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    number: 42,
    node_id: 'PR_node_42',
    html_url: 'https://github.com/acme/web/pull/42',
    title: 'title',
    draft: false,
    state: 'open',
    head: { ref: 'feat/x' },
    base: { ref: 'main' },
    ...over,
  }
}
