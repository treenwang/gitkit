import { useState } from 'react'
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
  branch: string
  sparsePaths: string[]
  base: string
  github: boolean
}

export function App() {
  const [session, setSession] = useState<Session | null>(null)

  if (!session) return <OpenSession onOpen={setSession} />
  return <Workspace session={session} onClose={() => setSession(null)} />
}

// ---------------------------------------------------------------- session

function OpenSession({ onOpen }: { onOpen: (s: Session) => void }) {
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function open() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/demo/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`${data.code ?? ''} ${data.message ?? ''}`.trim())
      onOpen(data as Session)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">gitkit React playground</h1>
        <p className="text-sm text-muted-foreground">
          Every panel below is a component from{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">@treenwang/gitkit-ui</code>.
        </p>
      </div>
      <input
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        placeholder="Branch name (blank to generate one)"
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
      <button
        onClick={open}
        disabled={busy}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? 'Opening...' : 'Open session'}
      </button>
      {error && <p className="text-sm text-destructive">{error}</p>}
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

  async function close() {
    await fetch(`/demo/session/${session.sessionId}/close`, { method: 'POST' })
    queryClient.clear()
    onClose()
  }

  return (
    // Everything inside gets the client and the session through context.
    // components={{ Button, Badge }} would hand the components your own
    // shadcn primitives; leaving it out falls back to plain elements that
    // still carry the right token classes.
    <GitkitProvider client={client}>
      <div className="flex min-h-dvh flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <h1 className="text-sm font-semibold">gitkit React playground</h1>
          <span className="text-xs text-muted-foreground">
            {session.branch} · checked out {session.sparsePaths.join(', ')} · base {session.base}
            {session.github ? '' : ' · local repo, no pull requests'}
          </span>
          <button
            onClick={close}
            className="ml-auto rounded-md border border-border px-2 py-1 text-xs"
          >
            Close session
          </button>
        </header>

        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[260px_1fr_340px]">
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

          <section className="space-y-4">
            <Section title="FileEditor">
              {path ? (
                // The package deliberately ships no editor: it owns the save
                // lifecycle (debounce, etag optimistic locking, keepalive on
                // page hide) and hands you the content to render however you like.
                <FileEditor path={path}>
                  {({ content, onChange, saveState, binary }) =>
                    binary ? (
                      <p className="text-sm text-muted-foreground">Binary file — not editable as text.</p>
                    ) : (
                      <textarea
                        value={content}
                        onChange={(e) => onChange(e.target.value)}
                        spellCheck={false}
                        className="h-[26rem] w-full rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed"
                        aria-label={`${path} (${saveState})`}
                      />
                    )
                  }
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border p-3">
      <h2 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}
