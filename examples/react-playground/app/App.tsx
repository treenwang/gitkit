import { useState, useEffect, Component, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { GitkitClient, type ClientPushResult } from '@treenwang/gitkit-client'
import {
  GitkitProvider,
  FileTree,
  FileEditor,
  ChangeList,
  DiffView,
  CommitPanel,
  SyncStatus,
} from '@treenwang/gitkit-ui/components'

type Session = {
  sessionId: string
  repoUrl?: string
  branch: string
  sparsePaths?: string[]
  base?: string
  github?: boolean
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <main className="mx-auto my-12 max-w-lg rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-sm">
          <h2 className="text-base font-semibold text-destructive">Application Error</h2>
          <p className="mt-2 font-mono text-xs text-muted-foreground">{this.state.error.message}</p>
          <button
            onClick={() => {
              localStorage.clear()
              window.location.reload()
            }}
            className="mt-4 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground"
          >
            Reset Session & Reload
          </button>
        </main>
      )
    }
    return this.props.children
  }
}

export function App() {
  const [session, setSession] = useState<Session | null>(null)

  return (
    <ErrorBoundary>
      {!session ? (
        <OpenSession onOpen={setSession} />
      ) : (
        <Workspace session={session} onClose={() => setSession(null)} />
      )}
    </ErrorBoundary>
  )
}

// ---------------------------------------------------------------- session

const STORAGE_KEY = 'gitkit_playground_recent_repos'

