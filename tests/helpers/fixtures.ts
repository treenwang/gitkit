import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { realpathSync } from 'node:fs'

export function tempDir(prefix = 'gitop-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

const ENV = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...ENV },
  })
}

/**
 * 造一个带内容的 bare 仓库当作 remote，返回其路径。
 * 内容：docs/a.md、docs/api/b.md、src/index.ts、README.md、assets/logo.bin(二进制)
 */
export function makeBareRemote(root: string): string {
  const bare = join(root, 'remote.git')
  const seed = join(root, 'seed')
  mkdirSync(bare, { recursive: true })
  mkdirSync(seed, { recursive: true })

  git(bare, 'init', '--bare', '-b', 'main', '.')
  // partial clone 需要服务端允许 filter；file:// 传输走本地 upload-pack
  git(bare, 'config', 'uploadpack.allowfilter', 'true')
  git(bare, 'config', 'uploadpack.allowanysha1inwant', 'true')
  git(seed, 'init', '-b', 'main', '.')

  mkdirSync(join(seed, 'docs', 'api'), { recursive: true })
  mkdirSync(join(seed, 'src'), { recursive: true })
  mkdirSync(join(seed, 'assets'), { recursive: true })
  writeFileSync(join(seed, 'docs', 'a.md'), '# a\n')
  writeFileSync(join(seed, 'docs', 'api', 'b.md'), '# b\n')
  writeFileSync(join(seed, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(seed, 'README.md'), '# readme\n')
  writeFileSync(join(seed, 'assets', 'logo.bin'), Buffer.from([0, 1, 2, 0, 255, 3]))

  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'remote', 'add', 'origin', bare)
  git(seed, 'push', 'origin', 'main')
  return bare
}

/** 在 remote 的某个分支上追加一次提交，模拟"别人 push 了改动"。 */
export function pushToRemote(
  root: string,
  bare: string,
  files: Record<string, string | null>,
  opts: { branch?: string; message?: string } = {},
): void {
  const branch = opts.branch ?? 'main'
  const clone = join(root, `ext-${Math.random().toString(36).slice(2, 10)}`)
  git(root, 'clone', '-b', branch, bare, clone)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(clone, rel)
    if (content === null) {
      rmSync(abs, { force: true })
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  git(clone, 'add', '-A')
  git(clone, 'commit', '-m', opts.message ?? 'external change')
  git(clone, 'push', 'origin', branch)
  rmSync(clone, { recursive: true, force: true })
}

export const urlOf = (p: string): string => `file://${p}`
