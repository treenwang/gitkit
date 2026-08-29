import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
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
  test('建 PR 但不合并（merge: false）', async () => {
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

  test('head 默认取当前分支', async () => {
    const store = await makeStore(fake)
    await store.publish({
      branch: 'feat/g2', sparsePaths: DOCS_FREE, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: false,
    })
    expect(fake.calls[0]!.params).toMatchObject({ head: 'feat/g2', base: 'main' })
  })
})

describe("merge 模式推导（merge: 'auto'）", () => {
  test('只改 requireChecks: false 的路径 → 立即合并', async () => {
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

  test('改了 requireChecks: true 的路径 → 等 CI', async () => {
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

  test('混合路径取最保守 → 等 CI', async () => {
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

  test('全量模式（未声明 sparsePaths）→ 等 CI', async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g6', author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'auto',
    })
    if (!r.ok) throw new Error('unreachable')
    expect(r.autoMerge?.ok === true && r.autoMerge.scheduled).toBe(true)
  })

  test("显式 merge: 'now' 覆盖推导，且不额外做 diff", async () => {
    const store = await makeStore(fake)
    const r = await store.publish({
      branch: 'feat/g7', sparsePaths: DOCS_CHECKED, author: AUTHOR,
      message: 'm', files: [{ path: 'docs/g.md', content: 'g' }],
      createPR: { title: 'T', base: 'main' }, merge: 'now',
    })
    if (!r.ok) throw new Error('unreachable')
    expect(r.autoMerge).toEqual({ ok: true, merged: true, scheduled: false })
  })

  test('method 可指定', async () => {
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

describe('auto-merge 失败不影响 PR 已创建这一事实', () => {
  test('405 被保护规则挡住时仍返回 ok: true 与 pr', async () => {
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

  test('仓库未开 auto-merge 时仍返回 ok: true 与 pr', async () => {
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

describe('push 失败时不建 PR', () => {
  test('被拒且冲突时返回 conflict，未调用任何 GitHub API', async () => {
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

describe('配置校验', () => {
  test('启用 github 但没有任何 token 时抛 INVALID_ARGUMENT', async () => {
    const code = await new RepoManager({ root: join(root, 'repos') })
      .store({ url: urlOf(bare), github: {} })
      .then(() => 'NO_THROW', (e: GitOpError) => e.code)
    expect(code).toBe('INVALID_ARGUMENT')
  })

  test('github.token 省略时复用 auth.token', async () => {
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
