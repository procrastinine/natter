import { describe, expect, it } from 'vitest'
import {
  createActiveBranchSpineFromPath,
  emptyActiveBranchChildSlot,
} from '../../src/core/active-branch-spine'
import type { BranchPathDescriptor } from '../../src/core/branch-session'
import { createBranchPath, emptyBranchPath } from '../../src/core/branch-session'
import { messageTreeIndexFields } from '../../src/core/message-tree-index'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS } from '../../src/core/reasoning'
import type { Chat } from '../../src/core/types'
import { selectPromptEstimateContextForTarget } from '../../src/hooks/usePromptEstimateContext'
import type { ConversationChatSnapshot } from '../../src/store/conversation-controller'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import type { PromptEstimateContextSnapshot } from '../../src/store/presentation-contracts'
import {
  acceptedSettingsContextPath,
  settingsContextPathQueryIdentity,
} from '../../src/ui/settings/ChatModelPanel'

describe('ChatModelPanel context freshness', () => {
  it('accepts the authoritative non-empty active path without consulting tree topology', () => {
    const header = messageHeader('message-a', 3)
    const path = createBranchPath([header])
    const frame = conversationFrame(path, header.id, true)

    expect(acceptedSettingsContextPath(frame)).toBe(path)
  })

  it('distinguishes an unresolved synthetic empty path from a resolved empty chat', () => {
    const path = emptyBranchPath<MessageHeaderRow>()

    expect(acceptedSettingsContextPath(conversationFrame(path, null, false))).toBeNull()
    expect(acceptedSettingsContextPath(conversationFrame(path, null, true))).toBe(path)
  })

  it('rejects a path that has not yet reached the selected leaf', () => {
    const path = createBranchPath([messageHeader('message-a', 1)])

    expect(acceptedSettingsContextPath(conversationFrame(path, 'message-b', true))).toBeNull()
  })

  it('keeps the send-context query owner stable across equivalent path publications', () => {
    const identities = Array.from({ length: 20 }, () =>
      settingsContextPathQueryIdentity(true, ['message-a', 'message-b'], ['attachment-a']),
    )

    expect(new Set(identities)).toEqual(new Set([identities[0]]))
    expect(settingsContextPathQueryIdentity(false, [], [])).toBe('pending')
    expect(settingsContextPathQueryIdentity(true, ['message-a'], ['attachment-a'])).not.toBe(
      identities[0],
    )
    expect(settingsContextPathQueryIdentity(true, ['message-a', 'message-b'], [])).not.toBe(
      identities[0],
    )
  })

  it('never exposes a same-chat context publication for a different settings route', () => {
    const value = {} as PromptEstimateContextSnapshot
    const target = {
      key: 'responses-without-encrypted-reasoning',
      chat: { id: 'chat-a' } as Chat,
    }

    expect(
      selectPromptEstimateContextForTarget(target, {
        targetKey: 'responses-with-encrypted-reasoning',
        chatId: 'chat-a',
        value,
      }),
    ).toBeNull()
    expect(
      selectPromptEstimateContextForTarget(target, {
        targetKey: target.key,
        chatId: 'chat-a',
        value,
      }),
    ).toBe(value)
  })
})

function conversationFrame(
  path: BranchPathDescriptor<MessageHeaderRow>,
  selectionTargetId: string | null,
  ready: boolean,
): ConversationChatSnapshot {
  const emptyMap = new Map()
  return {
    chatId: 'chat-a',
    chat: null,
    selectionRevision: 1,
    transcriptSelectionEpoch: 1,
    viewportRevision: 1,
    selectionTargetId,
    destination: ready
      ? {
          kind: 'ready',
          spine: createActiveBranchSpineFromPath({
            chatId: 'chat-a',
            structuralVersion: 0,
            resolvedLeafId: path.leaf?.id ?? null,
            path,
            terminalChildSlot: emptyActiveBranchChildSlot(path.leaf?.id ?? null),
          }),
        }
      : { kind: 'unresolved', retained: null },
    headerFacts: {
      get: (messageId) => path.get(messageId),
      has: (messageId) => path.has(messageId),
    },
    structuralTopology: {
      nodes: [],
      byParent: emptyMap,
      liveByParent: emptyMap,
      byId: emptyMap,
    },
    headerChangeRevision: 0,
    changedHeaderKeys: [],
    get topologyLoaded(): never {
      throw new Error('TreeTopologyMustStayCold')
    },
    transcript: { kind: 'absent', selectionEpoch: 1, resolving: false },
    inspector: { exact: null, retained: null, resolving: false },
    previews: emptyMap,
    failure: null,
    presentation: {
      request: { revision: 1, surface: 'transcript' },
      visibleReady: false,
      painted: null,
      residents: { transcript: null, tree: null },
      editorRetention: null,
      target: { kind: 'pending', surface: 'transcript', blocker: 'transcript' },
      mounted: { transcript: false, tree: false },
    },
  }
}

function messageHeader(id: string, bodyVersion: number): MessageHeaderRow {
  return {
    id,
    chatId: 'chat-a',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn-a',
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    nodeVersion: bodyVersion,
    requestContextVersion: 0,
    bodyVersion,
    bodyWordCount: 1,
    bodyTextCharCount: 1,
    bodyMediaCount: 0,
    bodyRenderCost: 1,
    contextRouteFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
    deleted: false,
    ...messageTreeIndexFields({ parentId: null, deleted: false }),
  }
}
