import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { resolveWithin } from '../domain/path-guard'
import { GitOpError, type SparsePath } from '../types'

/**
 * 受 PathGuard 约束的文件访问。
 *
 * PathGuard 是纯函数、无法解析符号链接；本类在真正访问前额外用 realpath
 * 复核，堵住"经符号链接逃逸 worktree"这条路。
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
      // 父目录尚不存在，稍后 mkdir 创建；路径本身已由 PathGuard 校验
      return abs
    }
    const rootReal = await realpath(this.dir)
    const rel2 = relative(rootReal, real)
    if (rel2.startsWith('..') || resolve(rootReal, rel2) !== real) {
      throw new GitOpError('PATH_TRAVERSAL', `路径经符号链接逃出 worktree: ${rel}`)
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

  /** 二进制安全的写入 —— 解冲突时按 blob 原样落盘。 */
  async writeBuffer(rel: string, content: Buffer): Promise<void> {
    const abs = await this.#safeAbs(rel, false)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content)
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await lstat(await this.#safeAbs(rel, true))
      return true
    } catch {
      return false
    }
  }

  /** 递归列出相对路径；跳过 .git、符号链接与 sparse 范围外的内容。 */
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
