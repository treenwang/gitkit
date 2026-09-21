import { describe, expect, test, vi } from 'vitest'
import { GitHubProvider, parseRepoSlug } from '../../src/forge/github-provider'
import { GitOpError } from '../../src/types'
import { FakeOctokit, HttpError, rawPR } from '../helpers/fake-octokit'

const URL_ = 'https://github.com/acme/web'
const mk = (octokit: FakeOctokit) =>
  new GitHubProvider({ url: URL_, token: 'T', octokit })

describe('parseRepoSlug', () => {
  test('a standard URL', () => {
    expect(parseRepoSlug('https://github.com/acme/web')).toEqual({ owner: 'acme', repo: 'web' })
  })
  test('with a .git suffix', () => {
    expect(parseRepoSlug('https://github.com/acme/web.git').repo).toBe('web')
  })
  test('with a GHE path prefix, the last two segments are taken', () => {
    expect(parseRepoSlug('https://ghe.corp.io/scm/team/proj'))
      .toEqual({ owner: 'team', repo: 'proj' })
  })
  test('throws when owner/repo is missing', () => {
    expect(() => parseRepoSlug('https://github.com/acme')).toThrow(GitOpError)
  })
})

describe('createPR', () => {
  test('sends the right request and maps the result', async () => {
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

  test('fills in defaults when body and draft are omitted', async () => {
    const fake = new FakeOctokit().on('POST /repos/{owner}/{repo}/pulls', () => ({ data: rawPR() }))
    await mk(fake).createPR({ title: 't', head: 'h', base: 'main' })
    expect(fake.calls[0]!.params).toMatchObject({ body: '', draft: false })
  })

  test('an API error throws FORGE_API_ERROR', async () => {
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
  test('listPRs lists open pull requests by default and prefixes head with the owner', async () => {
    const fake = new FakeOctokit().on('GET /repos/{owner}/{repo}/pulls', () => ({
      data: [rawPR(), rawPR({ number: 43 })],
    }))
    const prs = await mk(fake).listPRs({ head: 'feat/x' })
    expect(prs.map((p) => p.number)).toEqual([42, 43])
    expect(fake.calls[0]!.params).toMatchObject({ state: 'open', head: 'acme:feat/x' })
  })

  test('getPR fetches by number', async () => {
    const fake = new FakeOctokit().on('GET /repos/{owner}/{repo}/pulls/{pull_number}', () => ({
      data: rawPR({ number: 7 }),
    }))
    expect((await mk(fake).getPR(7)).number).toBe(7)
    expect(fake.calls[0]!.params).toMatchObject({ pull_number: 7 })
  })
})

describe('mergePR - merging right away', () => {
  test('success', async () => {
    const fake = new FakeOctokit()
      .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => ({ data: { merged: true } }))
    expect(await mk(fake).mergePR(42, 'squash'))
      .toEqual({ ok: true, merged: true, scheduled: false })
    expect(fake.calls[0]!.params).toMatchObject({ pull_number: 42, merge_method: 'squash' })
  })

  test('405, branch protection unsatisfied, becomes blocked_by_checks rather than throwing', async () => {
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

  test('any other status becomes api_error', async () => {
    const fake = new FakeOctokit()
      .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => {
        throw new HttpError(500, 'boom')
      })
    const r = await mk(fake).mergePR(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('api_error')
  })
})

describe('enableAutoMerge - waiting for CI', () => {
  const withPR = () =>
    new FakeOctokit().on('GET /repos/{owner}/{repo}/pulls/{pull_number}', () => ({
      data: rawPR({ node_id: 'PR_node_42' }),
    }))

  test('returns scheduled on success', async () => {
    const fake = withPR().onGraphql(() => ({ enablePullRequestAutoMerge: {} }))
    expect(await mk(fake).enableAutoMerge(42, 'squash'))
      .toEqual({ ok: true, merged: false, scheduled: true })
    expect(fake.graphqlCalls[0]!.vars).toEqual({
      pullRequestId: 'PR_node_42', mergeMethod: 'SQUASH',
    })
  })

  test('a repository with auto-merge turned off gives not_allowed', async () => {
    const fake = withPR().onGraphql(() => {
      throw new Error('Auto-merge is not allowed for this repository')
    })
    const r = await mk(fake).enableAutoMerge(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('not_allowed')
  })

  test('a pull request that already conflicts gives conflict', async () => {
    const fake = withPR().onGraphql(() => {
      throw new Error('Pull request is in conflict and cannot be merged')
    })
    const r = await mk(fake).enableAutoMerge(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('conflict')
  })

  test('failing to fetch node_id gives api_error', async () => {
    const fake = new FakeOctokit()
    const r = await mk(fake).enableAutoMerge(42, 'merge')
    if (!r.ok) expect(r.reason).toBe('api_error')
  })
})

describe('optional dependency', () => {
  // Make import('@octokit/rest') fail for certain. This cannot rely on the
  // repository happening not to have octokit installed: the moment any package
  // in the monorepo (examples/playground, say) depends on it, hoisting removes
  // that premise.
  vi.mock('@octokit/rest', () => {
    throw new Error("Cannot find package '@octokit/rest'")
  })

  test('throws FORGE_NOT_INSTALLED with no octokit injected and @octokit/rest absent', async () => {
    const p = new GitHubProvider({ url: URL_, token: 'T' })
    const code = await p
      .createPR({ title: 't', head: 'h', base: 'main' })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('FORGE_NOT_INSTALLED')
  })
})
