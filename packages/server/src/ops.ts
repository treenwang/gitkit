import { createHash } from 'node:crypto'
import type { GitRepo } from '@aaxis/gitkit'
import type {
  ChangeEntry, FileEntry, OpName, OpParams, OpResult, ReadResult, SessionStatus,
} from '@aaxis/gitkit-client'
import { TransportError } from './errors'

export type OpContext = {
  repo: GitRepo
  maxContentBytes: number
}

export function etagOf(content: string | Buffer): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? Buffer.from(content, 'utf8') : content)
    .digest('hex')
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new TransportError('INVALID_ARGUMENT', `参数 ${key} 必须是非空字符串`)
  }
  return v
}

/** 每个 op 的实现。参数校验在此完成 —— 到达核心包的都是已校验的输入。 */
export const OPS: {
  [K in OpName]: (ctx: OpContext, params: OpParams<K>) => Promise<OpResult<K>>
} = {
  async status(ctx): Promise<SessionStatus> {
    const st = await ctx.repo.status()
    return {
      branch: st.branch,
      operation: st.operation,
      clean: st.clean,
      staged: st.staged,
      modified: st.modified,
      untracked: st.untracked,
      conflicted: st.conflicted,
    }
  },

  async 'files.list'(ctx, params) {
    const [paths, st] = await Promise.all([
      ctx.repo.listFiles(params.dir),
      ctx.repo.status(),
    ])
    const modified = new Set([...st.modified, ...st.staged])
    const untracked = new Set(st.untracked)
    const conflicted = new Set(st.conflicted)

    const entries: FileEntry[] = paths.map((path) => ({
      path,
      type: 'file' as const,
      status: conflicted.has(path)
        ? ('conflicted' as const)
        : untracked.has(path)
          ? ('added' as const)
          : modified.has(path)
            ? ('modified' as const)
            : ('clean' as const),
    }))

    // 已删除的文件不在工作区里，listFiles 看不到，需要从 status 补回来
    for (const path of st.modified.concat(st.staged)) {
      if (!paths.includes(path) && !entries.some((e) => e.path === path)) {
        entries.push({ path, type: 'file', status: 'deleted' })
      }
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1))
    return { entries }
  },

  async 'files.read'(ctx, params): Promise<ReadResult> {
    const path = requireString(params as Record<string, unknown>, 'path')
    const buf = await ctx.repo.readBuffer(path)

    // NUL 字节探测：二进制内容按 UTF-8 解码会被破坏，不返回 content
    if (buf.subarray(0, Math.min(buf.length, 8000)).includes(0)) {
      return { binary: true, size: buf.length }
    }
    const truncated = buf.length > ctx.maxContentBytes
    const body = truncated ? buf.subarray(0, ctx.maxContentBytes) : buf
    return {
      binary: false,
      content: body.toString('utf8'),
      etag: etagOf(buf),
      size: buf.length,
      truncated,
    }
  },

  async 'files.write'(ctx, params) {
    const p = params as Record<string, unknown>
    const path = requireString(p, 'path')
    if (typeof p.content !== 'string') {
      throw new TransportError('INVALID_ARGUMENT', '参数 content 必须是字符串')
    }
    const content = p.content

    const exists = await ctx.repo.exists(path)
    if (params.ifNotExists && exists) {
      throw new TransportError('ALREADY_EXISTS', `路径已存在: ${path}`)
    }

    // 乐观并发控制：baseEtag 与服务端当前内容不一致时拒绝写入，
    // 否则会无声覆盖掉别处（另一个标签页、一次 pull）产生的改动。
    if (params.baseEtag !== undefined && exists) {
      const currentBuf = await ctx.repo.readBuffer(path)
      const currentEtag = etagOf(currentBuf)
      if (currentEtag !== params.baseEtag) {
        throw new TransportError('STALE_ETAG', '文件已被改动，本次写入未生效', {
          current: { content: currentBuf.toString('utf8'), etag: currentEtag },
        })
      }
    }

    await ctx.repo.writeFile(path, content)
    return { etag: etagOf(content) }
  },

  async 'files.delete'(ctx, params) {
    await ctx.repo.deleteFile(requireString(params as Record<string, unknown>, 'path'))
    return { deleted: true as const }
  },

  async 'changes.list'(ctx) {
    const st = await ctx.repo.status()
    const staged = new Set(st.staged)
    const seen = new Map<string, ChangeEntry>()
    const add = (path: string, status: ChangeEntry['status']): void => {
      // conflicted 优先级最高，不被后续覆盖
      if (seen.get(path)?.status === 'conflicted') return
      seen.set(path, { path, status, staged: staged.has(path) })
    }
    for (const p of st.conflicted) add(p, 'conflicted')
    for (const p of st.untracked) add(p, 'added')
    for (const p of st.modified) add(p, 'modified')
    for (const p of st.staged) if (!seen.has(p)) add(p, 'modified')

    return { files: [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) }
  },

  async 'changes.diff'(ctx, params) {
    const opts: { paths?: string[]; against?: string; context?: number } = {}
    if (params.path) opts.paths = [params.path]
    if (params.against) opts.against = params.against
    if (params.context !== undefined) opts.context = params.context

    const { patch } = await ctx.repo.getDiff(opts)
    const buf = Buffer.from(patch, 'utf8')
    if (buf.length <= ctx.maxContentBytes) return { patch, truncated: false }
    return { patch: buf.subarray(0, ctx.maxContentBytes).toString('utf8'), truncated: true }
  },

  async commit(ctx, params) {
    const message = requireString(params as Record<string, unknown>, 'message')
    const opts: { message: string; paths?: string[] } = { message }
    if (params.paths) opts.paths = params.paths
    return ctx.repo.commit(opts)
  },

  async push(ctx, params) {
    const opts: Parameters<GitRepo['push']>[0] = {}
    if (params.createPR !== undefined) opts.createPR = params.createPR
    if (params.merge !== undefined) opts.merge = params.merge
    if (params.method !== undefined) opts.method = params.method
    if (params.retryOnReject !== undefined) opts.retryOnReject = params.retryOnReject

    const r = await ctx.repo.push(opts)
    // worktreeDir 是服务端绝对路径，绝不能发给浏览器
    if (!r.ok && r.reason === 'conflict') {
      const { worktreeDir: _dropped, ...rest } = r
      return rest
    }
    return r
  },

  async 'sync.pull'(ctx, params) {
    const opts: { strategy?: 'merge' | 'rebase'; ref?: string } = {}
    if (params.strategy) {
      if (params.strategy !== 'merge' && params.strategy !== 'rebase') {
        throw new TransportError('INVALID_ARGUMENT', 'strategy 必须是 merge 或 rebase')
      }
      opts.strategy = params.strategy
    }
    // ref 的合法性由核心包的 assertValidRevision 把关（含前导 - 的参数注入）
    if (params.ref !== undefined) opts.ref = requireString(params as Record<string, unknown>, 'ref')
    return ctx.repo.pull(opts)
  },

  async 'conflicts.list'(ctx) {
    const conflicts = await ctx.repo.getConflicts()
    // 三方内容可能很大，超限则只保留 oid
    for (const c of conflicts) {
      for (const side of ['base', 'ours', 'theirs'] as const) {
        const s = c[side]
        if (s?.content && Buffer.byteLength(s.content, 'utf8') > ctx.maxContentBytes) {
          delete s.content
        }
      }
      if (c.raw && Buffer.byteLength(c.raw, 'utf8') > ctx.maxContentBytes) delete c.raw
    }
    return { conflicts }
  },

  async 'conflicts.resolve'(ctx, params) {
    if (!Array.isArray(params.resolutions)) {
      throw new TransportError('INVALID_ARGUMENT', '参数 resolutions 必须是数组')
    }
    return ctx.repo.resolveConflicts(params.resolutions)
  },

  async 'conflicts.resolveByHunks'(ctx, params) {
    const path = requireString(params as Record<string, unknown>, 'path')
    if (!Array.isArray(params.choices)) {
      throw new TransportError('INVALID_ARGUMENT', '参数 choices 必须是数组')
    }
    return ctx.repo.resolveByHunks(path, params.choices)
  },

  async 'conflicts.continue'(ctx) {
    return ctx.repo.continueRebase()
  },

  async 'conflicts.abort'(ctx) {
    await ctx.repo.abortMerge()
    return { ok: true as const }
  },
}
