import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { GitkitClient } from '@aaxis/gitkit-client'
import { GitkitProvider } from '../src/context'
import { ChangeList } from '../src/components/change-list'
import { CommitPanel } from '../src/components/commit-panel'
import { DiffView, renderUnifiedPatch } from '../src/components/diff-view'
import { FileEditor } from '../src/components/file-editor'
import { FileTree } from '../src/components/file-tree'
import { SyncStatus } from '../src/components/sync-status'

type Call = { op: string; params: any }
let calls: Call[]

function fakeClient(handlers: Record<string, (p: any) => any>) {
  const c = new GitkitClient({ baseUrl: '/g', sessionId: 's1' })
  ;(c as any).call = async (op: string, params: any) => {
    calls.push({ op, params })
    const h = handlers[op]
    if (!h) throw new Error(`未打桩的 op: ${op}`)
    return h(params)
  }
  return c
}

function mount(node: ReactNode, handlers: Record<string, (p: any) => any>, slots = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    createElement(QueryClientProvider, { client: qc },
      createElement(GitkitProvider, { client: fakeClient(handlers), components: slots }, node)),
  )
}

const CLEAN_STATUS = {
  branch: 'skills/alice-01', operation: null, clean: true,
  staged: [], modified: [], untracked: [], conflicted: [],
}

beforeEach(() => { calls = [] })
afterEach(() => { document.body.innerHTML = '' })

describe('FileTree', () => {
  const entries = [
    { path: 'prompts/agent-skills/hvac/pricing/voice/core.md', type: 'file', status: 'modified' },
    { path: 'prompts/agent-skills/catalog.yaml', type: 'file', status: 'clean' },
  ]

  test('渲染条目并标注状态', async () => {
    mount(createElement(FileTree, {}), { 'files.list': () => ({ entries }) })
    await screen.findByText(/core\.md/)
    expect(screen.getByText('已修改')).toBeDefined()
  })

  test('点击回调带上路径', async () => {
    const picked: string[] = []
    mount(createElement(FileTree, { onSelect: (p: string) => picked.push(p) }),
      { 'files.list': () => ({ entries }) })
    fireEvent.click(await screen.findByText(/core\.md/))
    expect(picked).toEqual(['prompts/agent-skills/hvac/pricing/voice/core.md'])
  })

  test('空列表给出提示而不是空白', async () => {
    mount(createElement(FileTree, {}), { 'files.list': () => ({ entries: [] }) })
    expect(await screen.findByText('没有文件')).toBeDefined()
  })

  test('加载失败时显示原因', async () => {
    mount(createElement(FileTree, {}), {
      'files.list': () => { throw new Error('boom') },
    })
    expect(await screen.findByText(/无法读取文件列表/)).toBeDefined()
  })
})

describe('FileEditor', () => {
  const read = { binary: false, content: '# skill', etag: 'e1', size: 7, truncated: false }

  test('把内容交给插槽渲染，不自带编辑器', async () => {
    mount(
      createElement(FileEditor, {
        path: 'a.md',
        children: (p: any) =>
          createElement('textarea', { value: p.content, onChange: () => {}, 'data-testid': 'ed' }),
      }),
      { 'files.read': () => read },
    )
    const ed = await screen.findByTestId('ed')
    expect((ed as HTMLTextAreaElement).value).toBe('# skill')
  })

  test('二进制文件不渲染插槽', async () => {
    mount(
      createElement(FileEditor, {
        path: 'a.bin',
        children: () => createElement('div', { 'data-testid': 'ed' }),
      }),
      { 'files.read': () => ({ binary: true, size: 12 }) },
    )
    expect(await screen.findByText(/二进制文件，不可编辑/)).toBeDefined()
    expect(screen.queryByTestId('ed')).toBeNull()
  })

  test('输入后显示未保存，保存完成后显示已保存', async () => {
    const { container } = mount(
      createElement(FileEditor, {
        path: 'a.md', debounceMs: 20,
        children: (p: any) => createElement('textarea', {
          value: p.content, 'data-testid': 'ed',
          onChange: (e: any) => p.onChange(e.target.value),
        }),
      }),
      { 'files.read': () => read, 'files.write': () => ({ etag: 'e2' }) },
    )
    const ed = await screen.findByTestId('ed')
    fireEvent.change(ed, { target: { value: 'changed' } })
    expect(container.querySelector('[data-save-state="dirty"]')).not.toBeNull()
    await waitFor(() =>
      expect(container.querySelector('[data-save-state="saved"]')).not.toBeNull())
  })

  test('截断的大文件明确警告不要在此编辑', async () => {
    mount(
      createElement(FileEditor, { path: 'big.md', children: () => null }),
      { 'files.read': () => ({ ...read, truncated: true, size: 99999 }) },
    )
    expect(await screen.findByText(/文件过大/)).toBeDefined()
  })
})

