import { describe, expect, test } from 'bun:test'
import { redact } from '../../src/exec/sanitize'

describe('redact', () => {
  test('替换明文 secret', () => {
    expect(redact('token is ghp_abc123', ['ghp_abc123'])).toBe('token is ***')
  })

  test('替换 base64 编码后的 secret（http.extraheader 的形式）', () => {
    const token = 'ghp_abc123'
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64')
    const line = `git -c http.extraheader=AUTHORIZATION: basic ${encoded} fetch`
    const out = redact(line, [token])
    expect(out).not.toContain(encoded)
    expect(out).toContain('***')
  })

  test('多次出现全部替换', () => {
    expect(redact('a T b T c', ['T'])).toBe('a *** b *** c')
  })

  test('空 secret 被忽略，不产生全文替换', () => {
    expect(redact('hello', ['', '  '])).toBe('hello')
  })

  test('secret 含正则元字符时按字面量替换', () => {
    expect(redact('v=a.b*c', ['a.b*c'])).toBe('v=***')
  })

  test('无 secret 时原样返回', () => {
    expect(redact('nothing to hide', [])).toBe('nothing to hide')
  })
})