function OpenSession({ onOpen }: { onOpen: (s: Session) => void }) {
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('main')
  const [sparsePaths, setSparsePaths] = useState('')
  const [recentRepos, setRecentRepos] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
      if (Array.isArray(saved) && saved.length > 0) {
        setRecentRepos(saved)
        setRepoUrl(saved[0])
      }
    } catch {}

    fetch('/demo/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg.defaultRepoUrl) {
          setRepoUrl((curr) => curr || cfg.defaultRepoUrl)
        }
        if (cfg.defaultBase) {
          setBase(cfg.defaultBase)
        }
        if (cfg.defaultSparsePaths?.length) {
          setSparsePaths((curr) => curr || cfg.defaultSparsePaths.join(','))
        }
      })
      .catch(() => {})
  }, [])

  async function open() {
    if (!repoUrl.trim()) {
      setError('Please provide a repository URL')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/demo/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoUrl: repoUrl.trim(),
          branch: branch.trim(),
          base: base.trim() || 'main',
          sparsePaths: sparsePaths.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`${data.code ?? ''} ${data.message ?? ''}`.trim())

      // Save to recent repos list
      try {
        const next = [repoUrl.trim(), ...recentRepos.filter((r) => r !== repoUrl.trim())].slice(0, 5)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {}

      onOpen(data as Session)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-5 p-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-bold">gitkit React playground</h1>
          <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">Multi-Repo</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Operate on any Git repository programmatically using components from{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">@treenwang/gitkit-ui</code>.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Target Repository URL
          </label>
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo or file:///tmp/..."
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:border-primary focus:outline-none"
          />
          {recentRepos.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
              <span className="text-muted-foreground">Recent:</span>
              {recentRepos.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRepoUrl(r)}
                  className="rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {r.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Branch Name
            </label>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Blank to auto-generate"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Base Branch
            </label>
            <input
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="main"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sparse Paths (Optional)
          </label>
          <input
            value={sparsePaths}
            onChange={(e) => setSparsePaths(e.target.value)}
            placeholder="Blank for entire repository, or e.g. docs,packages"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:border-primary focus:outline-none"
          />
          <p className="text-[11px] text-muted-foreground">
            Leave blank to check out the entire root directory.
          </p>
        </div>

        <button
          onClick={open}
          disabled={busy}
          className="w-full rounded-md bg-primary py-2.5 text-sm font-medium text-primary-foreground shadow transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Cloning & Opening Session...' : 'Open Session'}
        </button>

        {error && (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
            {error}
          </div>
        )}
      </div>
    </main>
  )
}

// ---------------------------------------------------------------- workspace

function Workspace({ session, onClose }: { session: Session; onClose: () => void }) {
  const [client] = useState(
    () => new GitkitClient({ baseUrl: '/api/gitkit', sessionId: session.sessionId }),
  )
  const [path, setPath] = useState<string | undefined>()
  const [pushResult, setPushResult] = useState<ClientPushResult | null>(null)
  const queryClient = useQueryClient()

  const [autoSave, setAutoSave] = useState(true)

  async function close() {
    await fetch(`/demo/session/${session.sessionId}/close`, { method: 'POST' })
    queryClient.clear()
    onClose()
  }

  const displayRepo = (session.repoUrl || '').replace(/^https?:\/\/(www\.)?github\.com\//, '') || session.branch || 'Repository'
  const pathsText = (session.sparsePaths && session.sparsePaths.length > 0)
    ? `paths: ${session.sparsePaths.join(', ')}`
    : 'all files (root)'

  return (
    // Everything inside gets the client and the session through context.
    <GitkitProvider client={client}>
      <div className="flex min-h-dvh flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs font-semibold text-foreground">
              {displayRepo}
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            branch <code className="font-semibold text-foreground">{session.branch}</code> ·{' '}
            {pathsText} · base {session.base || 'main'}
            {session.github ? '' : ' · (local repo)'}
          </span>
          <button
            onClick={close}
            className="ml-auto rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted"
          >
            ← Switch Repo / Close
          </button>
        </header>

        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[260px_minmax(0,1fr)_340px]">
          <aside className="space-y-4">
            <Section title="SyncStatus">
              {/* Shows branch state, pulls, and offers abort while a merge is in progress. */}
              <SyncStatus />
            </Section>
            <Section title="FileTree">
              <FileTree selected={path} onSelect={setPath} />
            </Section>
            <Section title="ChangeList">
              <ChangeList selected={path} onSelect={setPath} />
            </Section>
          </aside>

          <section className="min-w-0 space-y-4">
            <Section title="FileEditor">
              {path ? (
                // The package deliberately ships no editor: it owns the save
                // lifecycle (debounce, etag optimistic locking, keepalive on
                // page hide) and hands you the content to render however you like.
                <FileEditor path={path} autoSave={autoSave}>
                  {({ content, onChange, saveState, binary, save }) => (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3 border-b border-border pb-2 text-xs">
                        <div className="flex items-center gap-2">
                          <label className="flex cursor-pointer select-none items-center gap-1.5 text-muted-foreground hover:text-foreground">
                            <input
                              type="checkbox"
                              checked={autoSave}
                              onChange={(e) => setAutoSave(e.target.checked)}
                              className="rounded border-border accent-primary"
                            />
                            <span>Auto-save</span>
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void save()}
                            disabled={binary || saveState === 'saving' || saveState === 'clean'}
                            className="flex items-center gap-1 rounded border border-border bg-primary/10 px-2.5 py-1 font-medium text-primary hover:bg-primary/20 disabled:opacity-40"
                          >
                            <span>{saveState === 'saving' ? 'Saving...' : saveState === 'dirty' ? 'Save *' : 'Save'}</span>
                            <kbd className="text-[10px] opacity-70">⌘S</kbd>
                          </button>
                        </div>
                      </div>

                      {binary ? (
                        <p className="text-sm text-muted-foreground">Binary file — not editable as text.</p>
                      ) : (
                        <textarea
                          value={content}
                          onChange={(e) => onChange(e.target.value)}
                          onKeyDown={(e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                              e.preventDefault()
                              void save()
                            }
                          }}
                          spellCheck={false}
                          className="h-[26rem] w-full rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary"
                          aria-label={`${path} (${saveState})`}
                        />
                      )}
                    </div>
                  )}
                </FileEditor>
              ) : (
                <p className="text-sm text-muted-foreground">Pick a file on the left.</p>
              )}
            </Section>

            <Section title="DiffView">
              {/* renderDiff={(patch) => <YourMonacoDiff patch={patch} />} swaps the renderer. */}
              <DiffView path={path} />
            </Section>
          </section>

          <aside className="space-y-4">
            <Section title="CommitPanel">
              {/* base enables the pull request form; drop it to push only. */}
              <CommitPanel
                base={session.github ? session.base : undefined}
                defaultTitle="docs: from the React playground"
                onResult={setPushResult}
              />
            </Section>

            <Section title="Push result">
              {pushResult ? (
                <pre className="overflow-x-auto rounded bg-muted/20 p-2 font-mono text-xs">
                  {JSON.stringify(pushResult, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A rejected push or a conflict comes back here as a value, not an exception.
                </p>
              )}
            </Section>
          </aside>
        </div>
      </div>
    </GitkitProvider>
  )
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 max-w-full overflow-hidden rounded-md border border-border p-3 ${className || ''}`}>
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}
