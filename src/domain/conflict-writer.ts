import { scanConflicts } from './conflict-parser'
import { GitOpError, type HunkChoice } from '../types'

/**
 * 按每个 hunk 的选择重建完整文件内容。纯函数，不碰 IO。
 *
 * choices 长度必须与 hunk 数一致 —— 不做"省略即 ours"的默认，避免宿主
 * 漏传一个就静默丢掉改动。
 */
export function buildResolvedContent(raw: string, choices: readonly HunkChoice[]): string {
  const segments = scanConflicts(raw)
  const hunkCount = segments.filter((s) => s.kind === 'hunk').length

  if (choices.length !== hunkCount) {
    throw new GitOpError(
      'INVALID_ARGUMENT',
      `choices 数量(${choices.length})与冲突块数量(${hunkCount})不一致`,
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
            `第 ${seg.index} 个冲突块没有 base 段（需要 merge.conflictStyle=diff3）`,
          )
        }
        out.push(...seg.baseLines)
        break
      case 'both':
        out.push(...seg.ourLines, ...seg.theirLines)
        break
      default: {
        const never: never = choice
        throw new GitOpError('INVALID_ARGUMENT', `未知的 HunkChoice: ${String(never)}`)
      }
    }
  }
  return out.join('\n')
}
