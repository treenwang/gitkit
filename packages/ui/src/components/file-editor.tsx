import { createElement, Fragment, type ReactNode } from 'react'
import { useFile, type SaveState, type UseFileOptions } from '../hooks/use-file'
import { Button, cx, Muted, Panel } from './primitives'

export type FileEditorRenderProps = {
  content: string
  onChange: (next: string) => void
  saveState: SaveState
  binary: boolean
}

export type FileEditorProps = UseFileOptions & {
  path: string
  /** 编辑器本体由宿主提供 —— 本包不含编辑器。 */
  children: (p: FileEditorRenderProps) => ReactNode
  className?: string
}

const SAVE_LABEL: Record<SaveState, string> = {
  clean: '已同步',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
}

/**
 * 编辑器外壳：加载、脏标记、自动保存、etag 冲突提示。
 * 不含编辑器本体 —— 宿主通过 children 传入（Lexical / CodeMirror / textarea 均可）。
 */
export function FileEditor(props: FileEditorProps): React.ReactElement {
  const { path, children, className, ...opts } = props
  const f = useFile(path, opts)

  if (f.loading) return createElement(Muted, null, '正在加载…')
  if (f.loadError) {
    return createElement(Muted, { className: 'text-destructive' },
      `无法打开：${(f.loadError as Error).message}`)
  }
  if (f.binary) {
    return createElement(Panel, { className: 'p-3' },
      createElement(Muted, null, `二进制文件，不可编辑（${f.size ?? 0} 字节）`))
  }

  return createElement(
    'div',
    { className: cx('space-y-2', className) },
    createElement(
      'div',
      { className: 'flex items-center justify-between text-xs text-muted-foreground' },
      createElement('span', { className: 'font-mono' }, path),
      createElement('span', { 'data-save-state': f.saveState }, SAVE_LABEL[f.saveState]),
    ),
    f.truncated
      ? createElement(Muted, { className: 'text-destructive' },
          '文件过大，仅加载了开头部分；保存会截断内容，请勿在此编辑')
      : null,
    f.staleConflict ? createElement(StaleBanner, { file: f }) : null,
    children({
      content: f.content ?? '',
      onChange: f.setContent,
      saveState: f.saveState,
      binary: f.binary,
    }),
  )
}

function StaleBanner({ file }: { file: ReturnType<typeof useFile> }): React.ReactElement {
  const c = file.staleConflict!
  return createElement(
    Panel,
    { className: 'border-destructive/50 bg-destructive/5 p-3 space-y-2' },
    createElement('p', { className: 'text-sm font-medium text-destructive' },
      '这个文件在你编辑期间被改动了，本次保存未生效。'),
    createElement(Muted, null,
      `服务端当前 ${c.serverContent.length} 字符，你的版本 ${c.localContent.length} 字符。`),
    createElement(
      'div',
      { className: 'flex gap-2' },
      createElement(Button, {
        onClick: () => { void file.overwriteRemote() },
        children: '用我的覆盖',
      }),
      createElement(Button, {
        variant: 'ghost',
        onClick: () => { file.discardLocal() },
        children: '放弃我的改动',
      }),
    ),
  )
}
