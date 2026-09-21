import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { RepoManager } from '../../src/api/repo-manager'
import type { RepoStore } from '../../src/api/repo-store'
import type { GitOpError } from '../../src/types'
import { FakeOctokit, HttpError, rawPR } from '../helpers/fake-octokit'
import { cleanup, makeBareRemote, pushToRemote, tempDir, urlOf } from '../helpers/fixtures'

let root: string, bare: string, fake: FakeOctokit
const AUTHOR = { name: 'Bot', email: 'bot@example.com' }

function baseFake(): FakeOctokit {
  return new FakeOctokit()
    .on('POST /repos/{owner}/{repo}/pulls', () => ({ data: rawPR() }))
    .on('GET /repos/{owner}/{repo}/pulls/{pull_number}', () => ({ data: rawPR() }))
    .on('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', () => ({ data: { merged: true } }))
    .onGraphql(() => ({ enablePullRequestAutoMerge: {} }))
}

async function makeStore(octokit: FakeOctokit): Promise<RepoStore> {
  return new RepoManager({ root: join(root, 'repos') }).store({
    url: urlOf(bare),
    github: { token: 'T', octokit },
  })
}

beforeEach(() => {
  root = tempDir()
  bare = makeBareRemote(root)
  fake = baseFake()
})
afterEach(() => cleanup(root))

const DOCS_FREE = [{ path: 'docs', requireChecks: false }]
const DOCS_CHECKED = [{ path: 'docs', requireChecks: true }]

describe('push + createPR', () => {
  test('opens a pull request without merging, with merge: false', async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g1', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', body: 'B', base: 'main' }, merge: false,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.pr!.number).toBe(42)
    expect(r.autoMerge).toBeUndefined()
    expect(fake.calls.some((c) => c.route.includes('/merge'))).toBe(false)
  })

  test('head defaults to the current branch', async () => {
    const store = await makeStore(fake)
    await store.publish({
      branch: 'feat/g2', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: false,
    })
    expect(fake.calls[0]!.params).toMatchObject({ head: 'feat/g2', base: 'main' })
  })
})

describe("deriving the merge mode with merge: 'auto'", () => {
  test('changing only requireChecks: false paths merges right away', async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g3', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'auto',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.autoMerge).toEqual({ ok: true, merged: true, scheduled: false })
    expect(fake.calls.some((c) => c.route.endsWith('/merge'))).toBe(true)
    expect(fake.graphqlCalls).toHaveLength(0)
  })

  test('touching a requireChecks: true path waits for CI', async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g4', sparsePaths: DOCS_CHECKED, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'auto',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.autoMerge).toEqual({ ok: true, merged: false, scheduled: true })
    expect(fake.graphqlCalls[0]!.vars).toMatchObject({ mergeMethod: 'SQUASH' })
  })

  test('mixed paths take the conservative answer and wait for CI', async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g5',
      sparsePaths: [{ path: 'docs', requireChecks: false }, { path: 'src', requireChecks: true }],
      author: AUTHOR,
      message: 'm',
      files: [{ path: 'docs/g.md', content: 'g' }, { path: 'src/g.ts', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'auto',
    })
    if (!r.ok) throw new Error('unreachable')
    expect(r.autoMerge?.ok === true && r.autoMerge.scheduled).toBe(true)
  })

  test('full-checkout mode, with no sparsePaths declared, waits for CI', async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g6', author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'auto',
    })
    if (!r.ok) throw new Error('unreachable')
    expect(r.autoMerge?.ok === true && r.autoMerge.scheduled).toBe(true)
  })

  test("an explicit merge: 'now' overrides the derivation and skips the extra diff", async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g7', sparsePaths: DOCS_CHECKED, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'now',
    })
    if (!r.ok) throw new Error('unreachable')
    expect(r.autoMerge).toEqual({ ok: true, merged: true, scheduled: false })
  })

  test('method can be specified', async () => {
    const store = await makeStore(fake)
    await store.publish({
      branch: 'feat/g8', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'now', method: 'rebase',
    })
    const call = fake.calls.find((c) => c.route.endsWith('/merge'))!
    expect(call.params).toMatchObject({ merge_method: 'rebase' })
  })
})

describe('a failed auto-merge does not change the fact that the PR exists', () => {
  test('blocked by protection rules with 405 still returns ok: true and the pr', async () => {
    const blocked = baseFake().on(
      'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge',
      () => { throw new HttpError(405, 'Pull Request is not mergeable') },
    )
    const store = await makeStore(blocked)
    const r = await store.publish({
      branch: 'feat/g9', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'now',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.pr!.number).toBe(42)
    expect(r.autoMerge!.ok).toBe(false)
    if (!r.autoMerge!.ok) expect(r.autoMerge!.reason).toBe('blocked_by_checks')
  })

  test('a repository without auto-merge still returns ok: true and the pr', async () => {
    const notAllowed = baseFake().onGraphql(() => {
      throw new Error('Auto-merge is not allowed for this repository')
    })
    const store = await makeStore(notAllowed)
    const r = await store.publish({
      branch: 'feat/g10', sparsePaths: DOCS_CHECKED, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'auto',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.pr).toBeDefined()
    if (!r.autoMerge!.ok) expect(r.autoMerge!.reason).toBe('not_allowed')
  })
})

describe('no pull request is opened when the push fails', () => {
  test('a rejected, conflicting push returns conflict and calls no GitHub API', async () => {
    const store = await makeStore(fake)
    await store.publish({
      branch: 'feat/g11', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'v1', files: [{ path: 'docs/x.md', content: 'v1' }], merge: false,
    })
    pushToRemote(root, bare, { 'docs/x.md': 'theirs' },
      { branch: 'feat/g11', message: 'theirs' })

    const before = fake.calls.length
    const r = await store.publish({
      branch: 'feat/g11', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'v2', files: [{ path: 'docs/x.md', content: 'ours' }],
      createPR: { title: 'T', base: 'main' }, merge: 'auto',
    })
    expect(r.ok).toBe(false)
    if (r.ok || r.reason !== 'conflict') throw new Error('unreachable')
    expect(fake.calls.length).toBe(before)
  })
})

describe('configuration validation', () => {
  test('enabling github with no token at all throws INVALID_ARGUMENT', async () => {
    const code = await new RepoManager({ root: join(root, 'repos') })
      .store({ url: urlOf(bare), github: {} })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('INVALID_ARGUMENT')
  })

  test('omitting github.token reuses auth.token', async () => {
    const store = await new RepoManager({
      root: join(root, 'repos'), auth: { token: 'shared' },
    }).store({ url: urlOf(bare), github: { octokit: fake } })
    const r = await store.publish({
      branch: 'feat/g12', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: false,
    })
    expect(r.ok).toBe(true)
  })
})
