import { createContext, createElement, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { GitkitClient } from '@treenwang/gitkit-client'

/**
 * Injectable component slots. Passing the host's own shadcn components takes
 * over appearance and behaviour completely; leaving them out falls back to
 * plain elements carrying the right semantic token classes.
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
  if (!v) throw new Error('missing <GitkitProvider>: mount it above any component using gitkit hooks')
  return v
}

export type GitkitProviderProps = {
  client: GitkitClient
  /** The session to bind to; omitted, the client's own is used. */
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
 * This package ships no CSS and uses shadcn's semantic token classes only. If
 * a consumer forgets to let Tailwind scan the package's build output, the
 * components render **completely unstyled with no error at all** - by far the
 * easiest trap in this approach, hence the explicit warning.
 */
function useThemeTokenWarning(): void {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return
    const v = getComputedStyle(document.documentElement).getPropertyValue('--background')
    if (v.trim()) return
    console.warn(
      '[gitkit-ui] shadcn CSS variables (--background) were not detected. The ' +
        'components will have no styling.\n' +
        'Make sure a shadcn theme is loaded and that Tailwind v4 scans this ' +
        "package's build output:\n" +
        '  @source "../node_modules/@treenwang/gitkit-ui/dist";',
    )
  }, [])
}
