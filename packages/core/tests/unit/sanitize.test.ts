import { describe, expect, test } from 'vitest'
import { redact } from '../../src/exec/sanitize'

describe('redact', () => {
  test('replaces a plaintext secret', () => {
    expect(redact('token is ghp_abc123', ['ghp_abc123'])).toBe('token is ***')
  })

  test('replaces the base64-encoded secret, the form http.extraheader uses', () => {
    const token = 'ghp_abc123'
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64')
    const line = `git -c http.extraheader=AUTHORIZATION: basic ${encoded} fetch`
    const out = redact(line, [token])
    expect(out).not.toContain(encoded)
    expect(out).toContain('***')
  })

  test('replaces every occurrence', () => {
    expect(redact('a T b T c', ['T'])).toBe('a *** b *** c')
  })

  test('an empty secret is ignored rather than replacing everything', () => {
    expect(redact('hello', ['', '  '])).toBe('hello')
  })

  test('a secret containing regex metacharacters is replaced literally', () => {
    expect(redact('v=a.b*c', ['a.b*c'])).toBe('v=***')
  })

  test('returns the text unchanged when there is no secret', () => {
    expect(redact('nothing to hide', [])).toBe('nothing to hide')
  })
})
