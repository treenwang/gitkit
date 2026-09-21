import { createElement } from 'react'
import { useAbortMerge, usePull, useSessionStatus } from '../hooks/queries'
import { Badge, Button, cx, Muted, Panel } from './primitives'

export type SyncStatusProps = {
  /** What to pull from, e.g. 'origin/main'. Omitted, the current branch's remote counterpart is used. */
  ref?: string
  className?: string
}

const OP_LABEL: Record<string, string> = {
  merge: 'Merge in progress', rebase: 'Rebase in progress', 'cherry-pick': 'Cherry-pick in progress',
}

export function SyncStatus(props: SyncStatusProps): React.ReactElement {
  const status = useSessionStatus()
  const pull = usePull()
  const abort = useAbortMerge()

  if (status.isLoading) return createElement(Muted, null, 'Loading status...')
  if (status.error) {
    return createElement(Muted, { className: 'text-destructive' },
      `Could not read the status: ${(status.error as Error).message}`)
  }

  const s = status.data!
  const busy = pull.isPending || abort.isPending

  return createElement(
    Panel,
    { className: cx('flex flex-wrap items-center gap-2 p-2', props.className) },
    createElement('span', { className: 'font-mono text-sm' }, s.branch),
    s.operation
      ? createElement(Badge, { className: 'text-destructive' }, OP_LABEL[s.operation] ?? s.operation)
      : createElement(Badge, null, s.clean ? 'Clean' : 'Uncommitted changes'),
    s.conflicted.length > 0
      ? createElement(Badge, { className: 'text-destructive' }, `${s.conflicted.length} conflicts`)
      : null,
    createElement('span', { className: 'flex-1' }),
    createElement(Button, {
      variant: 'ghost',
      disabled: busy || Boolean(s.operation),
      onClick: () => { void pull.mutate(props.ref ? { ref: props.ref } : {}) },
      children: pull.isPending ? 'Pulling...' : 'Pull',
    }),
    s.operation
      ? createElement(Button, {
          variant: 'ghost',
          disabled: busy,
          onClick: () => { void abort.mutate() },
          children: 'Abort merge',
        })
      : null,
    pull.error
      ? createElement(Muted, { className: 'w-full text-destructive' },
          `Pull failed: ${(pull.error as Error).message}`)
      : null,
  )
}
