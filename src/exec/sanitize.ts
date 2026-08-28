function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从任意文本中抹除 secret。除明文外，还抹除 `x-access-token:<secret>` 的
 * base64 形式 —— 这是 http.extraheader 注入后出现在命令行里的样子。
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (!secret || !secret.trim()) continue
    const variants = [
      secret,
      Buffer.from(`x-access-token:${secret}`).toString('base64'),
      Buffer.from(secret).toString('base64'),
    ]
    for (const v of variants) {
      out = out.replace(new RegExp(escapeRegExp(v), 'g'), '***')
    }
  }
  return out
}
