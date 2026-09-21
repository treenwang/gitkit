import { execFile } from 'node:child_process'
import { mapGitError } from '../domain/error-mapper'
import { GitOpError, type ProgressEvent } from '../types'
import { redact } from './sanitize'

export type ExecOptions = {
  cwd?: string
  token?: string
  timeout?: number
  phase?: ProgressEvent['phase']
  /** Accept these non-zero exit codes without throwing (e.g. `git diff --quiet`). */
  allowExitCodes?: readonly number[]
}

export type ExecResult = { stdout: string; stderr: string; exitCode: number }
export type GitVersion = { major: number; minor: number; patch: number; raw: string }

const DEFAULT_TIMEOUT = 120_000

/**
 * The only place that spawns git. child_process appearing in any other file is
 * an implementation error.
 *
 * Credentials are injected per invocation through `-c http.extraheader` and
 * never written into the URL, which would leak them into .git/config and the
 * reflog.
 */
export class GitExecutor {
  readonly #gitPath: string
  readonly #timeout: number
  readonly #onProgress?: (e: ProgressEvent) => void

  constructor(opts: {
    gitPath?: string
    timeout?: number
    onProgress?: (e: ProgressEvent) => void
  } = {}) {
    this.#gitPath = opts.gitPath ?? 'git'
    this.#timeout = opts.timeout ?? DEFAULT_TIMEOUT
    this.#onProgress = opts.onProgress
  }

  /** Exposed only for testability: builds the full argument list handed to git. */
  buildArgs(args: readonly string[], opts: ExecOptions): string[] {
    const pre = [
      '-c', 'merge.conflictStyle=diff3',
      '-c', 'core.quotepath=false',
      '-c', 'advice.detachedHead=false',
    ]
    if (opts.token) {
      const basic = Buffer.from(`x-access-token:${opts.token}`).toString('base64')
      pre.push('-c', `http.extraheader=AUTHORIZATION: basic ${basic}`)
    }
    return [...pre, ...args]
  }

  /** Returns trimmed stdout; throws GitOpError on failure. */
  async run(args: readonly string[], opts: ExecOptions = {}): Promise<string> {
    return (await this.exec(args, opts)).stdout
  }

  async exec(args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const full = this.buildArgs(args, opts)
    const secrets = opts.token ? [opts.token] : []
    const printable = redact([this.#gitPath, ...full].join(' '), secrets)
    const allowed = new Set(opts.allowExitCodes ?? [])

    return new Promise<ExecResult>((resolve, reject) => {
      const child = execFile(
        this.#gitPath,
        full,
        {
          cwd: opts.cwd,
          timeout: opts.timeout ?? this.#timeout,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'utf8',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          const safeErr = redact(String(stderr ?? ''), secrets)
          const out = String(stdout ?? '').replace(/\n+$/, '')
          if (!error) {
            resolve({ stdout: out, stderr: safeErr, exitCode: 0 })
            return
          }

          const err = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown }
          const exitCode = typeof err.code === 'number' ? err.code : -1
          if (allowed.has(exitCode)) {
            resolve({ stdout: out, stderr: safeErr, exitCode })
            return
          }

          const code =
            err.code === 'ENOENT'
              ? 'GIT_NOT_FOUND'
              : err.killed
                ? 'TIMEOUT'
                : mapGitError(safeErr)

          reject(
            new GitOpError(code, redact(firstLine(safeErr) || error.message, secrets), {
              detail: safeErr,
              command: printable,
              cause: error,
            }),
          )
        },
      )

      if (this.#onProgress && child.stderr) {
        let buf = ''
        child.stderr.on('data', (chunk: Buffer | string) => {
          buf += String(chunk)
          const lines = buf.split(/\r?\n|\r/)
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const pct = /(\d{1,3})%/.exec(line)
            this.#onProgress!({
              phase: opts.phase ?? 'fetch',
              message: redact(line, secrets),
              percent: pct ? Number(pct[1]) : undefined,
            })
          }
        })
      }
    })
  }

  /** Returns stdout as a Buffer - for blob contents that may be binary. */
  async runBuffer(args: readonly string[], opts: ExecOptions = {}): Promise<Buffer> {
    const full = this.buildArgs(args, opts)
    const secrets = opts.token ? [opts.token] : []
    const printable = redact([this.#gitPath, ...full].join(' '), secrets)

    return new Promise<Buffer>((resolve, reject) => {
      execFile(
        this.#gitPath,
        full,
        {
          cwd: opts.cwd,
          timeout: opts.timeout ?? this.#timeout,
          maxBuffer: 64 * 1024 * 1024,
          encoding: 'buffer',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(Buffer.from(stdout))
            return
          }
          const safeErr = redact(Buffer.from(stderr ?? '').toString('utf8'), secrets)
          const err = error as NodeJS.ErrnoException & { killed?: boolean }
          const code =
            err.code === 'ENOENT'
              ? 'GIT_NOT_FOUND'
              : err.killed
                ? 'TIMEOUT'
                : mapGitError(safeErr)
          reject(
            new GitOpError(code, redact(firstLine(safeErr) || error.message, secrets), {
              detail: safeErr,
              command: printable,
              cause: error,
            }),
          )
        },
      )
    })
  }

  async version(): Promise<GitVersion> {
    const raw = await this.run(['--version'])
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw)
    if (!m) {
      throw new GitOpError('UNKNOWN', `cannot parse the git version: ${raw}`, { detail: raw })
    }
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), raw }
  }
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim()) ?? ''
}
