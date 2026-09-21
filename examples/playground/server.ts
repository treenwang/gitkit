/**
 * Minimal host for trying the whole chain locally.
 *
 *   browser -> @treenwang/gitkit-client -> this Express process
 *     -> @treenwang/gitkit-server -> @treenwang/gitkit -> real git -> your repository
 *
 * This is a demo: sessions live in memory and every request is let through.
 * In a real host, resolveSession is the authorization boundary — it must decide
 * which user's session a request belongs to.
 */
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { RepoManager, GitOpError, type GitRepo, type RepoStore } from '@treenwang/gitkit'
import { createHandler, toExpress } from '@treenwang/gitkit-server'

const here = dirname(fileURLToPath(import.meta.url))

// Load .env if present
for (const envPath of [join(here, '.env'), join(here, '../../.env')]) {
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Za-z_0-9]+)\s*=\s*(.*)?\s*$/)
      if (match) {
        const key = match[1]!
        let val = (match[2] ?? '').trim().replace(/\\$/, '').trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        if (!process.env[key]) {
          process.env[key] = val
        }
      }
    }
  }
}

// ---------------------------------------------------------------- config

const REPO_URL = process.env.GITKIT_REPO_URL
const TOKEN = process.env.GITKIT_TOKEN
const ROOT = process.env.GITKIT_ROOT ?? join(here, '.data')
const PORT = Number(process.env.PORT ?? 5177)

// Auto kill old process on PORT if occupied
try {
  const pids = execSync(`lsof -ti :${PORT}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  for (const pid of pids) {
    if (Number(pid) !== process.pid) {
      process.kill(Number(pid), 'SIGKILL')
    }
  }
} catch {}
// Check out only these directories if specified. If unset or empty, checks out the whole repository.
const SPARSE_PATHS = process.env.GITKIT_PATHS
  ? process.env.GITKIT_PATHS.split(',').map((s) => s.trim()).filter(Boolean)
  : []
const BASE = process.env.GITKIT_BASE ?? 'main'
const AUTHOR = {
  name: process.env.GITKIT_AUTHOR_NAME ?? 'gitkit playground',
  email: process.env.GITKIT_AUTHOR_EMAIL ?? 'playground@example.invalid',
}

// Pull request support is only enabled when the URL really points at GitHub.
// Against a local bare repository (file://) this degrades to plain git, which
// lets you exercise rejected pushes and conflicts without touching the network.
const IS_GITHUB = !!REPO_URL && /^https?:\/\//.test(REPO_URL) && /github/i.test(REPO_URL)

if (!REPO_URL || (IS_GITHUB && !TOKEN)) {
  console.error(`
Missing configuration. At minimum a repository URL and a token:

  export GITKIT_REPO_URL=https://github.com/<you>/<repo>
  export GITKIT_TOKEN=<your GitHub PAT>
  npm run playground

Optional:
  GITKIT_PATHS=docs,src   check out only these directories (default: docs)
  GITKIT_BASE=main        branch to start from (default: main)
  GITKIT_ROOT=/tmp/xxx    where workspaces live (default: ./.data)
  PORT=5177

GITKIT_REPO_URL may also be a local bare repository (file:///...), which needs
no token and no network — you just do not get pull requests.
`)
  process.exit(1)
}

console.log(
  IS_GITHUB
    ? `\nThis demo really creates branches, pushes, and opens pull requests on ${REPO_URL}.
Use a scratch repository. Workspaces: ${ROOT}\n`
    : `\nLocal repository mode: ${REPO_URL} (offline, no pull requests). Workspaces: ${ROOT}\n`,
)

// ---------------------------------------------------------------- gitkit

const manager = new RepoManager({
  root: ROOT,
  ...(TOKEN ? { auth: { token: TOKEN } } : {}),
  onProgress: (e) => process.stdout.write(`\r  [${e.phase}] ${e.message.slice(0, 80).padEnd(80)}`),
})

let storePromise: Promise<RepoStore> | undefined
const store = () =>
  (storePromise ??= manager.store({
    url: REPO_URL,
    ...(IS_GITHUB ? { github: {} } : {}),   // enables PRs; reuses the manager's token
  }))

/** In-memory session table, for the demo. A real host would key this by user. */
const sessions = new Map<string, GitRepo>()

// ---------------------------------------------------------------- HTTP

const app = express()
app.use(express.json({ limit: '4mb' }))

/** Open a session: create or reuse a branch, checking out only SPARSE_PATHS. */
app.post('/demo/session', async (req, res) => {
  try {
    const branch = String(req.body?.branch || '').trim() || `gitkit-playground/${Date.now()}`
    const s = await store()
    const repo = await s.createSession({
      branch,
      branchMode: 'createOrReuse',
      base: BASE,
      sparsePaths: SPARSE_PATHS.map((path) => ({ path })),
      author: AUTHOR,
    })
    const id = randomUUID()
    sessions.set(id, repo)
    console.log(`\nsession ${id.slice(0, 8)} -> branch ${branch}`)
    res.json({ sessionId: id, branch, sparsePaths: SPARSE_PATHS, base: BASE, github: IS_GITHUB })
  } catch (e) {
    res.status(500).json(describe(e))
  }
})

/** Close a session and release its worktree. */
app.post('/demo/session/:id/close', async (req, res) => {
  const repo = sessions.get(req.params.id)
  if (!repo) {
    res.status(404).json({ message: 'no such session' })
    return
  }
  try {
    await repo.dispose()
    sessions.delete(req.params.id)
    res.json({ closed: true })
  } catch (e) {
    res.status(500).json(describe(e))
  }
})

// gitkit's own protocol endpoints. resolveSession is the authorization
// boundary; this demo lets everything through.
const handler = createHandler({
  resolveSession: (_req, sessionId) => sessions.get(sessionId) ?? null,
  exposeDetail: true,   // handy locally; never enable in production
})
app.use('/api/gitkit', toExpress(handler))

// The browser imports this file directly. The client has zero runtime
// dependencies, so no bundler is involved.
app.get('/vendor/gitkit-client.js', (_req, res) => {
  res.type('application/javascript')
  res.sendFile(join(here, '..', '..', 'packages', 'client', 'dist', 'index.js'))
})
app.use(express.static(join(here, 'public')))

function describe(e: unknown) {
  if (e instanceof GitOpError) return { code: e.code, message: e.message, detail: e.detail }
  return { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) }
}

const server = createServer(app)

function listen(port: number) {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is in use, trying ${port + 1}...`)
      listen(port + 1)
    } else {
      throw err
    }
  })
  server.listen(port, () => console.log(`gitkit playground -> http://localhost:${port}\n`))
}

listen(PORT)

// Hand the worktrees back on Ctrl-C instead of leaving them behind.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log('\nReleasing worktrees...')
    await Promise.allSettled([...sessions.values()].map((r) => r.dispose()))
    server.close(() => process.exit(0))
  })
}
