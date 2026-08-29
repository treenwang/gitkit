import { execFile } from 'node:child_process'
import { mapGitError } from '../domain/error-mapper'
import { GitOpError, type ProgressEvent } from '../types'
import { redact } from './sanitize'

export type ExecOptions = {
  cwd?: string
  token?: string
  timeout?: number
  phase?: ProgressEvent['phase']
  /** 允许非零退出码而不抛错（如 `git diff --quiet`）。 */
  allowExitCodes?: readonly number[]
}

export type ExecResult = { stdout: string; stderr: string; exitCode: number }
export type GitVersion = { major: number; minor: number; patch: number; raw: string }

const DEFAULT_TIMEOUT = 120_000

/**
 * 唯一 spawn git 的地方。其他任何文件出现 child_process 均为实现错误。
 *
 * 认证通过 `-c http.extraheader` 单次注入，绝不写入 URL —— 后者会落入
 * .git/config 与 reflog 造成泄露。
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

  /** 暴露仅为可测试性：构造实际传给 git 的完整参数列表。 */
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

  /** 返回 trim 后的 stdout；失败抛 GitOpError。 */
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

  /** 以 Buffer 返回 stdout —— 用于可能是二进制的 blob 内容。 */
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
      throw new GitOpError('UNKNOWN', `无法解析 git 版本: ${raw}`, { detail: raw })
    }
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), raw }
  }
}

function firstLine(s: string): string {
  return s.split('\n').find((l) => l.trim()) ?? ''
}
