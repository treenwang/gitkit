import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { GitkitClient } from '@aaxis/gitkit-client'

/**
 * 可注入的组件槽。传入宿主自己的 shadcn 组件即可完全接管外观与行为；
 * 不传则退化为带正确语义 token 类名的原生元素。
 */
export type ComponentSlots = {
  Button?: React.ComponentType<React.ButtonHTMLAttributes<HTMLButtonElement>>
  Badge?: React.ComponentType<{ children?: ReactNode; className?: string }>
  ScrollArea?: React.ComponentType<{ children?: ReactNode; className?: string }>
}

export type GitkitContextValue = {
  client: GitkitClient
  components: ComponentSlots
}

const Ctx = createContext<GitkitContextValue | null>(null)

export function useGitkit(): GitkitContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('缺少 <GitkitProvider>：请在使用 gitkit hooks 的组件之上挂载它')
  return v
}

export type GitkitProviderProps = {
  client: GitkitClient
  /** 绑定的 session；省略则使用 client 自带的。 */
  sessionId?: string
  components?: ComponentSlots
  children?: ReactNode
}

export function GitkitProvider(props: GitkitProviderProps): React.ReactElement {
  const { client, sessionId, components, children } = props
  const value = useMemo<GitkitContextValue>(
    () => ({
      client: sessionId ? client.withSession(sessionId) : client,
      components: components ?? {},
    }),
    [client, sessionId, components],
  )
  useThemeTokenWarning()
  return createElement(Ctx.Provider, { value }, children)
}

/**
 * 本包不打包任何 CSS，只使用 shadcn 的语义 token 类名。若消费者忘记让 Tailwind 扫描
 * 本包产物，组件会**完全没有样式且不报任何错** —— 这是本方案最容易踩的坑，因此主动提示。
 */
function useThemeTokenWarning(): void {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return
    const v = getComputedStyle(document.documentElement).getPropertyValue('--background')
    if (v.trim()) return
    console.warn(
      '[gitkit-ui] 未检测到 shadcn 的 CSS 变量（--background）。组件将没有样式。\n' +
        '请确认已引入 shadcn 主题，并让 Tailwind v4 扫描本包产物：\n' +
        '  @source "../node_modules/@aaxis/gitkit-ui/dist";',
    )
  }, [])
}
