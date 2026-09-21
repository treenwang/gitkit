import { GitOpError } from '../types'

/**
 * Validate a git revision string. Pure function.
 *
 * Why it exists: a revision goes into the git command as a **positional
 * argument** (`git merge --no-edit <rev>`), and these subcommands do not
 * uniformly honour a `--` separator. So **a value starting with `-` is parsed
 * as an option** - which is argument injection when the revision comes from
 * untrusted input such as a browser.
 *
 * The validation is deliberately narrowed to the security-relevant part:
 * commands run through execFile without a shell, so shell metacharacters are
 * harmless on their own; the only real danger is a leading `-`. The remaining
 * rules just reject obviously malformed input. Legitimate forms like `HEAD~1`,
 * `origin/main`, `@{u}` and `abc123^` must pass.
 */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/

export function assertValidRevision(rev: string): string {
  const bad = (why: string): never => {
    throw new GitOpError('INVALID_ARGUMENT', `invalid revision (${why}): ${JSON.stringify(rev)}`)
  }

  if (typeof rev !== 'string' || rev.length === 0) bad('empty')
  if (rev.length > 255) bad('too long')
  // The one genuinely dangerous case
  if (rev.startsWith('-')) bad('must not start with -, git would read it as an option')
  if (CONTROL_OR_SPACE.test(rev)) bad('contains a control character or whitespace')
  if (rev.includes('\\')) bad('contains a backslash')
  return rev
}
