# @aaxis/gitkit-ui

`@aaxis/gitkit` 的 React hooks 与组件。**不含编辑器、不含 diff viewer、不打包任何 CSS。**

```
@aaxis/gitkit-ui/hooks        逻辑，基于 TanStack Query
@aaxis/gitkit-ui/components   组件，依赖 hooks
```

只引 hooks 的话，组件代码不会进入 bundle。

## 安装与主题

```jsonc
// peerDependencies
"react": "^18 || ^19", "@tanstack/react-query": "^5",
// 可选 peer：装了就用，没装则退化为原生元素
"radix-ui": "^1", "lucide-react": "*"
```

组件只使用 shadcn 的语义 token 类名（`bg-background`、`text-muted-foreground`、
`border-border`…），因此**自动跟随你的主题**，包括暗色模式。代价是要让 Tailwind v4
扫描本包产物：

```css
@source "../node_modules/@aaxis/gitkit-ui/dist";
```

**忘记这一行会让组件完全没有样式且不报错**，所以开发模式下检测不到 `--background`
时会 `console.warn` 提示。

## 用法

```tsx
import { QueryClientProvider } from '@tanstack/react-query'
import { createClient } from '@aaxis/gitkit-client'
import { GitkitProvider, FileTree, FileEditor, ChangeList, DiffView, CommitPanel, SyncStatus }
  from '@aaxis/gitkit-ui/components'

const client = createClient({ baseUrl: '/api/admin/skills/git' })

<QueryClientProvider client={qc}>
  <GitkitProvider client={client} sessionId={sessionId} components={{ Button, Badge }}>
    <SyncStatus ref="origin/main" />
    <FileTree selected={path} onSelect={setPath} />

    {/* 编辑器本体由你提供 —— 本包只做外壳 */}
    <FileEditor path={path}>
      {({ content, onChange }) => <YourLexicalEditor value={content} onChange={onChange} />}
    </FileEditor>

    <ChangeList onSelect={setPath} />
    <DiffView path={path} />
    <CommitPanel base="main" />
  </GitkitProvider>
</QueryClientProvider>
```

`components` 传入你自己的 shadcn 组件即可完全接管外观；不传则用带正确 token 类名的原生元素。

## 自动保存

`useFile` / `FileEditor` 的编辑会自动落到服务端工作区 —— 工作区是唯一真相，
所以换设备、刷新页面、进程重启都能续上。

| 触发 | 时机 |
| --- | --- |
| 防抖保存 | 停止输入 800ms |
| 强制保存 | 连续输入时每 5s 至少一次 |
| 立即保存 | `save()`；切换文件、失焦时调用 |
| 页面隐藏 | `visibilitychange` 时用 `keepalive` 抢救 |

保存带 **etag 乐观锁**。文件在你编辑期间被改动（另一个标签页、一次 `pull`）时，
写入会被拒绝而不是无声覆盖，`staleConflict` 给出三条出路：

```tsx
const f = useFile(path)
if (f.staleConflict) {
  f.overwriteRemote()   // 用我的覆盖
  f.discardLocal()      // 放弃我的改动，采用服务端版本
  // 或自行渲染 staleConflict.localContent 与 serverContent 做对比
}
```

## Diff 渲染可替换

内置零依赖的统一 diff 渲染；想要更好的体验就换掉，本包不替你的 bundle 做决定：

```tsx
<DiffView path={path} renderDiff={(patch) => <YourMonacoDiff patch={patch} />} />
```

## hooks

`useSessionStatus` · `useFileTree` · `useFile` · `useChanges` · `useDiff` ·
`useCommit` · `usePush` · `usePull` · `useCreateFile` · `useDeleteFile` ·
`useConflicts` · `useResolveConflicts` · `useAbortMerge`
