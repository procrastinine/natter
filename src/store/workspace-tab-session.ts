import type { ChatId } from '../core/types'
import { browserSessionStorage } from '../lib/browser-storage'
import type { WorkspaceFence } from './repository'

const WORKSPACE_FENCE_KEY = 'natter:workspace-tab-session:v3'
export const CONVERSATION_SESSION_PREFIX = 'natter:conversation-session:'
export const COMPOSER_DRAFT_PREFIX = 'natter:composer-draft:'
export const ACTIVE_CONFIGURATION_SEED_KEY = 'natter:active-seed'

export interface WorkspaceTabSessionParticipant {
  resetWorkspace(): void
  deleteChat?(chatId: ChatId): void
}

export interface WorkspaceTabSessionSnapshot {
  readonly revision: number
  readonly fence: WorkspaceFence | null
}

const workspaceParticipants = new Set<WorkspaceTabSessionParticipant>()
const listeners = new Set<() => void>()
const claimedOneShotNotices = new Set<string>()
let reconciledWorkspaceFence: string | null = null
let revision = 0
let snapshot: WorkspaceTabSessionSnapshot = Object.freeze({ revision, fence: null })

export function getWorkspaceTabSessionSnapshot(): WorkspaceTabSessionSnapshot {
  return snapshot
}

export function subscribeWorkspaceTabSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function registerWorkspaceTabSessionParticipant(
  participant: WorkspaceTabSessionParticipant,
): () => void {
  workspaceParticipants.add(participant)
  return () => workspaceParticipants.delete(participant)
}

export function deleteChatFromWorkspaceTabSession(chatId: ChatId): void {
  for (const participant of [...workspaceParticipants]) participant.deleteChat?.(chatId)
}

export function claimWorkspaceTabOneShotNotice(key: string): boolean {
  if (claimedOneShotNotices.has(key)) return false
  const storage = browserSessionStorage()
  if (storage) {
    try {
      if (storage.getItem(key)) {
        claimedOneShotNotices.add(key)
        return false
      }
      storage.setItem(key, '1')
    } catch {
      // The in-memory claim still guarantees one delivery for this mounted tab.
    }
  }
  claimedOneShotNotices.add(key)
  return true
}

export function workspaceTabSessionMatches(fence: WorkspaceFence): boolean {
  const encodedFence = JSON.stringify([fence.workspaceId, fence.replacementEpoch])
  return (reconciledWorkspaceFence ?? readStoredWorkspaceFence()) === encodedFence
}

export function reconcileWorkspaceTabSessionStorage(fence: WorkspaceFence): void {
  const encodedFence = JSON.stringify([fence.workspaceId, fence.replacementEpoch])
  if (reconciledWorkspaceFence === encodedFence) return
  const storedFence = readStoredWorkspaceFence()
  const replaced = storedFence !== encodedFence
  if (replaced) {
    try {
      const storage = browserSessionStorage()
      if (!storage) throw new Error('SessionStorageUnavailable')
      storage.removeItem(ACTIVE_CONFIGURATION_SEED_KEY)
      const workspaceSessionKeys: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (
          key?.startsWith(COMPOSER_DRAFT_PREFIX) ||
          key?.startsWith(CONVERSATION_SESSION_PREFIX)
        ) {
          workspaceSessionKeys.push(key)
        }
      }
      for (const key of workspaceSessionKeys) storage.removeItem(key)
      storage.setItem(WORKSPACE_FENCE_KEY, encodedFence)
    } catch {
      // The compound workspace fence remains authoritative when tab storage is unavailable.
    }
  }
  reconciledWorkspaceFence = encodedFence
  revision += 1
  snapshot = Object.freeze({ revision, fence: Object.freeze({ ...fence }) })
  if (replaced) {
    for (const participant of [...workspaceParticipants]) participant.resetWorkspace()
  }
  for (const listener of [...listeners]) listener()
}

function readStoredWorkspaceFence(): string | null {
  const storage = browserSessionStorage()
  if (!storage) return null
  try {
    return storage.getItem(WORKSPACE_FENCE_KEY)
  } catch {
    return null
  }
}
