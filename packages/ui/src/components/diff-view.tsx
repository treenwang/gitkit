import { createElement, Fragment } from 'react'
import { useDiff } from '../hooks/queries'
import { cx, Muted, Panel } from './primitives'

export type DiffViewProps = {
  path?: string
  against?: string
  /** 换成任意实现（Monaco、react-diff-viewer 等）。不传则用内置的轻量渲染。 */
  renderDiff?: (patch: string) => React.ReactNode
  className?: string
}

/** 内置的零依赖统一 diff 渲染。git 已输出统一格式，这里只做着色。 */
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

  if (query.isLoading) return createElement(Muted, null, '正在读取改动…')
  if (query.error) {
    return createElement(Muted, { className: 'text-destructive' },
      `无法读取改动：${(query.error as Error).message}`)
  }
  const patch = query.data?.patch ?? ''
  if (!patch) return createElement(Muted, null, '没有改动')

  const body = props.renderDiff ? props.renderDiff(patch) : renderUnifiedPatch(patch)
  return createElement(
    Panel,
    { className: cx('p-1', props.className) },
    createElement(Fragment, null,
      query.data?.truncated
        ? createElement(Muted, { className: 'px-1 pb-1' }, '差异过大，仅显示开头部分')
        : null,
      body,
    ),
  )
}