describe('DiffView', () => {
  test('内置渲染按行着色', () => {
    const { container } = render(
      createElement('div', null, renderUnifiedPatch(
        'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n ctx')) as any)
    const kinds = [...container.querySelectorAll('[data-kind]')].map((e) => e.getAttribute('data-kind'))
    expect(kinds).toEqual(['meta', 'hunk', 'del', 'add', 'ctx'])
  })

  test('无改动时给出提示', async () => {
    mount(createElement(DiffView, {}), { 'changes.diff': () => ({ patch: '', truncated: false }) })
    expect(await screen.findByText('没有改动')).toBeDefined()
  })

  test('renderDiff 插槽完全接管渲染', async () => {
    mount(createElement(DiffView, { renderDiff: (p: string) =>
      createElement('div', { 'data-testid': 'custom' }, `custom:${p.length}`) }),
      { 'changes.diff': () => ({ patch: '+a\n-b', truncated: false }) })
    expect(await screen.findByTestId('custom')).toBeDefined()
  })

  test('截断时提示', async () => {
    mount(createElement(DiffView, {}), {
      'changes.diff': () => ({ patch: '+a', truncated: true }),
    })
    expect(await screen.findByText(/差异过大/)).toBeDefined()
  })
})

describe('ChangeList', () => {
  test('列出改动并可点击', async () => {
    const picked: string[] = []
    mount(createElement(ChangeList, { onSelect: (p: string) => picked.push(p) }), {
      'changes.list': () => ({ files: [{ path: 'docs/a.md', status: 'modified', staged: false }] }),
    })
    fireEvent.click(await screen.findByText('docs/a.md'))
    expect(picked).toEqual(['docs/a.md'])
  })

  test('无改动时提示', async () => {
    mount(createElement(ChangeList, {}), { 'changes.list': () => ({ files: [] }) })
    expect(await screen.findByText('没有未提交的改动')).toBeDefined()
  })
})

