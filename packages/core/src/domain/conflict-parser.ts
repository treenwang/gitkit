import {
  GitOpError,
  type ConflictHunk,
  type ConflictSide,
  type ConflictType,
} from '../types'

// ------------------------------------------------------------ 索引 stage 表

export type Stage = 1 | 2 | 3
export type UnmergedEntry = {
  path: string
  stages: Map<Stage, ConflictSide>
}

const LS_FILES_U = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.*)$/

/**
 * 解析 `git ls-files -u` 的输出。
 *
 * stage 1 = base（共同祖先），2 = ours，3 = theirs。
 * 这是判定冲突类型的唯一可靠来源 —— 只有"双方都改了同一个文本文件"
 * 才会在工作区留下 <<<<<<< 标记，其余类型完全没有标记。
 */
export function parseUnmergedIndex(out: string): UnmergedEntry[] {
  const byPath = new Map<string, UnmergedEntry>()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const m = LS_FILES_U.exec(line)
    if (!m) {
      throw new GitOpError('UNKNOWN', `无法解析 ls-files -u 输出行: ${line}`, { detail: out })
    }
    const [, mode, oid, stageStr, path] = m
    const entry = byPath.get(path!) ?? { path: path!, stages: new Map() }
    entry.stages.set(Number(stageStr) as Stage, { oid: oid!, mode: mode! })
    byPath.set(path!, entry)
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * 由三个 stage 的在场组合确定冲突类型。
 *
 * 只处理"同一路径上的冲突"。rename 类冲突在索引里表现为多条各只有一个
 * stage 的记录（见 buildConflictPlan），不走这里。
 */
export function classifyConflict(stages: ReadonlyMap<Stage, ConflictSide>): ConflictType {
  const base = stages.has(1)
  const ours = stages.has(2)
  const theirs = stages.has(3)

  if (ours && theirs) return base ? 'both_modified' : 'both_added'
  if (base && ours && !theirs) return 'deleted_by_them'
  if (base && !ours && theirs) return 'deleted_by_us'
  throw new GitOpError(
    'UNKNOWN',
    `无法识别的 stage 组合: base=${base} ours=${ours} theirs=${theirs}`,
  )
}

// ------------------------------------------------------------ rename 归组

/** `git diff --name-status -M` 的输出 → 旧路径 → 新路径。 */
export function parseRenameMap(out: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const statusField = parts[0] ?? ''
    if (!statusField.startsWith('R')) continue
    const from = parts[1]
    const to = parts[2]
    if (from && to) map.set(from, to)
  }
  return map
}

export type RenameMaps = { ours: Map<string, string>; theirs: Map<string, string> }

export type ConflictPlan = {
  path: string
  type: ConflictType
  base?: ConflictSide
  ours?: ConflictSide
  theirs?: ConflictSide
  ourPath?: string
  theirPath?: string
  /** 工作区中承载该冲突内容的路径；rename 类冲突可能有多个或没有。 */
  worktreePath?: string
}

/**
 * 把索引条目组装成冲突计划。纯函数，不碰 IO。
 *
 * rename 冲突在索引里是多条各只有一个 stage 的记录（base 在旧路径，
 * ours 在我方新路径，theirs 在对方新路径）。用 `--name-status -M` 得到的
 * 重命名映射把它们归并成一条 type: 'rename' 的记录。
 */
export function buildConflictPlan(
  entries: readonly UnmergedEntry[],
  renames: RenameMaps,
): ConflictPlan[] {
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const consumed = new Set<string>()
  const plans: ConflictPlan[] = []

  // 先归并 rename 簇：以只有 stage 1 的条目为锚点
  for (const entry of entries) {
    if (entry.stages.size !== 1 || !entry.stages.has(1)) continue
    const basePath = entry.path
    const ourPath = renames.ours.get(basePath)
    const theirPath = renames.theirs.get(basePath)
    if (!ourPath && !theirPath) continue

    const ourEntry = ourPath ? byPath.get(ourPath) : undefined
    const theirEntry = theirPath ? byPath.get(theirPath) : undefined

    consumed.add(basePath)
    if (ourEntry) consumed.add(ourEntry.path)
    if (theirEntry) consumed.add(theirEntry.path)

    plans.push({
      path: basePath,
      type: 'rename',
      base: entry.stages.get(1),
      ...(ourEntry?.stages.get(2) ? { ours: ourEntry.stages.get(2) } : {}),
      ...(theirEntry?.stages.get(3) ? { theirs: theirEntry.stages.get(3) } : {}),
      ...(ourPath ? { ourPath } : {}),
      ...(theirPath ? { theirPath } : {}),
    })
  }

  for (const entry of entries) {
    if (consumed.has(entry.path)) continue
    if (entry.stages.size === 1) {
      // 落单的单 stage 条目：无法归入任何 rename 簇，仍按 rename 上报，
      // 由宿主决策 —— 好过抛错阻塞整个冲突列表。
      plans.push({
        path: entry.path,
        type: 'rename',
        ...(entry.stages.get(1) ? { base: entry.stages.get(1) } : {}),
        ...(entry.stages.get(2) ? { ours: entry.stages.get(2), ourPath: entry.path } : {}),
        ...(entry.stages.get(3) ? { theirs: entry.stages.get(3), theirPath: entry.path } : {}),
      })
      continue
    }
    plans.push({
      path: entry.path,
      type: classifyConflict(entry.stages),
      ...(entry.stages.get(1) ? { base: entry.stages.get(1) } : {}),
      ...(entry.stages.get(2) ? { ours: entry.stages.get(2) } : {}),
      ...(entry.stages.get(3) ? { theirs: entry.stages.get(3) } : {}),
      worktreePath: entry.path,
    })
  }

  return plans.sort((a, b) => (a.path < b.path ? -1 : 1))
}

