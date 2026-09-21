/** Key factory for TanStack Query. Partitioned by session, so switching sessions invalidates everything at once. */
export const gitkitKeys = {
  all: (session: string) => ['gitkit', session] as const,
  status: (session: string) => ['gitkit', session, 'status'] as const,
  files: (session: string, dir?: string) => ['gitkit', session, 'files', dir ?? ''] as const,
  file: (session: string, path: string) => ['gitkit', session, 'file', path] as const,
  changes: (session: string) => ['gitkit', session, 'changes'] as const,
  diff: (session: string, path?: string, against?: string) =>
    ['gitkit', session, 'diff', path ?? '', against ?? ''] as const,
  conflicts: (session: string) => ['gitkit', session, 'conflicts'] as const,
}
