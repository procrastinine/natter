import Dexie from 'dexie'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import {
  awaitStorageMaintenanceRuntimeIdle,
  closeStorageMaintenanceRuntime,
} from '../../src/store/storage-maintenance-runtime'
import type { WorkspaceChange } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction } from '../../src/store/workspace-runtime'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

beforeAll(async () => {
  await resetWorkspace()
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  closeStorageMaintenanceRuntime()
  await awaitStorageMaintenanceRuntimeIdle()
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
  closeStorageMaintenanceRuntime()
  await awaitStorageMaintenanceRuntimeIdle()
})

afterAll(async () => {
  closeStorageMaintenanceRuntime()
  await awaitStorageMaintenanceRuntimeIdle()
  await shutdownBrowserWorkspace()
  await resetWorkspace()
})

describe('committed write delivery', () => {
  it('derives workspace publication from the physical command transaction', async () => {
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const commit = await runWorkspaceAction('workspace-organization', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'folder.create',
        input: { id: 'derived-write-folder', name: 'Derived', now: 10 },
      }),
    )

    expect(await getDb().folders.get('derived-write-folder')).toMatchObject({ name: 'Derived' })
    expect(commit.effectScope).toBe('workspace')
    const commits = changes.filter((change) => change.kind === 'commit')
    expect(commits).toHaveLength(1)
    expect(commits[0]?.stamp.commitId).toBe(commit.commitId)
    unsubscribe()
  })

  it('keeps internal maintenance writes outside workspace publication', async () => {
    const changes: unknown[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const attachments = await runWorkspaceAction('maintenance', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'attachment.reap',
        now: 10,
        maxAgeMs: 1,
        limit: 8,
      }),
    )
    const streams = await runWorkspaceAction('maintenance', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'maintenance.prune-terminal-stream-journals',
        now: 10,
        maxAgeMs: 1,
        limit: 8,
      }),
    )
    const drafts = await runWorkspaceAction('maintenance', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'maintenance.prune-empty-draft-chats',
        now: 10,
        maxAgeMs: 1,
        limit: 8,
      }),
    )

    expect([attachments.effectScope, streams.effectScope, drafts.effectScope]).toEqual([
      'none',
      'none',
      'none',
    ])
    expect(changes).toEqual([])
    unsubscribe()
  })
})

async function resetWorkspace(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete('natter')
}
