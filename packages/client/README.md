# @treenwang/gitkit-client

The browser-side typed RPC client for
[`@treenwang/gitkit`](https://www.npmjs.com/package/@treenwang/gitkit).
**Zero runtime dependencies.**

The protocol contract lives here, in `protocol.ts`, and
[`@treenwang/gitkit-server`](https://www.npmjs.com/package/@treenwang/gitkit-server)
reuses it through `import type`. Any disagreement between the two fails the
typecheck - the contract test is the typecheck.

## Install

```bash
npm install @treenwang/gitkit-client
```

## Usage

```ts
import { GitkitClient } from '@treenwang/gitkit-client'

const client = new GitkitClient({
  baseUrl: '/api/gitkit',
  sessionId: 'my-session',
})

const { entries } = await client.call('files.list', {})
const file = await client.call('files.read', { path: 'docs/getting-started.md' })
if (file.binary) throw new Error('a binary file cannot be edited as text')
await client.call('files.write', {
  path: 'docs/getting-started.md',
  content: '# Hello\n',
  baseEtag: file.etag,          // refuses rather than overwriting someone else's change
})
await client.call('commit', { message: 'docs: update getting started' })
await client.call('push', { createPR: { title: 'Update docs', base: 'main' } })
```

`call(op, params)` is the only entry point. Op names, parameters and results are
all constrained by `protocol.ts`, so a wrong op or a wrong parameter fails the
typecheck. `OP_NAMES` has the full list.

Besides `baseUrl` you can pass `headers` - a function, if you need to refresh a
token per request - along with `credentials` and a custom `fetch`.
`withSession(id)` derives a client bound to another session.

Failures throw a `GitkitClientError` carrying the server's error code, so you
can branch on it. A network-level failure - offline, CORS, aborted - has no HTTP
status code and comes back as `NETWORK` or `TIMEOUT`.

For React, see
[`@treenwang/gitkit-ui`](https://www.npmjs.com/package/@treenwang/gitkit-ui).

## License

MIT
