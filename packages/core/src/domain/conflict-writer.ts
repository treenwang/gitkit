import { scanConflicts } from './conflict-parser'
import { GitOpError, type HunkChoice } from '../types'

/**
 * Rebuild the full file contents from a per-hunk choice. Pure function, no IO.
 *
 * choices must have exactly one entry per hunk. There is deliberately no
 * "omitted means ours" default: a host that forgets one entry would silently
 * drop a change.
 */
export function buildResolvedContent(raw: string, choices: readonly HunkChoice[]): string {
  const segments = scanConflicts(raw)
  const hunkCount = segments.filter((s) => s.kind === 'hunk').length

  if (choices.length !== hunkCount) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `got ${choices.length} choices for ${hunkCount} conflict hunks`,
    )
  }

  const out: string[] = []
  for (const seg of segments) {
    if (seg.kind === 'text') {
      out.push(...seg.lines)
      continue
    }
    const choice = choices[seg.index]!
    if (typeof choice === 'object') {
      const text = choice.content
      out.push(...(text === '' ? [] : text.split('\n')))
      continue
    }
    switch (choice) {
      case 'ours':
        out.push(...seg.ourLines)
        break
      case 'theirs':
        out.push(...seg.theirLines)
        break
      case 'base':
        if (!seg.baseLines) {
          throw new GitOpError(
            'INVALID_ARGUMENT',
            `conflict hunk ${seg.index} has no base section (requires merge.conflictStyle=diff3)`,
          )
        }
        out.push(...seg.baseLines)
        break
      case 'both':
        out.push(...seg.ourLines, ...seg.theirLines)
        break
      default: {
        const never: never = choice
        throw new GitOpError('INVALID_ARGUMENT', `unknown HunkChoice: ${String(never)}`)
      }
    }
  }
  return out.join('\n')
}
