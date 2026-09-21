# gitkit React playground

Runs `@treenwang/gitkit-ui` — the React hooks and components — against a real
repository, with the full chain behind it:

```
React + @treenwang/gitkit-ui -> @treenwang/gitkit-client -> Express
  -> @treenwang/gitkit-server -> @treenwang/gitkit -> git -> your repository
```

Demo code. It is `private: true` and belongs to no published package.

For the same chain without React, see [`../playground`](../playground) — plain
HTML and vanilla JS, exercising `@treenwang/gitkit-client` only.

## Run it

```bash
export GITKIT_REPO_URL=https://github.com/<you>/<scratch-repo>
export GITKIT_TOKEN=<your GitHub PAT, needs repo scope>
npm run playground:react       # builds the packages, then starts on :5178
```

Open http://localhost:5178.

> This really creates branches, pushes, and opens pull requests on that
> repository. Use a scratch repo.

Vite runs in middleware mode inside the same Express process, so editing
anything under `app/` hot-reloads. Editing `packages/ui/src` needs
`npm run build --workspace @treenwang/gitkit-ui` to take effect, since the app
consumes the package's build output.

### Without GitHub

`GITKIT_REPO_URL` also accepts a local bare repository. No token, no network;
you lose pull requests but keep sparse checkout, rejected pushes and conflicts:

```bash
mkdir -p /tmp/gitkit-demo && cd /tmp/gitkit-demo
git init -q --bare remote.git && git clone -q remote.git seed && cd seed
mkdir docs && echo '# hello' > docs/a.md
git add -A && git commit -qm init && git branch -M main && git push -q origin main

cd -
GITKIT_REPO_URL=file:///tmp/gitkit-demo/remote.git npm run playground:react
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITKIT_REPO_URL` | required | Repository. `https` + GitHub enables PRs; `file://` stays local |
| `GITKIT_TOKEN` | required for GitHub | Personal access token |
| `GITKIT_PATHS` | `docs` | Check out only these directories, comma separated |
| `GITKIT_BASE` | `main` | Branch to start from |
| `GITKIT_ROOT` | `./.data` | Where workspaces live |
| `PORT` | `5178` | |

## What the page shows

Each panel is labelled with the component that renders it:

| Component | What to look at |
| --- | --- |
| `SyncStatus` | Branch state; pull; abort while a merge is in progress |
| `FileTree` | Only files inside `GITKIT_PATHS` — sparse checkout at work |
| `FileEditor` | Autosave: debounced, etag optimistic locking, `keepalive` on page hide |
| `ChangeList` | Working tree changes, with status |
| `DiffView` | Built-in zero-dependency unified diff; swap it via `renderDiff` |
| `CommitPanel` | commit -> push -> open PR -> pick a merge mode |

Two things worth trying specifically:

**Autosave with optimistic locking.** Type into the editor and stop; it saves
on its own. Then change the same file from another terminal
(`git -C <workspace> ...`) and keep typing — the write is refused instead of
silently overwriting, and `useFile` exposes `staleConflict` with
`overwriteRemote()` / `discardLocal()`.

**A rejected push is a value.** Push once, then push a conflicting commit to
the same branch from elsewhere, then push again. The right-hand panel shows
`{ ok: false, reason: 'conflict', conflicts: [...] }` — not an exception.
After resolving, a merge is concluded with a commit; only a rebase uses
`continue`.

## Theming

`@treenwang/gitkit-ui` ships no CSS. Its components use shadcn's semantic token
classes only, so Tailwind has to scan the package's build output:

```css
@source "../../../packages/ui/dist";
```

Miss that line and the components render completely unstyled without any
error — which is why the package warns in development when `--background` is
undefined. See [`app/theme.css`](app/theme.css) for the token set.

Passing `components={{ Button, Badge }}` to `GitkitProvider` hands the package
your own shadcn primitives. This example leaves it out, so you see the
fallback: plain elements carrying the right token classes.

## What this is not

Sessions live in memory and `resolveSession` lets every request through.
In a real host, `resolveSession` is the authorization boundary.
