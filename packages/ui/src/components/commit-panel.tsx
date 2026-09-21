import { createElement, useState } from 'react'
import type { ClientPushResult, MergeMode } from '@treenwang/gitkit-client'
import { useChanges, useCommit, usePush, useSessionStatus } from '../hooks/queries'
import { Button, cx, Muted, Panel } from './primitives'

export type CommitPanelProps = {
  /** The pull request's target branch. Omitted, the branch is pushed and no PR is opened. */
  base?: string
  defaultTitle?: string
  className?: string
  onResult?: (r: ClientPushResult) => void
}

/**
 * commit message, push, open a PR, pick a merge mode, show the result.
 *
 * It sends merge: 'auto' by default and lets the core package derive the mode
 * from requireChecks on the sparsePaths. "Merge now" is the explicit escape
 * hatch for a host that knows only check-exempt content changed - knowing
 * *what* changed is business knowledge that belongs to the host, not here.
 */
export function CommitPanel(props: CommitPanelProps): React.ReactElement {
  const status = useSessionStatus()
  const changes = useChanges()
  const commit = useCommit()
  const push = usePush()

  const [message, setMessage] = useState('')
  const [title, setTitle] = useState(props.defaultTitle ?? '')
  const [mergeNow, setMergeNow] = useState(false)
  const [result, setResult] = useState<ClientPushResult | undefined>(undefined)

  const changeCount = changes.data?.length ?? 0
  const conflicted = status.data?.conflicted.length ?? 0
  const busy = commit.isPending || push.isPending
  const canSubmit = message.trim().length > 0 && changeCount > 0 && conflicted === 0 && !busy

  async function submit(): Promise<void> {
    setResult(undefined)
    await commit.mutateAsync({ message: message.trim() })
    const merge: MergeMode = mergeNow ? 'now' : 'auto'
    const r = await push.mutateAsync(
      props.base
        ? { createPR: { title: title.trim() || message.trim(), base: props.base }, merge }
        : {},
    )
    setResult(r)
    props.onResult?.(r)
    if (r.ok) setMessage('')
  }

  return createElement(
    Panel,
    { className: cx('space-y-3 p-3', props.className) },

    conflicted > 0
      ? createElement(Muted, { className: 'text-destructive' },
          `${conflicted} files are conflicted and have to be resolved before you can commit.`)
      : null,

    createElement('textarea', {
      value: message,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(e.target.value),
      placeholder: 'What does this change do?',
      rows: 3,
      'aria-label': 'Commit message',
      className:
        'w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm ' +
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ' +
        'focus-visible:ring-ring',
    }),

    props.base
      ? createElement('input', {
          value: title,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value),
          placeholder: `Pull request title (merging into ${props.base})`,
          'aria-label': 'Pull request title',
          className:
            'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm ' +
            'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ' +
            'focus-visible:ring-ring',
        })
      : null,

    props.base
      ? createElement(
          'label',
          { className: 'flex items-center gap-2 text-sm text-muted-foreground' },
          createElement('input', {
            type: 'checkbox',
            checked: mergeNow,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMergeNow(e.target.checked),
            'aria-label': 'Merge now',
          }),
          'Merge now, skipping CI checks',
        )
      : null,

    createElement(
      'div',
      { className: 'flex items-center justify-between' },
      createElement(Muted, null,
        changeCount === 0 ? 'Nothing to commit' : `${changeCount} files to commit`),
      createElement(Button, {
        disabled: !canSubmit,
        onClick: () => { void submit() },
        children: busy ? 'Working...' : props.base ? 'Commit and open PR' : 'Commit and push',
      }),
    ),

    result ? createElement(ResultNotice, { result }) : null,
    commit.error || push.error
      ? createElement(Muted, { className: 'text-destructive' },
          `Failed: ${((commit.error ?? push.error) as Error).message}`)
      : null,
  )
}

function ResultNotice({ result }: { result: ClientPushResult }): React.ReactElement {
  if (!result.ok) {
    if (result.reason === 'conflict') {
      return createElement(Muted, { className: 'text-destructive' },
        `The remote has new changes that conflict with yours across ${result.conflicts.length} files, which have to be resolved first.`)
    }
    return createElement(Muted, { className: 'text-destructive' },
      `Push failed (${result.reason}): ${result.detail}`)
  }

  const pr = result.pr
  if (!pr) return createElement(Muted, null, 'Pushed.')

  const am = result.autoMerge
  const tail = !am
    ? 'No merge was requested.'
    : am.ok
      ? am.merged ? 'Merged.' : 'Set to merge automatically once the checks pass.'
      : `The pull request was opened, but the merge did not go through (${am.reason}).`

  return createElement(
    'div',
    { className: 'space-y-1' },
    createElement(Muted, null, `Pull request #${pr.number} opened. ${tail}`),
    createElement('a', {
      href: pr.url, target: '_blank', rel: 'noreferrer',
      className: 'text-sm underline underline-offset-2',
    }, 'Open on GitHub'),
  )
}
