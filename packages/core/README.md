# @treenwang/gitkit

An embeddable package for operating on Git repositories from a server:
**check out only the directories you name**, **safe under concurrency**,
**conflicts returned as structured data**, with optional GitHub pull requests.

## What it solves

- You need `docs/` out of a repository and do not want to pull the whole thing
  down: partial clone plus cone-mode sparse checkout.
- Your server handles several tasks against one repository at once: one git
  worktree per task, sharing an object database, none of them interfering.
- Someone else may push from another client at any moment: a rejected push and
  a merge conflict are **return values**, not exceptions.
- The target branch is protected: the main path is fixed as create a branch,
  edit, commit, push, open a pull request.

## Requirements

- Node.js >= 18
- **git >= 2.32** on the host; the worktree and sparse-checkout combination is
  defective in earlier versions
- The workspace on **local disk or a Kubernetes PV**, **owned by a single
  process** - several processes may not share one `root`
- HTTPS personal access token authentication
- Pull requests need `@octokit/rest`, an optional peerDependency. Without it
  the core git features are unaffected.

## Install

```bash
npm install @treenwang/gitkit
# only if you want pull requests
npm install @octokit/rest
```

## Quick start

```ts
import { RepoManager } from '@treenwang/gitkit'

const manager = new RepoManager({
  root: '/data/repos',
  auth: { token: process.env.GH_TOKEN! },
})

const store = await manager.store({
  url: 'https://github.com/acme/web',
  github: {},                        // enables pull requests, reusing the token above
})

const result = await store.publish({
  branch: 'feat/docs-update',
  sparsePaths: [
    { path: 'docs', requireChecks: false },   // docs can merge straight away
    { path: 'src', requireChecks: true },     // code has to wait for CI
  ],
  author: { name: 'Bot', email: 'bot@acme.io' },
  message: 'docs: update getting started',
  files: [{ path: 'docs/getting-started.md', content: '# Hello\n' }],
  createPR: { title: 'Update docs', base: 'main' },
  merge: 'auto',
})
```

## Security

- **The token is never written into the URL**, where it would land in
  `.git/config` and the reflog. It is injected per invocation with
  `-c http.extraheader`.
- The token never appears in logs, error messages or the `command` field; it is
  always scrubbed to `***`.
- File access goes through `PathGuard`, which refuses directory traversal,
  access to `.git`, and anything outside the sparse range, then re-checks with
  `realpath` immediately before reading or writing to close the symlink escape.

## Related packages

| Package | Environment | Responsibility |
| --- | --- | --- |
| [`@treenwang/gitkit-server`](https://www.npmjs.com/package/@treenwang/gitkit-server) | server | HTTP transport: a web-standard handler plus an Express adapter |
| [`@treenwang/gitkit-client`](https://www.npmjs.com/package/@treenwang/gitkit-client) | browser | Typed RPC client, zero runtime dependencies |
| [`@treenwang/gitkit-ui`](https://www.npmjs.com/package/@treenwang/gitkit-ui) | browser | React hooks and components |

The core concepts - the three layers, the concurrency model, the push state
machine, conflict handling, session lifecycle and error handling - are covered
in the repository's README and in `docs/superpowers/specs/`.

## License

MIT
