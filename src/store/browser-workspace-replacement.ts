import { WorkspaceReplacementInProgressError } from '../core/import-export/errors'
import {
  browserWorkspaceReplacementBlockers,
  commitPreparedBrowserWorkspaceBackup,
  prepareBrowserWorkspaceBackup,
} from './browser-import-export'
import { runBrowserWorkspaceReplacement } from './browser-workspace-replacement-runner'
import type { BrowserWorkspaceSession } from './db'
import type {
  WorkspaceReplacement,
  WorkspaceReplacementEnvelope,
  WorkspaceReplacementResult,
} from './workspace-protocol'
import { WorkspaceRuntimeReplacementBlockedError } from './workspace-runtime'

const STREAM_OWNER_LOCK_PREFIX = 'stream-owner:'

export async function replaceBrowserWorkspace<R extends WorkspaceReplacement>(
  replacement: R,
): Promise<WorkspaceReplacementEnvelope<WorkspaceReplacementResult<R>>> {
  return restoreBrowserWorkspaceBackup(replacement) as Promise<
    WorkspaceReplacementEnvelope<WorkspaceReplacementResult<R>>
  >
}

async function restoreBrowserWorkspaceBackup(
  replacement: Extract<WorkspaceReplacement, { kind: 'interchange.restore-workspace-backup' }>,
): Promise<WorkspaceReplacementEnvelope<WorkspaceReplacementResult<typeof replacement>>> {
  const prepared = await prepareBrowserWorkspaceBackup(replacement.envelope)
  const now = replacement.options.now ?? Date.now()
  const committed = await runBrowserWorkspaceReplacement(
    async (session: BrowserWorkspaceSession) => {
      const sessionDb = await session.open()
      const durableBlockers = await browserWorkspaceReplacementBlockers(sessionDb, now)
      const lockBlockers = await streamOwnerLockBlockers()
      assertNoWorkspaceReplacementBlockers([...durableBlockers, ...lockBlockers])
      return true
    },
    async (replacementDb, context) => {
      context.preactivationCheckpoint()
      const durableBlockers =
        context.atomicity === 'slotted-staging'
          ? await context.withSourceDatabase((source) =>
              browserWorkspaceReplacementBlockers(source, replacement.options.now ?? Date.now()),
            )
          : await browserWorkspaceReplacementBlockers(
              replacementDb,
              replacement.options.now ?? Date.now(),
            )
      assertNoWorkspaceReplacementBlockers([
        ...durableBlockers,
        ...(await streamOwnerLockBlockers()),
      ])
      return context.mutate(async (grant) => {
        const result = await commitPreparedBrowserWorkspaceBackup(
          replacementDb,
          grant,
          prepared,
          replacement.options,
          context.preactivationCheckpoint,
        )
        return {
          workspace: result.workspace,
          storageBaseline: { kind: 'reset', liveBytes: result.estimatedLiveBytes },
          value: result.result,
        }
      })
    },
  ).catch((error: unknown) => {
    if (error instanceof WorkspaceRuntimeReplacementBlockedError) {
      throw new WorkspaceReplacementInProgressError(error.blockerIds)
    }
    throw error
  })
  return {
    ...committed.workspace,
    commitId: null,
    value: committed.value,
  }
}

async function streamOwnerLockBlockers(): Promise<string[]> {
  if (typeof navigator === 'undefined') return []
  const manager = (navigator as unknown as { readonly locks?: LockManager }).locks
  if (!manager || typeof manager.query !== 'function') return []
  try {
    const snapshot = await manager.query()
    const names = [...(snapshot.held ?? []), ...(snapshot.pending ?? [])]
      .map((lock) => lock.name)
      .filter((name): name is string => typeof name === 'string')
      .filter((name) => name.startsWith(STREAM_OWNER_LOCK_PREFIX))
      .map((name) => name.slice(STREAM_OWNER_LOCK_PREFIX.length))
      .filter(Boolean)
    return [...new Set(names)].sort()
  } catch {
    return ['stream-owner-lock-state-unavailable']
  }
}

function assertNoWorkspaceReplacementBlockers(blockerIds: readonly string[]): void {
  if (blockerIds.length > 0) throw new WorkspaceReplacementInProgressError(blockerIds)
}
