# gitkit playground

Runs the whole chain locally:

```
browser -> @treenwang/gitkit-client -> Express -> @treenwang/gitkit-server
  -> @treenwang/gitkit -> git -> your repository
```

Demo code. It is `private: true` and belongs to no published package.

For the same chain with React and `@treenwang/gitkit-ui`, see
[`../react-playground`](../react-playground).

## Run it

```bash
export GITKIT_REPO_URL=https://github.com/<you>/<scratch-repo>
export GITKIT_TOKEN=<your GitHub PAT, needs repo scope>
npm run playground          # builds the four packages, then starts the server
```

Open http://localhost:5177.

> This really creates branches, pushes, and opens pull requests on that
> repository. Use a scratch repo.

### Without GitHub

`GITKIT_REPO_URL` also accepts a local bare repository. No token, no network;
you lose pull requests but keep sparse checkout, rejected pushes and conflicts:

```bash
mkdir -p /tmp/gitkit-demo && cd /tmp/gitkit-demo
git init -q --bare remote.git && git clone -q remote.git seed && cd seed
mkdir docs && echo '# hello' > docs/a.md
git add -A && git commit -qm init && git branch -M main && git push -q origin main

cd -
GITKIT_REPO_URL=file:///tmp/gitkit-demo/remote.git npm run playground
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITKIT_REPO_URL` | required | Repository. `https` + GitHub enables PRs; `file://` stays local |
| `GITKIT_TOKEN` | required for GitHub | Personal access token; a local repo needs none |
| `GITKIT_PATHS` | `docs` | Check out only these directories, comma separated |
| `GITKIT_BASE` | `main` | Branch to start from |
| `GITKIT_ROOT` | `./.data` | Where workspaces live |
| `PORT` | `5177` | |

## What the page shows

- **Only the directories you name are checked out** - the file list holds
  nothing outside `GITKIT_PATHS`
- **Optimistic locking** - saves carry `baseEtag`, so a file someone else
  changed first comes back as `STALE_ETAG` instead of being overwritten
- **A rejected push is a value** - push after another client pushed first and
  you get `{ ok: false, reason: 'conflict', conflicts: [...] }`, not an
  exception
- **Conflicts are structured data** - each one carries `ours`, `theirs` and
  `hunks` rather than a blob of conflict markers
- **How you conclude** - a merge conflict ends with `commit`, a rebase with
  `continue`

The log panel at the bottom right prints every `client.call(op, params)` and its
error code, which is exactly what you want to watch while integrating.

## What this is not

Sessions live in memory, `resolveSession` lets every request through, and
`exposeDetail` is on. In a real host, `resolveSession` is the authorization
boundary and has to decide who a request belongs to.
