import { createElement } from 'react'
import { useAbortMerge, usePull, useSessionStatus } from '../hooks/queries'
import { Badge, Button, cx, Muted, Panel } from './primitives'

export type SyncStatusProps = {
  /** 拉取的来源，例如 'origin/main'。省略则用当前分支的远端对应分支。 */
  ref?: string
  className?: string
}

const OP_LABEL: Record<string, string> = {
  merge: '合并进行中', rebase: 'rebase 进行中', 'cherry-pick': 'cherry-pick 进行中',
}

export function SyncStatus(props: SyncStatusProps): React.ReactElement {
  const status = useSessionStatus()
  const pull = usePull()
  const abort = useAbortMerge()

  if (status.isLoading) return createElement(Muted, null, '正在读取状态…')
  if (status.error) {
    return createElement(Muted, { className: 'text-destructive' },
      `无法读取状态：${(status.error as Error).message}`)
  }

  const s = status.data!
  const busy = pull.isPending || abort.isPending

  return createElement(
    Panel,
    { className: cx('flex flex-wrap items-center gap-2 p-2', props.className) },
    createElement('span', { className: 'font-mono text-sm' }, s.branch),
    s.operation
      ? createElement(Badge, { className: 'text-destructive' }, OP_LABEL[s.operation] ?? s.operation)
      : createElement(Badge, null, s.clean ? '干净' : '有未提交改动'),
    s.conflicted.length > 0
      ? createElement(Badge, { className: 'text-destructive' }, `${s.conflicted.length} 个冲突`)
      : null,
    createElement('span', { className: 'flex-1' }),
    createElement(Button, {
      variant: 'ghost',
      disabled: busy || Boolean(s.operation),
      onClick: () => { void pull.mutate(props.ref ? { ref: props.ref } : {}) },
      children: pull.isPending ? '拉取中…' : '拉取更新',
    }),
    s.operation
      ? createElement(Button, {
          variant: 'ghost',
          disabled: busy,
          onClick: () => { void abort.mutate() },
          children: '放弃合并',
        })
      : null,
    pull.error
      ? createElement(Muted, { className: 'w-full text-destructive' },
          `拉取失败：${(pull.error as Error).message}`)
      : null,
  )
}
