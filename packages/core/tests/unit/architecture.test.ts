import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 相对于本文件定位，而不是相对于 cwd —— 否则从仓库根目录跑测试会找不到 src/
const SRC = resolve(import.meta.dir, '..', '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = walk(SRC)

describe('架构约束', () => {
  test('只有 git-executor.ts 可以 import child_process', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith('git-executor.ts') &&
        /from ['"]node:child_process['"]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  test('domain/ 下不得碰 IO', () => {
    const offenders = files
      .filter((f) => f.includes('/domain/'))
      .filter((f) =>
        /from ['"]node:(fs|fs\/promises|child_process|net|http|https)['"]/.test(
          readFileSync(f, 'utf8'),
        ),
      )
    expect(offenders).toEqual([])
  })

  test('domain/ 不得 import api/ 或 exec/', () => {
    const offenders = files
      .filter((f) => f.includes('/domain/'))
      .filter((f) => /from ['"]\.\.\/(api|exec)\//.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  test('exec/ 不得 import api/ 或 domain 的有状态类', () => {
    const offenders = files
      .filter((f) => f.includes('/exec/'))
      .filter((f) => /from ['"]\.\.\/api\//.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
