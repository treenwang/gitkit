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
 * Build a bare repository with content to act as the remote, returning its path.
 * Content: docs/a.md, docs/api/b.md, src/index.ts, README.md, assets/logo.bin (binary)
 */
export function makeBareRemote(root: string): string {
  const bare = join(root, 'remote.git')
  const seed = join(root, 'seed')
  mkdirSync(bare, { recursive: true })
  mkdirSync(seed, { recursive: true })

  git(bare, 'init', '--bare', '-b', 'main', '.')
  // A partial clone needs the server to allow filters; file:// transport goes through the local upload-pack
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

/** Add a commit on a branch of the remote, simulating "someone else pushed". */
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
  git(clone, 'commit', '--allow-empty', '-m', opts.message ?? 'external change')
  git(clone, 'push', 'origin', branch)
  rmSync(clone, { recursive: true, force: true })
}

export const urlOf = (p: string): string => `file://${p}`

/**
 * Push onto the remote's main everything the five kinds of conflict need.
 * Afterwards the caller makes the matching change on its own branch and pulls
 * origin/main to reproduce each one.
 */
export function seedConflictBase(root: string, bare: string): void {
  pushToRemote(root, bare, {
    'docs/both.txt': 'l1\nl2\nl3\nl4\nl5\n',
    'docs/delmod.txt': 'del\n',
    'docs/moddel.txt': 'mod\n',
    'docs/orig.txt': 'rename me\n',
  }, { message: 'conflict base' })
}
