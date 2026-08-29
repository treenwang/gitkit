import { describe, expect, test } from 'bun:test'
import { GitHubProvider, parseRepoSlug } from '../../src/forge/github-provider'
import { GitOpError } from '../../src/types'
import { FakeOctokit, HttpError, rawPR } from '../helpers/fake-octokit'

const URL_ = 'https://github.com/acme/web'
const mk = (octokit: FakeOctokit) =>
  new GitHubProvider({ url: URL_, token: 'T', octokit })

describe('parseRepoSlug', () => {
  test('标准 URL', () => {
    expect(parseRepoSlug('https://github.com/acme/web')).toEqual({ owner: 'acme', repo: 'web' })
  })
  test('带 .git 后缀', () => {
    expect(parseRepoSlug('https://github.com/acme/web.git').repo).toBe('web')
  })
  test('GHE 带路径前缀时取最后两段', () => {
    expect(parseRepoSlug('https://ghe.corp.io/scm/team/proj'))
      .toEqual({ owner: 'team', repo: 'proj' })
  })
  test('缺少 owner/repo 抛错', () => {
    expect(() => parseRepoSlug('https://github.com/acme')).toThrow(GitOpError)
  })
})

describe('createPR', () => {
  test('发出正确的请求并映射返回值', async () => {
    const fake = new FakeOctokit().on('POST /repos/{owner}/{repo}/pulls', () => ({
      data: rawPR(),
    }))
    const pr = await mk(fake).createPR({
      title: 't', body: 'b', head: 'feat/x', base: 'main', draft: false,
    })
    expect(pr).toEqual({
      number: 42,
      url: 'https://github.com/acme/web/pull/42',
      title: 'title',
      draft: false,
      state: 'open',
      head: 'feat/x',
      base: 'main',
    })
    expect(fake.calls[0]!.params).toMatchObject({
      owner: 'acme', repo: 'web', title: 't', body: 'b', head: 'feat/x', base: 'main', draft: false,
    })
  })

  test('省略 body/draft 时填默认值', async () => {
    const fake = new FakeOctokit().on('POST /repos/{owner}/{repo}/pulls', () => ({ data: rawPR() }))
    await mk(fake).createPR({ title: 't', head: 'h', base: 'main' })
    expect(fake.calls[0]!.params).toMatchObject({ body: '', draft: false })
  })

  test('API 报错时抛 FORGE_API_ERROR', async () => {
    const fake = new FakeOctokit().on('POST /repos/{owner}/{repo}/pulls', () => {
      throw new HttpError(422, 'A pull request already exists')
    })
    const code = await mk(fake)
      .createPR({ title: 't', head: 'h', base: 'main' })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('FORGE_API_ERROR')
  })
})

describe('listPRs / getPR', () => {
  test('listPRs 默认只列 open，head 带 owner 前缀', async () => {
    const fake = new FakeOctokit().on('GET /repos/{owner}/{repo}/pulls', () => ({
      data: [rawPR(), rawPR({ number: 43 })],
    }))
    const prs = await mk(fake).listPRs({ head: 'feat/x' })
    expect(prs.map((p) => p.number)).toEqual([42, 43])
    expect(fake.calls[0]!.params).toMatchObject({ state: 'open', head: 'acme:feat/x' })
  })

  test('getPR 按编号取', async () => {
    const fake = new FakeOctokit().on('GET /repos/{owner}/{repo}/pulls/{pull_number}', () => ({
      data: rawPR({ number: 7 }),
    }))
    expect((await mk(fake).getPR(7)).number).toBe(7)
    expect(fake.calls[0]!.params).toMatchObject({ pull_number: 7 })
  })
})

describe('mergePR —— 立即合并', () => {
  test('成功', async () => {
    const fake = new FakeOctokit()
      .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => ({ data: { merged: true } }))
    expect(await mk(fake).mergePR(42, 'squash'))
      .toEqual({ ok: true, merged: true, scheduled: false })
    expect(fake.calls[0]!.params).toMatchObject({ pull_number: 42, merge_method: 'squash' })
  })

  test('405（分支保护未满足）→ blocked_by_checks，不抛错', async () => {
    const fake = new FakeOctokit()
      .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => {
        throw new HttpError(405, 'Pull Request is not mergeable')
      })
    expect(await mk(fake).mergePR(42, 'merge'))
      .toEqual({ ok: false, reason: 'blocked_by_checks', detail: 'Pull Request is not mergeable' })
  })

  test('409 → conflict', async () => {
    const fake = new FakeOctokit()
      .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => {
        throw new HttpError(409, 'Head branch was modified')
      })
    const r = await mk(fake).mergePR(42, 'merge')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('conflict')
  })

  test('403 → not_allowed', async () => {
    const fake = new FakeOctokit()
      .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => {
        throw new HttpError(403, 'Resource not accessible')
      })
    const r = await mk(fake).mergePR(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('not_allowed')
  })

  test('其他状态码 → api_error', async () => {
    const fake = new FakeOctokit()
      .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => {
        throw new HttpError(500, 'boom')
      })
    const r = await mk(fake).mergePR(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('api_error')
  })
})

describe('enableAutoMerge —— 等 CI', () => {
  const withPR = () =>
    new FakeOctokit().on('GET /repos/{owner}/{repo}/pulls/{pull_number}', () => ({
      data: rawPR({ node_id: 'PR_node_42' }),
    }))

  test('成功时返回 scheduled', async () => {
    const fake = withPR().onGraphql(() => ({ enablePullRequestAutoMerge: {} }))
    expect(await mk(fake).enableAutoMerge(42, 'squash'))
      .toEqual({ ok: true, merged: false, scheduled: true })
    expect(fake.graphqlCalls[0]!.vars).toEqual({
      pullRequestId: 'PR_node_42', mergeMethod: 'SQUASH',
    })
  })

  test('仓库未开启 auto-merge → not_allowed', async () => {
    const fake = withPR().onGraphql(() => {
      throw new Error('Auto-merge is not allowed for this repository')
    })
    const r = await mk(fake).enableAutoMerge(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('not_allowed')
  })

  test('PR 已有冲突 → conflict', async () => {
    const fake = withPR().onGraphql(() => {
      throw new Error('Pull request is in conflict and cannot be merged')
    })
    const r = await mk(fake).enableAutoMerge(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('conflict')
  })

  test('取 node_id 失败 → api_error', async () => {
    const fake = new FakeOctokit()
    const r = await mk(fake).enableAutoMerge(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('api_error')
  })
})

describe('optional dependency', () => {
  test('未注入 octokit 且未安装 @octokit/rest 时抛 FORGE_NOT_INSTALLED', async () => {
    const p = new GitHubProvider({ url: URL_, token: 'T' })
    const code = await p
      .createPR({ title: 't', head: 'h', base: 'main' })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('FORGE_NOT_INSTALLED')
  })
})
