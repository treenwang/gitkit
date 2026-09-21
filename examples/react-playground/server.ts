/**
 * Minimal host for trying @treenwang/gitkit-ui end to end.
 *
 *   browser (React + @treenwang/gitkit-ui)
 *     -> @treenwang/gitkit-client
 *       -> this Express process
 *         -> @treenwang/gitkit-server
 *           -> @treenwang/gitkit
 *             -> real git
 *               -> your repository
 *
 * Vite runs in middleware mode inside this same process, so one command gives
 * you both the API and hot module reloading.
 *
 * This is a demo: sessions live in memory and every request is let through.
 * In a real host, resolveSession is the authorization boundary — it must decide
 * which user's session a request belongs to.
 */
import { createServer as createHttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { createServer as createViteServer } from 'vite'
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
let PORT = Number(process.env.PORT ?? 5178)

// Auto kill old process on PORT if occupied
function killPort(port: number) {
  try {
    const pids = execSync(`lsof -ti :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] })
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    for (const pid of pids) {
      if (Number(pid) !== process.pid) {
        process.kill(Number(pid), 'SIGKILL')
      }
    }
  } catch {}
}

killPort(PORT)
killPort(24678)
await new Promise((r) => setTimeout(r, 150))
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
  npm run playground:react

Optional:
  GITKIT_PATHS=docs,src   check out only these directories (default: docs)
  GITKIT_BASE=main        branch to start from (default: main)
  GITKIT_ROOT=/tmp/xxx    where workspaces live (default: ./.data)
  PORT=5178

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
})

/** Multi-repository stores cache, keyed by repo URL */
const stores = new Map<string, Promise<RepoStore>>()
const getStore = (repoUrl: string) => {
  let s = stores.get(repoUrl)
  if (!s) {
    const isGithub = /^https?:\/\//.test(repoUrl) && /github/i.test(repoUrl)
    s = manager.store({
      url: repoUrl,
      ...(isGithub ? { github: {} } : {}),
    })
    stores.set(repoUrl, s)
  }
  return s
}

/** In-memory session table, for the demo. A real host would key this by user. */
const sessions = new Map<string, GitRepo>()

// ---------------------------------------------------------------- HTTP

const app = express()
app.use(express.json({ limit: '4mb' }))

/** Return server default configuration for initial UI setup */
app.get('/demo/config', (_req, res) => {
  res.json({
    defaultRepoUrl: REPO_URL || '',
    defaultBase: BASE,
    defaultSparsePaths: SPARSE_PATHS,
    hasToken: !!TOKEN,
  })
})

/** Open a session: create or reuse a branch on a chosen repository. */
app.post('/demo/session', async (req, res) => {
  try {
    const targetUrl = String(req.body?.repoUrl || REPO_URL || '').trim()
    if (!targetUrl) {
      res.status(400).json({ code: 'INVALID_ARGUMENT', message: 'Repository URL is required' })
      return
    }

    const isGithub = /^https?:\/\//.test(targetUrl) && /github/i.test(targetUrl)
    if (isGithub && !TOKEN) {
      res.status(400).json({
        code: 'MISSING_TOKEN',
        message: 'GitHub repository requires GITKIT_TOKEN configured in server .env',
      })
      return
    }

    const branch = String(req.body?.branch || '').trim() || `gitkit-playground/${Date.now()}`
    const base = String(req.body?.base || BASE).trim() || 'main'

    let sparsePaths = SPARSE_PATHS
    if (req.body?.sparsePaths !== undefined) {
      const raw = req.body.sparsePaths
      sparsePaths = Array.isArray(raw)
        ? raw.map((s: unknown) => String(s).trim()).filter(Boolean)
        : String(raw).split(',').map((s) => s.trim()).filter(Boolean)
    }

    const s = await getStore(targetUrl)
    const repo = await s.createSession({
      branch,
      branchMode: 'createOrReuse',
      base,
      sparsePaths: sparsePaths.map((path) => ({ path })),
      author: AUTHOR,
    })
    const id = randomUUID()
    sessions.set(id, repo)
    console.log(`session ${id.slice(0, 8)} [${targetUrl}] -> branch ${branch}`)
    res.json({
      sessionId: id,
      repoUrl: targetUrl,
      branch,
      sparsePaths,
      base,
      github: isGithub,
    })
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

function describe(e: unknown) {
  if (e instanceof GitOpError) return { code: e.code, message: e.message, detail: e.detail }
  return { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) }
}

const server = createHttpServer(app)

// Vite last, so it only sees requests the API did not claim.
const vite = await createViteServer({
  configFile: join(here, 'vite.config.ts'),
  server: { middlewareMode: true, hmr: { server } },
  appType: 'spa',
})
app.use(vite.middlewares)

function listen(port: number) {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} is in use, trying ${port + 1}...`)
      listen(port + 1)
    } else {
      throw err
    }
  })
  server.listen(port, () => console.log(`gitkit react playground -> http://localhost:${port}\n`))
}

listen(PORT)

// Hand the worktrees back on Ctrl-C instead of leaving them behind.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log('\nReleasing worktrees...')
    await Promise.allSettled([...sessions.values()].map((r) => r.dispose()))
    await vite.close()
    server.close(() => process.exit(0))
  })
}
