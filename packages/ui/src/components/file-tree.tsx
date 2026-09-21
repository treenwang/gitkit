import { createElement, Fragment } from 'react'
import type { FileEntry } from '@treenwang/gitkit-client'
import { useFileTree } from '../hooks/queries'
import { Badge, cx, Muted, statusClass, statusLabel } from './primitives'

export type FileTreeProps = {
  dir?: string
  selected?: string
  onSelect?: (path: string) => void
  className?: string
}

export function FileTree(props: FileTreeProps): React.ReactElement {
  const query = useFileTree(props.dir)

  if (query.isLoading) return createElement(Muted, null, 'Loading files...')
  if (query.error) {
    return createElement(Muted, { className: 'text-destructive' },
      `Could not read the file list: ${(query.error as Error).message}`)
  }

  const entries = query.data ?? []
  if (entries.length === 0) return createElement(Muted, null, 'No files')

  return createElement(
    'ul',
    { className: cx('space-y-0.5', props.className), role: 'tree' },
    ...entries.map((e: FileEntry) =>
      createElement(
        'li',
        { key: e.path, role: 'treeitem', 'aria-selected': props.selected === e.path },
        createElement(
          'button',
          {
            type: 'button',
            onClick: () => props.onSelect?.(e.path),
            'data-path': e.path,
            'data-status': e.status,
            className: cx(
              'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm',
              'hover:bg-accent hover:text-accent-foreground',
              props.selected === e.path && 'bg-accent text-accent-foreground',
            ),
          },
          createElement('span', { className: cx('truncate font-mono', statusClass(e.status)) }, e.path),
          e.status === 'clean'
            ? null
            : createElement(Badge, { className: statusClass(e.status) }, statusLabel(e.status)),
        ),
      ),
    ),
  )
}
