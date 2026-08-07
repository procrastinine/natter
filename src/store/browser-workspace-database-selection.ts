import type { BrowserWorkspaceDatabaseName } from '../lib/origin-storage-names'
import {
  assertBrowserWorkspaceBootstrapAuthority,
  type BrowserWorkspaceBootstrapAuthority,
} from './browser-workspace-bootstrap-authority'
import { readBrowserWorkspaceDatabaseManifest } from './browser-workspace-database-control'
import type { BrowserWorkspaceOpenProgress } from './browser-workspace-open-contract'
import {
  acquireBrowserWorkspaceSlotLease,
  type BrowserWorkspaceSlotLeaseHandle,
  releaseBrowserWorkspaceSlotLease,
} from './browser-workspace-slot-coordination'
import { ensureBrowserWorkspaceCurrentForSelection } from './browser-workspace-startup-repair'
import { configureBrowserWorkspaceDatabaseName } from './db'

declare const openingBrowserWorkspaceDatabaseSelectionBrand: unique symbol
declare const activeBrowserWorkspaceDatabaseSelectionBrand: unique symbol

export interface OpeningBrowserWorkspaceDatabaseSelection {
  readonly databaseName: BrowserWorkspaceDatabaseName
  readonly activationSequence: number
  readonly [openingBrowserWorkspaceDatabaseSelectionBrand]: true
}

export interface ActiveBrowserWorkspaceDatabaseSelection {
  readonly databaseName: BrowserWorkspaceDatabaseName
  readonly activationSequence: number
  readonly [activeBrowserWorkspaceDatabaseSelectionBrand]: true
}

interface BrowserWorkspaceDatabaseSelectionRecord {
  readonly databaseName: BrowserWorkspaceDatabaseName
  readonly activationSequence: number
  readonly slotLease: BrowserWorkspaceSlotLeaseHandle
  phase: 'opening' | 'active' | 'released'
  releasePromise: Promise<void> | null
}

let selectionPromise: Promise<OpeningBrowserWorkspaceDatabaseSelection> | null = null
let currentSelection: BrowserWorkspaceDatabaseSelectionRecord | null = null

export function prepareBrowserWorkspaceDatabaseSelection(
  authority: BrowserWorkspaceBootstrapAuthority,
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void,
  onBlocked?: (event: IDBVersionChangeEvent) => void,
): Promise<OpeningBrowserWorkspaceDatabaseSelection> {
  assertBrowserWorkspaceBootstrapAuthority(authority)
  if (currentSelection?.phase === 'active') {
    return Promise.reject(new Error('BrowserWorkspaceDatabaseSelectionAlreadyActive'))
  }
  if (selectionPromise) return selectionPromise
  const pending = performBrowserWorkspaceDatabaseSelection(authority, onProgress, onBlocked)
  selectionPromise = pending
  void pending.catch(() => {
    if (selectionPromise === pending) selectionPromise = null
  })
  return pending
}

export function activateBrowserWorkspaceDatabaseSelection(
  selection: OpeningBrowserWorkspaceDatabaseSelection,
  authority: BrowserWorkspaceBootstrapAuthority,
): ActiveBrowserWorkspaceDatabaseSelection {
  assertBrowserWorkspaceBootstrapAuthority(authority)
  const record = selection as unknown as BrowserWorkspaceDatabaseSelectionRecord
  if (currentSelection !== record || record.phase !== 'opening') {
    throw new Error('BrowserWorkspaceDatabaseSelectionTransferInvalid')
  }
  record.phase = 'active'
  selectionPromise = null
  return record as unknown as ActiveBrowserWorkspaceDatabaseSelection
}

export function releaseOpeningBrowserWorkspaceDatabaseSelection(
  selection: OpeningBrowserWorkspaceDatabaseSelection,
): Promise<void> {
  return releaseBrowserWorkspaceDatabaseSelection(
    selection as unknown as BrowserWorkspaceDatabaseSelectionRecord,
    'opening',
  )
}

export function releaseActiveBrowserWorkspaceDatabaseSelection(
  selection: ActiveBrowserWorkspaceDatabaseSelection,
): Promise<void> {
  return releaseBrowserWorkspaceDatabaseSelection(
    selection as unknown as BrowserWorkspaceDatabaseSelectionRecord,
    'active',
  )
}

async function performBrowserWorkspaceDatabaseSelection(
  authority: BrowserWorkspaceBootstrapAuthority,
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void,
  onBlocked?: (event: IDBVersionChangeEvent) => void,
): Promise<OpeningBrowserWorkspaceDatabaseSelection> {
  return selectBrowserWorkspaceDatabase(authority, onProgress, onBlocked)
}

async function selectBrowserWorkspaceDatabase(
  authority: BrowserWorkspaceBootstrapAuthority,
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void,
  onBlocked?: (event: IDBVersionChangeEvent) => void,
): Promise<OpeningBrowserWorkspaceDatabaseSelection> {
  for (;;) {
    assertBrowserWorkspaceBootstrapAuthority(authority)
    onProgress?.({ kind: 'database-selection', operation: 'read-active-slot' })
    const current = await ensureBrowserWorkspaceCurrentForSelection(
      authority.signal,
      onProgress,
      onBlocked,
    )
    assertBrowserWorkspaceBootstrapAuthority(authority)
    onProgress?.({
      kind: 'database-selection',
      operation: 'acquire-active-slot',
      databaseName: current.databaseName,
    })
    const slotLease = await acquireBrowserWorkspaceSlotLease(current.databaseName, authority.signal)
    try {
      assertBrowserWorkspaceBootstrapAuthority(authority)
      onProgress?.({
        kind: 'database-selection',
        operation: 'confirm-active-slot',
        databaseName: current.databaseName,
      })
      const confirmed = await readBrowserWorkspaceDatabaseManifest()
      assertBrowserWorkspaceBootstrapAuthority(authority)
      if (
        confirmed.activeDatabaseName !== current.databaseName ||
        confirmed.activationSequence !== current.activationSequence
      ) {
        onProgress?.({
          kind: 'database-selection',
          operation: 'retry-changed-slot',
          databaseName: current.databaseName,
        })
        await releaseBrowserWorkspaceSlotLease(slotLease)
        continue
      }
      configureBrowserWorkspaceDatabaseName(confirmed.activeDatabaseName, current.physicalVersion)
      const record: BrowserWorkspaceDatabaseSelectionRecord = {
        databaseName: confirmed.activeDatabaseName,
        activationSequence: confirmed.activationSequence,
        slotLease,
        phase: 'opening',
        releasePromise: null,
      }
      currentSelection = record
      return record as unknown as OpeningBrowserWorkspaceDatabaseSelection
    } catch (error) {
      await releaseBrowserWorkspaceSlotLease(slotLease)
      throw error
    }
  }
}

function releaseBrowserWorkspaceDatabaseSelection(
  record: BrowserWorkspaceDatabaseSelectionRecord,
  expectedPhase: 'opening' | 'active',
): Promise<void> {
  if (record.phase === 'released') return record.releasePromise ?? Promise.resolve()
  if (currentSelection !== record || record.phase !== expectedPhase) {
    return Promise.reject(new Error('BrowserWorkspaceDatabaseSelectionOwnerMismatch'))
  }
  record.phase = 'released'
  currentSelection = null
  selectionPromise = null
  const releasing = releaseBrowserWorkspaceSlotLease(record.slotLease)
  record.releasePromise = releasing
  return releasing
}

export function __resetBrowserWorkspaceDatabaseSelectionForTests(): void {
  selectionPromise = null
  currentSelection = null
}
