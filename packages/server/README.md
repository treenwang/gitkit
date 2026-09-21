# @treenwang/gitkit-server

The HTTP transport for
[`@treenwang/gitkit`](https://www.npmjs.com/package/@treenwang/gitkit): a
web-standard handler plus an Express adapter.

The protocol contract is defined by
[`@treenwang/gitkit-client`](https://www.npmjs.com/package/@treenwang/gitkit-client)
and reused here through `import type`, so any disagreement between the two fails
the typecheck.

## Install

```bash
npm install @treenwang/gitkit-server
```

## Usage

```ts
import express from 'express'
import { RepoManager } from '@treenwang/gitkit'
import { createHandler, toExpress } from '@treenwang/gitkit-server'

const manager = new RepoManager({ root: '/data/repos' })

// resolveSession is the authorization boundary: the host decides which session
// a request belongs to.
const handler = createHandler({
  resolveSession: async (req, sessionId) => {
    const user = await authenticate(req)
    return getSessionFor(user, sessionId)   // returns a GitRepo
  },
})

const app = express()
app.use('/api/gitkit', toExpress(handler))
```

`createHandler` returns a `(Request) => Promise<Response>`, which mounts on any
web-standard runtime. `toExpress` is only the adapter for Node and Express.

## License

MIT