// ------------------------------------------------------------ 冲突标记

const OURS_START = /^<<<<<<<(?: |$)/
const BASE_START = /^\|\|\|\|\|\|\|(?: |$)/
const SEPARATOR = /^=======$/
const THEIRS_END = /^>>>>>>>(?: |$)/

/**
 * 标记检测前先去掉行尾的 \r。CRLF 文件里 `=======\r` 必须仍被认作分隔符，
 * 否则整个冲突块会解析失败。内容行本身保留原样（含 \r），保证写回时字节一致。
 */
function marker(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export type Segment =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'hunk'
      index: number
      ourLines: string[]
      theirLines: string[]
      baseLines?: string[]
      startLine: number
      endLine: number
    }

/**
 * 把带冲突标记的文本切成「普通文本段」与「冲突段」的序列。
 *
 * 严格要求标记序列完整（<<<<<<< [|||||||] ======= >>>>>>>）；残缺即抛错，
 * 绝不产出半解析的垃圾结果 —— 那会让宿主写回错误的内容。
 */
export function scanConflicts(raw: string): Segment[] {
  const lines = raw.split('\n')
  const segments: Segment[] = []
  let text: string[] = []
  let hunkIndex = 0
  let i = 0

  const flushText = (): void => {
    if (text.length > 0) {
      segments.push({ kind: 'text', lines: text })
      text = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]!
    if (!OURS_START.test(marker(line))) {
      text.push(line)
      i += 1
      continue
    }

    const startLine = i
    i += 1
    const ourLines: string[] = []
    let baseLines: string[] | undefined
    const theirLines: string[] = []
    let phase: 'ours' | 'base' | 'theirs' = 'ours'
    let closed = false

    while (i < lines.length) {
      const cur = lines[i]!
      const m = marker(cur)
      if (phase === 'ours' && BASE_START.test(m)) {
        phase = 'base'
        baseLines = []
        i += 1
        continue
      }
      if (phase !== 'theirs' && SEPARATOR.test(m)) {
        phase = 'theirs'
        i += 1
        continue
      }
      if (THEIRS_END.test(m)) {
        if (phase !== 'theirs') {
          throw new GitOpError(
            'UNKNOWN',
            `第 ${startLine + 1} 行开始的冲突标记残缺：在 ======= 之前遇到 >>>>>>>`,
          )
        }
        closed = true
        i += 1
        break
      }
      if (phase === 'ours') ourLines.push(cur)
      else if (phase === 'base') baseLines!.push(cur)
      else theirLines.push(cur)
      i += 1
    }

    if (!closed) {
      throw new GitOpError(
        'UNKNOWN',
        `第 ${startLine + 1} 行开始的冲突标记未闭合（缺少 >>>>>>>）`,
      )
    }

    flushText()
    segments.push({
      kind: 'hunk',
      index: hunkIndex++,
      ourLines,
      theirLines,
      ...(baseLines ? { baseLines } : {}),
      startLine,
      endLine: i - 1,
    })
  }

  flushText()
  return segments
}

export function parseConflictHunks(raw: string): ConflictHunk[] {
  return scanConflicts(raw)
    .filter((s): s is Extract<Segment, { kind: 'hunk' }> => s.kind === 'hunk')
    .map(({ kind, ...h }) => h as ConflictHunk)
}

/** 内容中是否含 NUL 字节 —— git 判定二进制的主要依据。 */
export function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 8000))
  return window.includes(0)
}
