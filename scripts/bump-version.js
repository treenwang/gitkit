import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const rootDir = resolve(new URL('.', import.meta.url).pathname, '..')
const bumpType = process.argv[2] || 'patch'

function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/)
  if (!m) throw new Error(`Invalid semver: ${v}`)
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4],
  }
}

function computeNextVersion(currentVersion, bump) {
  if (/^\d+\.\d+\.\d+/.test(bump)) {
    return bump
  }
  const { major, minor, patch } = parseSemver(currentVersion)
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`
  }
}

// 1. Determine current version from core package
const corePkgPath = join(rootDir, 'packages/core/package.json')
const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8'))
const currentVersion = corePkg.version
const nextVersion = computeNextVersion(currentVersion, bumpType)

console.log(`Bumping version from ${currentVersion} -> ${nextVersion} (${bumpType})`)

// Known internal package names
const internalPackages = [
  '@treenwang/gitkit',
  '@treenwang/gitkit-client',
  '@treenwang/gitkit-server',
  '@treenwang/gitkit-ui',
]

function updatePackageJson(pkgPath, isRoot = false) {
  if (!existsSync(pkgPath)) return
  const content = JSON.parse(readFileSync(pkgPath, 'utf8'))

  content.version = nextVersion

  // Update internal dependencies
  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (content[depType]) {
      for (const name of internalPackages) {
        if (content[depType][name]) {
          content[depType][name] = `^${nextVersion}`
        }
      }
    }
  }

  writeFileSync(pkgPath, JSON.stringify(content, null, 2) + '\n', 'utf8')
  console.log(`Updated ${pkgPath.replace(rootDir + '/', '')}`)
}

// Update root
updatePackageJson(join(rootDir, 'package.json'), true)

// Update packages/*
const packagesDir = join(rootDir, 'packages')
for (const sub of readdirSync(packagesDir)) {
  const p = join(packagesDir, sub, 'package.json')
  updatePackageJson(p)
}

// Update examples/*
const examplesDir = join(rootDir, 'examples')
if (existsSync(examplesDir)) {
  for (const sub of readdirSync(examplesDir)) {
    const p = join(examplesDir, sub, 'package.json')
    updatePackageJson(p)
  }
}

// Output to GitHub Actions environment if present
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env.GITHUB_OUTPUT, `new_version=${nextVersion}\n`)
}

console.log(`Successfully bumped all packages to v${nextVersion}!`)
