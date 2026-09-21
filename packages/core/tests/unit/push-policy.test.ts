import { describe, expect, test } from 'vitest'
import {
  decideRetry, deriveMergeMode, needsDerivation, resolveMergeMode,
} from '../../src/domain/push-policy'
import type { SparsePath } from '../../src/types'

const docs: SparsePath = { path: 'docs', requireChecks: false }
const src: SparsePath = { path: 'src', requireChecks: true }

describe('deriveMergeMode', () => {
  test('every match has requireChecks: false, so now', () => {
    expect(deriveMergeMode(['docs/a.md', 'docs/api/b.md'], [docs, src])).toBe('now')
  })

  test('any match with requireChecks: true gives checksPass, the most conservative answer', () => {
    expect(deriveMergeMode(['docs/a.md', 'src/x.ts'], [docs, src])).toBe('checksPass')
  })

  test('every match has requireChecks: true, so checksPass', () => {
    expect(deriveMergeMode(['src/x.ts'], [docs, src])).toBe('checksPass')
  })

  test('no sparsePaths configured, meaning full checkout, gives checksPass', () => {
    expect(deriveMergeMode(['docs/a.md'], [])).toBe('checksPass')
  })

  test('a change outside the declared range gives checksPass', () => {
    expect(deriveMergeMode(['README.md'], [docs])).toBe('checksPass')
  })

  test('no changes at all gives checksPass', () => {
    expect(deriveMergeMode([], [docs])).toBe('checksPass')
  })

  test('the sparse path itself being changed counts as a match', () => {
    expect(deriveMergeMode(['docs'], [docs])).toBe('now')
  })

  test('a similar prefix that is not a subpath does not count as a match', () => {
    expect(deriveMergeMode(['docsite/a.md'], [docs])).toBe('checksPass')
  })
})

describe('decideRetry', () => {
  test('a first rejection with retries enabled gives retry', () => {
    expect(decideRetry({ retryOnReject: true, attempt: 0 })).toBe('retry')
  })
  test('a second rejection gives give_up - only one retry', () => {
    expect(decideRetry({ retryOnReject: true, attempt: 1 })).toBe('give_up')
  })
  test('retries disabled gives give_up', () => {
    expect(decideRetry({ retryOnReject: false, attempt: 0 })).toBe('give_up')
  })
})

describe('resolveMergeMode / needsDerivation', () => {
  test('an explicit mode passes straight through with no derivation', () => {
    expect(needsDerivation('now')).toBe(false)
    expect(needsDerivation('checksPass')).toBe(false)
    expect(needsDerivation(false)).toBe(false)
    expect(resolveMergeMode('now', 'checksPass')).toBe('now')
    expect(resolveMergeMode('checksPass', 'now')).toBe('checksPass')
    expect(resolveMergeMode(false, 'now')).toBe(false)
  })
  test("both 'auto' and omitting it go through derivation", () => {
    expect(needsDerivation('auto')).toBe(true)
    expect(needsDerivation(undefined)).toBe(true)
    expect(resolveMergeMode('auto', 'now')).toBe('now')
    expect(resolveMergeMode(undefined, 'checksPass')).toBe('checksPass')
  })
})