describe('CommitPanel', () => {
  const handlers = (over: Record<string, (p: any) => any> = {}) => ({
    status: () => CLEAN_STATUS,
    'changes.list': () => ({ files: [{ path: 'docs/a.md', status: 'modified', staged: false }] }),
    commit: () => ({ sha: 'a'.repeat(40), changed: true }),
    push: () => ({ ok: true, pushed: true }),
    ...over,
  })

  test('没有 message 时不能提交', async () => {
    mount(createElement(CommitPanel, {}), handlers())
    const btn = await screen.findByRole('button', { name: '提交并推送' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  test('提交后依次调用 commit 与 push', async () => {
    mount(createElement(CommitPanel, {}), handlers())
    fireEvent.change(await screen.findByLabelText('提交信息'), { target: { value: 'docs: 更新' } })
    fireEvent.click(screen.getByRole('button', { name: '提交并推送' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'push')).toBe(true))
    const ops = calls.filter((c) => c.op === 'commit' || c.op === 'push').map((c) => c.op)
    expect(ops).toEqual(['commit', 'push'])
  })

  test('配置 base 时创建 PR，默认走 auto 推导', async () => {
    mount(createElement(CommitPanel, { base: 'main' }), handlers())
    fireEvent.change(await screen.findByLabelText('提交信息'), { target: { value: 'm' } })
    fireEvent.click(screen.getByRole('button', { name: '提交并创建 PR' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'push')).toBe(true))
    const push = calls.find((c) => c.op === 'push')!
    expect(push.params.merge).toBe('auto')
    expect(push.params.createPR).toMatchObject({ base: 'main', title: 'm' })
  })

  test('勾选立即合并后发送 merge: now', async () => {
    mount(createElement(CommitPanel, { base: 'main' }), handlers())
    fireEvent.change(await screen.findByLabelText('提交信息'), { target: { value: 'm' } })
    fireEvent.click(screen.getByLabelText('立即合并'))
    fireEvent.click(screen.getByRole('button', { name: '提交并创建 PR' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'push')).toBe(true))
    expect(calls.find((c) => c.op === 'push')!.params.merge).toBe('now')
  })

  test('PR 创建成功但合并被挡住时，仍展示 PR 已创建', async () => {
    mount(createElement(CommitPanel, { base: 'main' }), handlers({
      push: () => ({
        ok: true, pushed: true,
        pr: { number: 42, url: 'https://github.com/a/b/pull/42', head: 'h', base: 'main', title: 't', draft: false, state: 'open' },
        autoMerge: { ok: false, reason: 'blocked_by_checks', detail: 'x' },
      }),
    }))
    fireEvent.change(await screen.findByLabelText('提交信息'), { target: { value: 'm' } })
    fireEvent.click(screen.getByRole('button', { name: '提交并创建 PR' }))
    expect(await screen.findByText(/PR #42 已创建/)).toBeDefined()
    expect(screen.getByText(/合并未生效/)).toBeDefined()
  })

  test('推送冲突时说明需要先解决', async () => {
    mount(createElement(CommitPanel, {}), handlers({
      push: () => ({
        ok: false, pushed: false, reason: 'conflict',
        conflicts: [{ path: 'docs/a.md', type: 'both_modified', binary: false }],
      }),
    }))
    fireEvent.change(await screen.findByLabelText('提交信息'), { target: { value: 'm' } })
    fireEvent.click(screen.getByRole('button', { name: '提交并推送' }))
    expect(await screen.findByText(/冲突，涉及 1 个文件/)).toBeDefined()
  })

  test('存在冲突时禁止提交并说明原因', async () => {
    mount(createElement(CommitPanel, {}), handlers({
      status: () => ({ ...CLEAN_STATUS, clean: false, conflicted: ['docs/a.md'] }),
    }))
    expect(await screen.findByText(/有 1 个文件处于冲突中/)).toBeDefined()
    fireEvent.change(screen.getByLabelText('提交信息'), { target: { value: 'm' } })
    expect((screen.getByRole('button', { name: '提交并推送' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SyncStatus', () => {
  test('展示分支与干净状态', async () => {
    mount(createElement(SyncStatus, {}), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    })
    expect(await screen.findByText('skills/alice-01')).toBeDefined()
    expect(screen.getByText('干净')).toBeDefined()
  })

  test('拉取时把 ref 透传', async () => {
    mount(createElement(SyncStatus, { ref: 'origin/main' }), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    })
    fireEvent.click(await screen.findByRole('button', { name: '拉取更新' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'sync.pull')).toBe(true))
    expect(calls.find((c) => c.op === 'sync.pull')!.params).toEqual({ ref: 'origin/main' })
  })

  test('合并进行中时禁用拉取并提供放弃', async () => {
    mount(createElement(SyncStatus, {}), {
      status: () => ({ ...CLEAN_STATUS, operation: 'merge', clean: false, conflicted: ['a'] }),
    })
    expect(await screen.findByText('合并进行中')).toBeDefined()
    expect((screen.getByRole('button', { name: '拉取更新' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: '放弃合并' })).toBeDefined()
  })
})

describe('components 注入槽', () => {
  test('注入的 Button 完全接管渲染', async () => {
    const MyButton = (p: any) => createElement('button', { ...p, 'data-mine': 'yes' })
    mount(createElement(SyncStatus, {}), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    }, { Button: MyButton })
    await screen.findByText('skills/alice-01')
    expect(document.querySelector('[data-mine="yes"]')).not.toBeNull()
  })

  test('未注入时退化为带语义 token 的原生元素', async () => {
    mount(createElement(SyncStatus, {}), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    })
    await screen.findByText('skills/alice-01')
    const btn = screen.getByRole('button', { name: '拉取更新' })
    expect(btn.className).toContain('hover:bg-accent')
    expect(document.querySelector('[data-mine]')).toBeNull()
  })
})
