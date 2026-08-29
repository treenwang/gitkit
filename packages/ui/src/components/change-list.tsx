import { createElement } from 'react'
import type { ChangeEntry } from '@aaxis/gitkit-client'
import { useChanges } from '../hooks/queries'
import { Badge, cx, Muted, statusClass, statusLabel } from './primitives'

export type ChangeListProps = {
  selected?: string
  onSelect?: (path: string) => void
  className?: string
}

export function ChangeList(props: ChangeListProps): React.ReactElement {
  const query = useChanges()

  if (query.isLoading) return createElement(Muted, null, '正在读取改动…')
  if (query.error) {
    return createElement(Muted, { className: 'text-destructive' },
      `无法读取改动：${(query.error as Error).message}`)
  }
  const files = query.data ?? []
  if (files.length === 0) return createElement(Muted, null, '没有未提交的改动')

  return createElement(
    'ul',
    { className: cx('space-y-0.5', props.className) },
    ...files.map((f: ChangeEntry) =>
      createElement(
        'li',
        { key: f.path },
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => props.onSelect?.(f.path),
            'data-path': f.path,
            'data-status': f.status,
            className: cx(
              'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm',
              'hover:bg-accent hover:text-accent-foreground',
              props.selected === f.path && 'bg-accent text-accent-foreground',
            ),
          },
          createElement(Badge, { className: statusClass(f.status) }, statusLabel(f.status)),
          createElement('span', { className: 'truncate font-mono' }, f.path),
        ),
      ),
    ),
  )
}
