import { describe, expect, test } from 'bun:test'
import {
  decideRetry, deriveMergeMode, needsDerivation, resolveMergeMode,
} from '../../src/domain/push-policy'
import type { SparsePath } from '../../src/types'

const docs: SparsePath = { path: 'docs', requireChecks: false }
const src: SparsePath = { path: 'src', requireChecks: true }

describe('deriveMergeMode', () => {
  test('全部命中 requireChecks: false → now', () => {
    expect(deriveMergeMode(['docs/a.md', 'docs/api/b.md'], [docs, src])).toBe('now')
  })

  test('任一命中 requireChecks: true → checksPass（取最保守）', () => {
    expect(deriveMergeMode(['docs/a.md', 'src/x.ts'], [docs, src])).toBe('checksPass')
  })

  test('全部命中 requireChecks: true → checksPass', () => {
    expect(deriveMergeMode(['src/x.ts'], [docs, src])).toBe('checksPass')
  })

  test('未配置 sparsePaths（全量模式）→ checksPass', () => {
    expect(deriveMergeMode(['docs/a.md'], [])).toBe('checksPass')
  })

  test('改动落在声明范围之外 → checksPass', () => {
    expect(deriveMergeMode(['README.md'], [docs])).toBe('checksPass')
  })

  test('没有任何改动 → checksPass', () => {
    expect(deriveMergeMode([], [docs])).toBe('checksPass')
  })

  test('sparse 路径本身被改动时也算命中', () => {
    expect(deriveMergeMode(['docs'], [docs])).toBe('now')
  })

  test('前缀相似但非子路径不算命中', () => {
    expect(deriveMergeMode(['docsite/a.md'], [docs])).toBe('checksPass')
  })
})

describe('decideRetry', () => {
  test('首次被拒且开启重试 → retry', () => {
    expect(decideRetry({ retryOnReject: true, attempt: 0 })).toBe('retry')
  })
  test('第二次被拒 → give_up（只重试一次）', () => {
    expect(decideRetry({ retryOnReject: true, attempt: 1 })).toBe('give_up')
  })
  test('关闭重试 → give_up', () => {
    expect(decideRetry({ retryOnReject: false, attempt: 0 })).toBe('give_up')
  })
})

describe('resolveMergeMode / needsDerivation', () => {
  test('显式模式直接透传，不做推导', () => {
    expect(needsDerivation('now')).toBe(false)
    expect(needsDerivation('checksPass')).toBe(false)
    expect(needsDerivation(false)).toBe(false)
    expect(resolveMergeMode('now', 'checksPass')).toBe('now')
    expect(resolveMergeMode('checksPass', 'now')).toBe('checksPass')
    expect(resolveMergeMode(false, 'now')).toBe(false)
  })
  test("'auto' 与省略都走推导", () => {
    expect(needsDerivation('auto')).toBe(true)
    expect(needsDerivation(undefined)).toBe(true)
    expect(resolveMergeMode('auto', 'now')).toBe('now')
    expect(resolveMergeMode(undefined, 'checksPass')).toBe('checksPass')
  })
})
