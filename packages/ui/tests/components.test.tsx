import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { GitkitClient } from '@treenwang/gitkit-client'
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
    if (!h) throw new Error(`op not stubbed: ${op}`)
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

  test('renders entries and labels their status', async () => {
    mount(createElement(FileTree, {}), { 'files.list': () => ({ entries }) })
    await screen.findByText(/core\.md/)
    expect(screen.getByText('modified')).toBeDefined()
  })

  test('the click callback carries the path', async () => {
    const picked: string[] = []
    mount(createElement(FileTree, { onSelect: (p: string) => picked.push(p) }),
      { 'files.list': () => ({ entries }) })
    fireEvent.click(await screen.findByText(/core\.md/))
    expect(picked).toEqual(['prompts/agent-skills/hvac/pricing/voice/core.md'])
  })

  test('an empty list says so instead of rendering nothing', async () => {
    mount(createElement(FileTree, {}), { 'files.list': () => ({ entries: [] }) })
    expect(await screen.findByText('No files')).toBeDefined()
  })

  test('shows the reason when loading fails', async () => {
    mount(createElement(FileTree, {}), {
      'files.list': () => { throw new Error('boom') },
    })
    expect(await screen.findByText(/Could not read the file list/)).toBeDefined()
  })
})

describe('FileEditor', () => {
  const read = { binary: false, content: '# skill', etag: 'e1', size: 7, truncated: false }

  test('hands the content to the slot and ships no editor of its own', async () => {
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

  test('does not render the slot for a binary file', async () => {
    mount(
      createElement(FileEditor, {
        path: 'a.bin',
        children: () => createElement('div', { 'data-testid': 'ed' }),
      }),
      { 'files.read': () => ({ binary: true, size: 12 }) },
    )
    expect(await screen.findByText(/Binary file, not editable/)).toBeDefined()
    expect(screen.queryByTestId('ed')).toBeNull()
  })

  test('shows Unsaved while typing and Saved once the save lands', async () => {
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

  test('a truncated large file warns explicitly against editing here', async () => {
    mount(
      createElement(FileEditor, { path: 'big.md', children: () => null }),
      { 'files.read': () => ({ ...read, truncated: true, size: 99999 }) },
    )
    expect(await screen.findByText(/too large/)).toBeDefined()
  })
})

describe('DiffView', () => {
  test('the built-in rendering colours each line', () => {
    const { container } = render(
      createElement('div', null, renderUnifiedPatch(
        'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n ctx')) as any)
    const kinds = [...container.querySelectorAll('[data-kind]')].map((e) => e.getAttribute('data-kind'))
    expect(kinds).toEqual(['meta', 'hunk', 'del', 'add', 'ctx'])
  })

  test('says so when there is no diff', async () => {
    mount(createElement(DiffView, {}), { 'changes.diff': () => ({ patch: '', truncated: false }) })
    expect(await screen.findByText('No changes')).toBeDefined()
  })

  test('the renderDiff slot takes rendering over completely', async () => {
    mount(createElement(DiffView, { renderDiff: (p: string) =>
      createElement('div', { 'data-testid': 'custom' }, `custom:${p.length}`) }),
      { 'changes.diff': () => ({ patch: '+a\n-b', truncated: false }) })
    expect(await screen.findByTestId('custom')).toBeDefined()
  })

  test('says so when the diff is truncated', async () => {
    mount(createElement(DiffView, {}), {
      'changes.diff': () => ({ patch: '+a', truncated: true }),
    })
    expect(await screen.findByText(/diff is too large/)).toBeDefined()
  })
})

describe('ChangeList', () => {
  test('lists the changes and makes them clickable', async () => {
    const picked: string[] = []
    mount(createElement(ChangeList, { onSelect: (p: string) => picked.push(p) }), {
      'changes.list': () => ({ files: [{ path: 'docs/a.md', status: 'modified', staged: false }] }),
    })
    fireEvent.click(await screen.findByText('docs/a.md'))
    expect(picked).toEqual(['docs/a.md'])
  })

  test('says so when there is nothing to commit', async () => {
    mount(createElement(ChangeList, {}), { 'changes.list': () => ({ files: [] }) })
    expect(await screen.findByText('No uncommitted changes')).toBeDefined()
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

  test('cannot commit without a message', async () => {
    mount(createElement(CommitPanel, {}), handlers())
    const btn = await screen.findByRole('button', { name: 'Commit and push' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  test('calls commit and then push', async () => {
    mount(createElement(CommitPanel, {}), handlers())
    fireEvent.change(await screen.findByLabelText('Commit message'), { target: { value: 'docs: update' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit and push' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'push')).toBe(true))
    const ops = calls.filter((c) => c.op === 'commit' || c.op === 'push').map((c) => c.op)
    expect(ops).toEqual(['commit', 'push'])
  })

  test('opens a PR when base is set, deriving the mode with auto by default', async () => {
    mount(createElement(CommitPanel, { base: 'main' }), handlers())
    fireEvent.change(await screen.findByLabelText('Commit message'), { target: { value: 'm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit and open PR' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'push')).toBe(true))
    const push = calls.find((c) => c.op === 'push')!
    expect(push.params.merge).toBe('auto')
    expect(push.params.createPR).toMatchObject({ base: 'main', title: 'm' })
  })

  test('checking Merge now sends merge: now', async () => {
    mount(createElement(CommitPanel, { base: 'main' }), handlers())
    fireEvent.change(await screen.findByLabelText('Commit message'), { target: { value: 'm' } })
    fireEvent.click(screen.getByLabelText('Merge now'))
    fireEvent.click(screen.getByRole('button', { name: 'Commit and open PR' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'push')).toBe(true))
    expect(calls.find((c) => c.op === 'push')!.params.merge).toBe('now')
  })

  test('still reports the PR as opened when the merge was blocked', async () => {
    mount(createElement(CommitPanel, { base: 'main' }), handlers({
      push: () => ({
        ok: true, pushed: true,
        pr: { number: 42, url: 'https://github.com/a/b/pull/42', head: 'h', base: 'main', title: 't', draft: false, state: 'open' },
        autoMerge: { ok: false, reason: 'blocked_by_checks', detail: 'x' },
      }),
    }))
    fireEvent.change(await screen.findByLabelText('Commit message'), { target: { value: 'm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit and open PR' }))
    expect(await screen.findByText(/Pull request #42 opened/)).toBeDefined()
    expect(screen.getByText(/merge did not go through/)).toBeDefined()
  })

  test('explains that a push conflict has to be resolved first', async () => {
    mount(createElement(CommitPanel, {}), handlers({
      push: () => ({
        ok: false, pushed: false, reason: 'conflict',
        conflicts: [{ path: 'docs/a.md', type: 'both_modified', binary: false }],
      }),
    }))
    fireEvent.change(await screen.findByLabelText('Commit message'), { target: { value: 'm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Commit and push' }))
    expect(await screen.findByText(/conflict with yours across 1 files/)).toBeDefined()
  })

  test('blocks committing while conflicts exist and says why', async () => {
    mount(createElement(CommitPanel, {}), handlers({
      status: () => ({ ...CLEAN_STATUS, clean: false, conflicted: ['docs/a.md'] }),
    }))
    expect(await screen.findByText(/1 files are conflicted/)).toBeDefined()
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'm' } })
    expect((screen.getByRole('button', { name: 'Commit and push' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('SyncStatus', () => {
  test('shows the branch and the clean state', async () => {
    mount(createElement(SyncStatus, {}), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    })
    expect(await screen.findByText('skills/alice-01')).toBeDefined()
    expect(screen.getByText('Clean')).toBeDefined()
  })

  test('passes ref through when pulling', async () => {
    mount(createElement(SyncStatus, { ref: 'origin/main' }), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Pull' }))
    await waitFor(() => expect(calls.some((c) => c.op === 'sync.pull')).toBe(true))
    expect(calls.find((c) => c.op === 'sync.pull')!.params).toEqual({ ref: 'origin/main' })
  })

  test('disables pulling during a merge and offers to abort', async () => {
    mount(createElement(SyncStatus, {}), {
      status: () => ({ ...CLEAN_STATUS, operation: 'merge', clean: false, conflicted: ['a'] }),
    })
    expect(await screen.findByText('Merge in progress')).toBeDefined()
    expect((screen.getByRole('button', { name: 'Pull' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Abort merge' })).toBeDefined()
  })
})

describe('injected component slots', () => {
  test('an injected Button takes rendering over completely', async () => {
    const MyButton = (p: any) => createElement('button', { ...p, 'data-mine': 'yes' })
    mount(createElement(SyncStatus, {}), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    }, { Button: MyButton })
    await screen.findByText('skills/alice-01')
    expect(document.querySelector('[data-mine="yes"]')).not.toBeNull()
  })

  test('falls back to a plain element with semantic tokens when nothing is injected', async () => {
    mount(createElement(SyncStatus, {}), {
      status: () => CLEAN_STATUS, 'sync.pull': () => ({ conflicted: false }),
    })
    await screen.findByText('skills/alice-01')
    const btn = screen.getByRole('button', { name: 'Pull' })
    expect(btn.className).toContain('hover:bg-accent')
    expect(document.querySelector('[data-mine]')).toBeNull()
  })
})
