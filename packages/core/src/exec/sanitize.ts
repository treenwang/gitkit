function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scrub secrets out of arbitrary text. Besides the literal value, this also
 * scrubs the base64 form of `x-access-token:<secret>` - the shape the secret
 * takes on the command line once http.extraheader has injected it.
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
