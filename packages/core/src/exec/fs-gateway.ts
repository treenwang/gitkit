import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { resolveWithin } from '../domain/path-guard'
import { GitOpError, type SparsePath } from '../types'

/**
 * File access constrained by PathGuard.
 *
 * PathGuard is a pure function and cannot resolve symlinks, so this class
 * re-checks with realpath immediately before touching anything, closing the
 * "escape the worktree through a symlink" route.
 */
export class FsGateway {
  constructor(
    private readonly dir: string,
    private readonly sparse: readonly SparsePath[],
  ) {}

  async #safeAbs(rel: string, mustExist: boolean): Promise<string> {
    const abs = resolveWithin(this.dir, rel, this.sparse)
    const probe = mustExist ? abs : dirname(abs)
    let real: string
    try {
      real = await realpath(probe)
    } catch (e) {
      if (mustExist) throw e
      // Parent directory does not exist yet; mkdir creates it later. The path itself is already validated by PathGuard.
      return abs
    }
    const rootReal = await realpath(this.dir)
    const rel2 = relative(rootReal, real)
    if (rel2.startsWith('..') || resolve(rootReal, rel2) !== real) {
      throw new GitOpError('PATH_TRAVERSAL', `path escapes the worktree through a symlink: ${rel}`)
    }
    return abs
  }

  async readFile(rel: string): Promise<string> {
    return readFile(await this.#safeAbs(rel, true), 'utf8')
  }

  async readBuffer(rel: string): Promise<Buffer> {
    return readFile(await this.#safeAbs(rel, true))
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const abs = await this.#safeAbs(rel, false)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }

  /** Binary-safe write - conflict resolution writes blobs back verbatim. */
  async writeBuffer(rel: string, content: Buffer): Promise<void> {
    const abs = await this.#safeAbs(rel, false)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }

  async deleteFile(rel: string): Promise<void> {
    await rm(await this.#safeAbs(rel, true))
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await lstat(await this.#safeAbs(rel, true))
      return true
    } catch {
      return false
    }
  }

  /** Recursively list relative paths, skipping .git, symlinks, and anything outside the sparse range. */
  async listFiles(rel?: string): Promise<string[]> {
    const roots = rel
      ? [rel]
      : this.sparse.length > 0
        ? this.sparse.map((s) => s.path)
        : ['.']
    const out: string[] = []
    for (const r of roots) {
      const base = r === '.' ? this.dir : await this.#safeAbs(r, true).catch(() => '')
      if (!base) continue
      await this.#walk(base, r === '.' ? '' : r, out)
    }
    return [...new Set(out)].sort()
  }

  async #walk(absDir: string, relDir: string, out: string[]): Promise<void> {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === '.git') continue
      if (e.isSymbolicLink()) continue
      const childRel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) await this.#walk(`${absDir}${sep}${e.name}`, childRel, out)
      else out.push(childRel)
    }
  }
}
