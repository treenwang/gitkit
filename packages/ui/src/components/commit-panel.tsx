import { createElement, useState } from 'react'
import type { ClientPushResult, MergeMode } from '@aaxis/gitkit-client'
import { useChanges, useCommit, usePush, useSessionStatus } from '../hooks/queries'
import { Button, cx, Muted, Panel } from './primitives'

export type CommitPanelProps = {
  /** PR 的目标分支。省略则只推分支、不建 PR。 */
  base?: string
  defaultTitle?: string
  className?: string
  onResult?: (r: ClientPushResult) => void
}

/**
 * commit message → push → 建 PR → 选合并模式 → 展示结果。
 *
 * 默认发送 merge: 'auto'，由核心包按 sparsePaths 的 requireChecks 推导；
 * 「立即合并」是给宿主在明确只改了免检内容时用的显式逃生口 ——
 * 判断"改了什么"的知识在宿主业务层，不放进包内。
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
          `有 ${conflicted} 个文件处于冲突中，需要先解决才能提交。`)
      : null,

    createElement('textarea', {
      value: message,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setMessage(e.target.value),
      placeholder: '这次改动做了什么？',
      rows: 3,
      'aria-label': '提交信息',
      className:
        'w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm ' +
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ' +
        'focus-visible:ring-ring',
    }),

    props.base
      ? createElement('input', {
          value: title,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setTitle(e.target.value),
          placeholder: `PR 标题（合并到 ${props.base}）`,
          'aria-label': 'PR 标题',
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
            'aria-label': '立即合并',
          }),
          '立即合并（跳过 CI 检查）',
        )
      : null,

    createElement(
      'div',
      { className: 'flex items-center justify-between' },
      createElement(Muted, null,
        changeCount === 0 ? '没有待提交的改动' : `${changeCount} 个文件待提交`),
      createElement(Button, {
        disabled: !canSubmit,
        onClick: () => { void submit() },
        children: busy ? '处理中…' : props.base ? '提交并创建 PR' : '提交并推送',
      }),
    ),

    result ? createElement(ResultNotice, { result }) : null,
    commit.error || push.error
      ? createElement(Muted, { className: 'text-destructive' },
          `失败：${((commit.error ?? push.error) as Error).message}`)
      : null,
  )
}

function ResultNotice({ result }: { result: ClientPushResult }): React.ReactElement {
  if (!result.ok) {
    if (result.reason === 'conflict') {
      return createElement(Muted, { className: 'text-destructive' },
        `远端有新的改动且与你的改动冲突，涉及 ${result.conflicts.length} 个文件，需要先解决。`)
    }
    return createElement(Muted, { className: 'text-destructive' },
      `推送失败（${result.reason}）：${result.detail}`)
  }

  const pr = result.pr
  if (!pr) return createElement(Muted, null, '已推送。')

  const am = result.autoMerge
  const tail = !am
    ? '未请求合并。'
    : am.ok
      ? am.merged ? '已合并。' : '已设置为通过检查后自动合并。'
      : `已创建 PR，但合并未生效（${am.reason}）。`

  return createElement(
    'div',
    { className: 'space-y-1' },
    createElement(Muted, null, `PR #${pr.number} 已创建。${tail}`),
    createElement('a', {
      href: pr.url, target: '_blank', rel: 'noreferrer',
      className: 'text-sm underline underline-offset-2',
    }, '在 GitHub 中打开'),
  )
}
