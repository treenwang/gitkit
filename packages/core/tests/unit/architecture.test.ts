import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved relative to this file rather than cwd, or running the tests from the repo root would not find src/
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = walk(SRC)

describe('architectural constraints', () => {
  test('only git-executor.ts may import child_process', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith('git-executor.ts') &&
        /from ['"]node:child_process['"]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  test('nothing under domain/ may touch IO', () => {
    const offenders = files
      .filter((f) => f.includes('/domain/'))
      .filter((f) =>
        /from ['"]node:(fs|fs\/promises|child_process|net|http|https)['"]/.test(
          readFileSync(f, 'utf8'),
        ),
      )
    expect(offenders).toEqual([])
  })

  test('domain/ may not import api/ or exec/', () => {
    const offenders = files
      .filter((f) => f.includes('/domain/'))
      .filter((f) => /from ['"]\.\.\/(api|exec)\//.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  test('exec/ may not import api/ or the stateful classes in domain', () => {
    const offenders = files
      .filter((f) => f.includes('/exec/'))
      .filter((f) => /from ['"]\.\.\/api\//.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
