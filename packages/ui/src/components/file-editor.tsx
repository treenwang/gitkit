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
  /** The editor itself comes from the host - this package contains none. */
  children: (p: FileEditorRenderProps) => ReactNode
  className?: string
}

const SAVE_LABEL: Record<SaveState, string> = {
  clean: 'In sync',
  dirty: 'Unsaved',
  saving: 'Saving...',
  saved: 'Saved',
  error: 'Save failed',
}

/**
 * The shell around an editor: loading, the dirty marker, autosave and the etag
 * conflict prompt. It contains no editor itself - the host passes one through
 * children, be it Lexical, CodeMirror or a plain textarea.
 */
export function FileEditor(props: FileEditorProps): React.ReactElement {
  const { path, children, className, ...opts } = props
  const f = useFile(path, opts)

  if (f.loading) return createElement(Muted, null, 'Loading...')
  if (f.loadError) {
    return createElement(Muted, { className: 'text-destructive' },
      `Could not open: ${(f.loadError as Error).message}`)
  }
  if (f.binary) {
    return createElement(Panel, { className: 'p-3' },
      createElement(Muted, null, `Binary file, not editable (${f.size ?? 0} bytes)`))
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
          'This file is too large, so only the beginning was loaded. Saving would truncate it - do not edit here.')
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
      'This file changed while you were editing it, so your save did not land.'),
    createElement(Muted, null,
      `The server holds ${c.serverContent.length} characters, your version has ${c.localContent.length}.`),
    createElement(
      'div',
      { className: 'flex gap-2' },
      createElement(Button, {
        onClick: () => { void file.overwriteRemote() },
        children: 'Overwrite with mine',
      }),
      createElement(Button, {
        variant: 'ghost',
        onClick: () => { file.discardLocal() },
        children: 'Discard my changes',
      }),
    ),
  )
}
