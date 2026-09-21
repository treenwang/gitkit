import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type {
  ChangeEntry, ClientPushResult, FileEntry, OpParams, SessionStatus,
} from '@treenwang/gitkit-client'
import { useGitkit } from '../context'
import { gitkitKeys } from '../keys'

function useSession(): string {
  const { client } = useGitkit()
  return client.sessionId ?? ''
}

export function useSessionStatus(): UseQueryResult<SessionStatus> {
  const { client } = useGitkit()
  const session = useSession()
  return useQuery({
    queryKey: gitkitKeys.status(session),
    queryFn: () => client.call('status', {}),
    enabled: Boolean(session),
  })
}

export function useFileTree(dir?: string): UseQueryResult<FileEntry[]> {
  const { client } = useGitkit()
  const session = useSession()
  return useQuery({
    queryKey: gitkitKeys.files(session, dir),
    queryFn: async () => (await client.call('files.list', dir ? { dir } : {})).entries,
    enabled: Boolean(session),
  })
}

export function useChanges(): UseQueryResult<ChangeEntry[]> {
  const { client } = useGitkit()
  const session = useSession()
  return useQuery({
    queryKey: gitkitKeys.changes(session),
    queryFn: async () => (await client.call('changes.list', {})).files,
    enabled: Boolean(session),
  })
}

export function useDiff(
  opts: { path?: string; against?: string; enabled?: boolean } = {},
): UseQueryResult<{ patch: string; truncated: boolean }> {
  const { client } = useGitkit()
  const session = useSession()
  return useQuery({
    queryKey: gitkitKeys.diff(session, opts.path, opts.against),
    queryFn: () => {
      const params: OpParams<'changes.diff'> = {}
      if (opts.path) params.path = opts.path
      if (opts.against) params.against = opts.against
      return client.call('changes.diff', params)
    },
    enabled: Boolean(session) && (opts.enabled ?? true),
  })
}

/** A commit changes the whole working tree, so the entire session partition is invalidated. */
function useInvalidateSession(): () => void {
  const qc = useQueryClient()
  const session = useSession()
  return () => { void qc.invalidateQueries({ queryKey: gitkitKeys.all(session) }) }
}

export function useCommit() {
  const { client } = useGitkit()
  const invalidate = useInvalidateSession()
  return useMutation({
    mutationFn: (params: OpParams<'commit'>) => client.call('commit', params),
    onSuccess: invalidate,
  })
}

export function usePush() {
  const { client } = useGitkit()
  const invalidate = useInvalidateSession()
  return useMutation<ClientPushResult, Error, OpParams<'push'>>({
    mutationFn: (params) => client.call('push', params),
    onSuccess: invalidate,
  })
}

export function usePull() {
  const { client } = useGitkit()
  const invalidate = useInvalidateSession()
  return useMutation({
    mutationFn: (params: OpParams<'sync.pull'>) => client.call('sync.pull', params),
    onSuccess: invalidate,
  })
}

export function useDeleteFile() {
  const { client } = useGitkit()
  const invalidate = useInvalidateSession()
  return useMutation({
    mutationFn: (path: string) => client.call('files.delete', { path }),
    onSuccess: invalidate,
  })
}

export function useCreateFile() {
  const { client } = useGitkit()
  const invalidate = useInvalidateSession()
  return useMutation({
    mutationFn: (params: { path: string; content?: string }) =>
      client.call('files.write', {
        path: params.path, content: params.content ?? '', ifNotExists: true,
      }),
    onSuccess: invalidate,
  })
}

export function useConflicts() {
  const { client } = useGitkit()
  const session = useSession()
  return useQuery({
    queryKey: gitkitKeys.conflicts(session),
    queryFn: async () => (await client.call('conflicts.list', {})).conflicts,
    enabled: Boolean(session),
  })
}

export function useResolveConflicts() {
  const { client } = useGitkit()
  const invalidate = useInvalidateSession()
  return useMutation({
    mutationFn: (params: OpParams<'conflicts.resolve'>) =>
      client.call('conflicts.resolve', params),
    onSuccess: invalidate,
  })
}

export function useAbortMerge() {
  const { client } = useGitkit()
  const invalidate = useInvalidateSession()
  return useMutation({
    mutationFn: () => client.call('conflicts.abort', {}),
    onSuccess: invalidate,
  })
}
