import {
  GitOpError,
  type ConflictHunk,
  type ConflictSide,
  type ConflictType,
} from '../types'

// ------------------------------------------------------------ index stage table

export type Stage = 1 | 2 | 3
export type UnmergedEntry = {
  path: string
  stages: Map<Stage, ConflictSide>
}

const LS_FILES_U = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.*)$/

/**
 * Parse the output of `git ls-files -u`.
 *
 * Stage 1 is base (the common ancestor), 2 is ours, 3 is theirs.
 * This is the only reliable way to decide a conflict's type: only "both sides
 * modified the same text file" leaves <<<<<<< markers in the working tree; the
 * other kinds leave no markers at all.
 */
export function parseUnmergedIndex(out: string): UnmergedEntry[] {
  const byPath = new Map<string, UnmergedEntry>()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const m = LS_FILES_U.exec(line)
    if (!m) {
      throw new GitOpError('UNKNOWN', `cannot parse this ls-files -u line: ${line}`, { detail: out })
    }
    const [, mode, oid, stageStr, path] = m
    const entry = byPath.get(path!) ?? { path: path!, stages: new Map() }
    entry.stages.set(Number(stageStr) as Stage, { oid: oid!, mode: mode! })
    byPath.set(path!, entry)
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
}

/**
 * Determine the conflict type from which of the three stages are present.
 *
 * This only covers conflicts on a single path. Rename conflicts appear in the
 * index as several entries that each carry one stage (see buildConflictPlan)
 * and do not come through here.
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
    `unrecognized stage combination: base=${base} ours=${ours} theirs=${theirs}`,
  )
}

// ------------------------------------------------------------ rename grouping

/** Output of `git diff --name-status -M`, as old path to new path. */
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
  /** Working-tree paths holding this conflict's content; a rename conflict may have several or none. */
  worktreePath?: string
}

/**
 * Assemble index entries into a conflict plan. Pure function, no IO.
 *
 * A rename conflict appears in the index as several single-stage entries: base
 * at the old path, ours at our new path, theirs at their new path. The rename
 * map from `--name-status -M` merges them back into one type: 'rename' entry.
 */
export function buildConflictPlan(
  entries: readonly UnmergedEntry[],
  renames: RenameMaps,
): ConflictPlan[] {
  const byPath = new Map(entries.map((e) => [e.path, e]))
  const consumed = new Set<string>()
  const plans: ConflictPlan[] = []

  // Group the rename clusters first, anchored on the entries that carry only stage 1
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
      // A stray single-stage entry that fits no rename cluster. Still reported
      // as a rename and left to the host, which beats throwing and blocking the
      // entire conflict list.
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

// ------------------------------------------------------------ conflict markers

const OURS_START = /^<<<<<<<(?: |$)/
const BASE_START = /^\|\|\|\|\|\|\|(?: |$)/
const SEPARATOR = /^=======$/
const THEIRS_END = /^>>>>>>>(?: |$)/

/**
 * Strip a trailing \r before matching markers. In a CRLF file `=======\r` still
 * has to count as the separator, or the whole hunk fails to parse. Content
 * lines themselves are kept verbatim (\r included) so a write-back is
 * byte-identical.
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
 * Split text carrying conflict markers into a sequence of plain segments and
 * conflict segments.
 *
 * The marker sequence must be complete (<<<<<<< [|||||||] ======= >>>>>>>).
 * Anything malformed throws rather than producing a half-parsed result, which
 * would make the host write back the wrong content.
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
            `malformed conflict markers starting at line ${startLine + 1}: >>>>>>> before =======`,
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
        `unclosed conflict markers starting at line ${startLine + 1} (no >>>>>>>)`,
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

/** Whether the content holds a NUL byte - git's main test for binary. */
export function looksBinary(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 8000))
  return window.includes(0)
}
