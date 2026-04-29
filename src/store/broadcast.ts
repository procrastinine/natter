// Cross-tab broadcast channel. See `plan/03-storage.md §3.6`.
//
// BroadcastChannel delivers messages to OTHER tabs only — the sender never
// receives its own `postMessage`. For same-tab-within-a-module fan-out
// UI listeners need to fire on local writes too, so `postEvent` dispatches
// locally and also crosses the channel. The two paths never double-fire because
// remote tabs only see the BroadcastChannel path and local tabs only see the
// direct dispatch (their own BC instance ignores their own posts).

import type {
  ChatId,
  FolderId,
  KeyId,
  PresetId,
  ProfileId,
  PromptPresetId,
  TagId,
} from '../core/types'
import type { ChatMutationSummary, StreamLeaseRow } from './repository'

type EngineKind = 'daemon' | 'in-tab'
type AutoTitleStatus = 'auto' | 'auto-failed' | 'manual'
type StreamOutcome = 'done' | 'error' | 'abort'
type EngineDetachReason = 'daemon-offline' | 'tab-close' | 'shutdown'

export type BroadcastEvent =
  | {
      kind: 'chat-mutated'
      chatId: ChatId
      metaVersion: number
      summaryVersion: number
      affected: ChatMutationSummary[]
    }
  | { kind: 'chat-deleted'; chatId: ChatId }
  | { kind: 'branch-cache-refreshed'; chatId: ChatId }
  | { kind: 'profile-mutated'; profileId: ProfileId }
  | { kind: 'profile-deleted'; profileId: ProfileId }
  | { kind: 'preset-mutated'; presetId: PresetId }
  | { kind: 'preset-deleted'; presetId: PresetId }
  | { kind: 'prompt-preset-mutated'; promptPresetId: PromptPresetId }
  | { kind: 'prompt-preset-deleted'; promptPresetId: PromptPresetId }
  | { kind: 'folder-mutated'; folderId: FolderId }
  | { kind: 'folder-deleted'; folderId: FolderId }
  | { kind: 'tag-mutated'; tagId: TagId }
  | { kind: 'tag-deleted'; tagId: TagId }
  | { kind: 'autotitle-completed'; chatId: ChatId; status: AutoTitleStatus }
  | { kind: 'key-rotated'; keyId: KeyId }
  | { kind: 'settings-mutated'; key: string }
  | { kind: 'privacy-refreshed'; profileId: ProfileId; modelId: string }
  | { kind: 'models-refreshed'; profileId: ProfileId }
  | {
      kind: 'stream-started'
      chatId: ChatId
      streamId: string
      messageId?: string
      ownerClientId: string
    }
  | { kind: 'stream-heartbeat'; lease: StreamLeaseRow }
  | {
      kind: 'stream-abort-requested'
      chatId: ChatId
      streamId: string
      ownerClientId: string
    }
  | {
      kind: 'stream-ended'
      chatId: ChatId
      streamId: string
      messageId?: string
      outcome: StreamOutcome
    }
  | { kind: 'engine-attached'; engineKind: EngineKind; version: string }
  | { kind: 'engine-detached'; reason: EngineDetachReason }

type BroadcastHandler = (event: BroadcastEvent) => void

const CHANNEL_NAME = 'llm-api-frontend'

let channel: BroadcastChannel | null = null
const localSubs = new Set<BroadcastHandler>()

function ensureChannel(): BroadcastChannel | null {
  if (channel !== null) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  channel.addEventListener('message', (msg: MessageEvent) => {
    fanOutLocal(msg.data as BroadcastEvent)
  })
  return channel
}

function fanOutLocal(event: BroadcastEvent): void {
  for (const handler of localSubs) {
    handler(event)
  }
}

export function postEvent(event: BroadcastEvent): void {
  const bc = ensureChannel()
  bc?.postMessage(event)
  fanOutLocal(event)
}

export function onEvent(handler: BroadcastHandler): () => void {
  ensureChannel()
  localSubs.add(handler)
  return () => {
    localSubs.delete(handler)
  }
}

export function __resetBroadcastForTests(): void {
  channel?.close()
  channel = null
  localSubs.clear()
}
