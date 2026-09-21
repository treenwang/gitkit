# @treenwang/gitkit-ui

React hooks and components for
[`@treenwang/gitkit`](https://www.npmjs.com/package/@treenwang/gitkit).
**No editor, no diff viewer, and no bundled CSS.**

```
@treenwang/gitkit-ui/hooks        the logic, on TanStack Query
@treenwang/gitkit-ui/components   the components, on the hooks
```

Import only the hooks and the component code stays out of your bundle.

## Install and theming

```jsonc
// peerDependencies
"react": "^18 || ^19", "@tanstack/react-query": "^5",
// optional peers: used when installed, otherwise the components fall back to plain elements
"radix-ui": "^1", "lucide-react": "*"
```

The components use shadcn's semantic token classes only - `bg-background`,
`text-muted-foreground`, `border-border` and the rest - so they **follow your
theme automatically**, dark mode included. The price is that Tailwind v4 has to
scan this package's build output:

```css
@source "../node_modules/@treenwang/gitkit-ui/dist";
```

**Forgetting that line leaves the components completely unstyled with no error
at all**, so in development the package warns when it cannot find
`--background`.

## Usage

```tsx
import { QueryClientProvider } from '@tanstack/react-query'
import { createClient } from '@treenwang/gitkit-client'
import { GitkitProvider, FileTree, FileEditor, ChangeList, DiffView, CommitPanel, SyncStatus }
  from '@treenwang/gitkit-ui/components'

const client = createClient({ baseUrl: '/api/admin/skills/git' })

<QueryClientProvider client={qc}>
  <GitkitProvider client={client} sessionId={sessionId} components={{ Button, Badge }}>
    <SyncStatus ref="origin/main" />
    <FileTree selected={path} onSelect={setPath} />

    {/* The editor itself is yours - this package is only the shell */}
    <FileEditor path={path}>
      {({ content, onChange }) => <YourLexicalEditor value={content} onChange={onChange} />}
    </FileEditor>

    <ChangeList onSelect={setPath} />
    <DiffView path={path} />
    <CommitPanel base="main" />
  </GitkitProvider>
</QueryClientProvider>
```

Pass your own shadcn components through `components` to take the appearance over
completely; leave it out and you get plain elements carrying the right token
classes.

## Autosave

Edits made through `useFile` and `FileEditor` land in the server's workspace on
their own. The workspace is the single source of truth, so switching devices,
reloading the page or restarting the process all pick up where you left off.

| Trigger | When |
| --- | --- |
| Debounced save | 800ms after typing stops |
| Forced save | At least once every 5s while typing continues |
| Immediate save | `save()`; called when switching files and on blur |
| Page hidden | Rescued with `keepalive` on `visibilitychange` |

Saves carry an **etag optimistic lock**. When the file changes while you are
editing it - another tab, or a pull - the write is refused rather than silently
overwriting, and `staleConflict` offers three ways out:

```tsx
const f = useFile(path)
if (f.staleConflict) {
  f.overwriteRemote()   // keep mine
  f.discardLocal()      // take the server's version and drop mine
  // or render staleConflict.localContent against serverContent yourself
}
```

## The diff renderer is replaceable

The built-in unified diff rendering has no dependencies. Swap it for something
better if you want to - this package does not make that decision for your
bundle:

```tsx
<DiffView path={path} renderDiff={(patch) => <YourMonacoDiff patch={patch} />} />
```

## Hooks

`useSessionStatus` · `useFileTree` · `useFile` · `useChanges` · `useDiff` ·
`useCommit` · `usePush` · `usePull` · `useCreateFile` · `useDeleteFile` ·
`useConflicts` · `useResolveConflicts` · `useAbortMerge`

## License

MIT
