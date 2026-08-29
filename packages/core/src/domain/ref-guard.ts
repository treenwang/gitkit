import { GitOpError } from '../types'

/**
 * 校验 git revision 字符串。纯函数。
 *
 * 存在的理由：revision 会作为**位置参数**拼进 git 命令（`git merge --no-edit <rev>`），
 * 而 git 的这些子命令并不统一支持 `--` 分隔符。因此**以 `-` 开头的值会被当作选项解析** ——
 * 当 revision 来自不可信输入（例如浏览器）时，这是参数注入。
 *
 * 校验刻意只收紧到安全相关的部分：命令通过 execFile 执行、不经 shell，所以 shell 元字符
 * 本身无害；真正危险的只有前导 `-`。其余规则用于挡掉明显畸形的输入。
 * `HEAD~1`、`origin/main`、`@{u}`、`abc123^` 等合法写法必须放行。
 */
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/

export function assertValidRevision(rev: string): string {
  const bad = (why: string): never => {
    throw new GitOpError('INVALID_ARGUMENT', `非法的 revision (${why}): ${JSON.stringify(rev)}`)
  }

  if (typeof rev !== 'string' || rev.length === 0) bad('为空')
  if (rev.length > 255) bad('过长')
  // 唯一真正危险的一条
  if (rev.startsWith('-')) bad('不得以 - 开头，会被 git 当作选项')
  if (CONTROL_OR_SPACE.test(rev)) bad('含控制字符或空白')
  if (rev.includes('\\')) bad('含反斜杠')
  return rev
}
