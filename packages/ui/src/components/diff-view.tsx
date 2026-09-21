import { createElement, Fragment } from 'react'
import { useDiff } from '../hooks/queries'
import { cx, Muted, Panel } from './primitives'

export type DiffViewProps = {
  path?: string
  against?: string
  /** Swap in any implementation - Monaco, react-diff-viewer, anything. Omitted, the built-in lightweight rendering is used. */
  renderDiff?: (patch: string) => React.ReactNode
  className?: string
}

/** The built-in zero-dependency unified diff rendering. git already emits unified format; this only colours it. */
export function renderUnifiedPatch(patch: string): React.ReactNode {
  const lines = patch.split('\n')
  return createElement(
    'pre',
    { className: 'overflow-x-auto rounded bg-muted/20 p-2 font-mono text-xs leading-relaxed' },
    ...lines.map((line, i) => {
      const kind =
        line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ||
        line.startsWith('index ')
          ? 'meta'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('+')
              ? 'add'
              : line.startsWith('-')
                ? 'del'
                : 'ctx'
      const cls = {
        meta: 'text-muted-foreground',
        hunk: 'text-sky-600 dark:text-sky-400',
        add: 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10',
        del: 'text-red-700 dark:text-red-400 bg-red-500/10',
        ctx: '',
      }[kind]
      return createElement('div', { key: i, className: cx('whitespace-pre', cls), 'data-kind': kind }, line || ' ')
    }),
  )
}

export function DiffView(props: DiffViewProps): React.ReactElement {
  const query = useDiff({
    ...(props.path ? { path: props.path } : {}),
    ...(props.against ? { against: props.against } : {}),
  })

  if (query.isLoading) return createElement(Muted, null, 'Loading changes...')
  if (query.error) {
    return createElement(Muted, { className: 'text-destructive' },
      `Could not read the changes: ${(query.error as Error).message}`)
  }
  const patch = query.data?.patch ?? ''
  if (!patch) return createElement(Muted, null, 'No changes')

  const body = props.renderDiff ? props.renderDiff(patch) : renderUnifiedPatch(patch)
  return createElement(
    Panel,
    { className: cx('p-1', props.className) },
    createElement(Fragment, null,
      query.data?.truncated
        ? createElement(Muted, { className: 'px-1 pb-1' }, 'The diff is too large; only the beginning is shown')
        : null,
      body,
    ),
  )
}
