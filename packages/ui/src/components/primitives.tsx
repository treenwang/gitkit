import { createElement, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { useGitkit } from '../context'

/** 合并 class，末位优先；不引 clsx/tailwind-merge，避免为几行逻辑增加依赖。 */
export function cx(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(' ')
}

/**
 * 优先使用宿主注入的组件；未注入则退化为带正确语义 token 类名的原生元素。
 * 只用 shadcn 的稳定 token，使组件自动跟随宿主主题。
 */
export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'ghost' },
): React.ReactElement {
  const { components } = useGitkit()
  const { variant = 'default', className, ...rest } = props
  if (components.Button) return createElement(components.Button, { className, ...rest })

  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium ' +
    'transition-colors disabled:pointer-events-none disabled:opacity-50 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  const look =
    variant === 'ghost'
      ? 'hover:bg-accent hover:text-accent-foreground'
      : 'bg-primary text-primary-foreground hover:bg-primary/90'
  return createElement('button', { type: 'button', className: cx(base, look, className), ...rest })
}

export function Badge(props: { children?: ReactNode; className?: string }): React.ReactElement {
  const { components } = useGitkit()
  if (components.Badge) return createElement(components.Badge, props)
  return createElement('span', {
    className: cx(
      'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium',
      'border-border bg-muted/40 text-muted-foreground',
      props.className,
    ),
  }, props.children)
}

export function Panel(props: { children?: ReactNode; className?: string }): React.ReactElement {
  return createElement('div', {
    className: cx('rounded-md border border-border bg-background text-foreground', props.className),
  }, props.children)
}

export function Muted(props: { children?: ReactNode; className?: string }): React.ReactElement {
  return createElement('p', {
    className: cx('text-sm text-muted-foreground', props.className),
  }, props.children)
}

const STATUS_LABEL: Record<string, string> = {
  modified: '已修改', added: '新增', deleted: '已删除', conflicted: '冲突', clean: '',
}

const STATUS_CLASS: Record<string, string> = {
  modified: 'text-amber-600 dark:text-amber-500',
  added: 'text-emerald-600 dark:text-emerald-500',
  deleted: 'text-muted-foreground line-through',
  conflicted: 'text-destructive',
  clean: '',
}

export function statusLabel(status: string): string { return STATUS_LABEL[status] ?? status }
export function statusClass(status: string): string { return STATUS_CLASS[status] ?? '' }
