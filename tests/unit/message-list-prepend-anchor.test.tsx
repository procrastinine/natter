import { fireEvent, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageTreeProjection } from '../../src/core/active-path'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message, MessageId } from '../../src/core/types'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import type { ActiveBranchWindowSnapshot } from '../../src/store/repository'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { MessageList } from '../../src/ui/chat/MessageList'

vi.mock('../../src/ui/chat/MarkdownView', () => ({
  MarkdownView: ({ content }: { content: string }) => <span>{content}</span>,
}))
vi.mock('../../src/ui/attachments/AttachmentRefChips', () => ({ AttachmentRefChips: () => null }))
vi.mock('../../src/ui/chat/ToolEvidenceBlock', () => ({ ToolEvidenceBlock: () => null }))

beforeEach(() => {
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  useToastStore.getState().reset()
  useUiStore.getState().reset()
})

describe('message-list prepend viewport anchor', () => {
  it('survives an append publication before the requested older window arrives', () => {
    const initial = linearMessages(4)
    const appended = [...initial, makeMessage(4, initial.at(-1)?.id ?? null)]
    const onLoadOlderMessages = vi.fn()
    const view = renderList(windowSnapshot(initial, 2), onLoadOlderMessages)
    const scrollRegion = view.container.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    const retained = view.container.querySelector<HTMLElement>('[data-message-id="message-2"]')
    if (!scrollRegion || !retained) throw new Error('missing prepend anchor fixture')

    let retainedLayoutTop = 100
    retained.getBoundingClientRect = () =>
      domRect({ top: retainedLayoutTop - scrollRegion.scrollTop })
    const retainedNode = retained

    fireEvent.click(view.getByRole('button', { name: 'Load more' }))
    expect(onLoadOlderMessages).toHaveBeenCalledTimes(1)

    view.rerender(renderListElement(windowSnapshot(appended, 2), onLoadOlderMessages))
    expect(view.container.querySelector('[data-message-id="message-2"]')).toBe(retainedNode)
    expect(scrollRegion.scrollTop).toBe(0)

    retainedLayoutTop = 300
    view.rerender(renderListElement(windowSnapshot(appended, 0), onLoadOlderMessages))

    expect(view.container.querySelector('[data-message-id="message-2"]')).toBe(retainedNode)
    expect(scrollRegion.scrollTop).toBe(200)
  })
})

function renderList(snapshot: ActiveBranchWindowSnapshot, onLoadOlderMessages: () => void) {
  return render(renderListElement(snapshot, onLoadOlderMessages))
}

function renderListElement(snapshot: ActiveBranchWindowSnapshot, onLoadOlderMessages: () => void) {
  return (
    <div data-ui="scroll-region">
      <MessageList
        chatId="chat-prepend-anchor"
        chatSettings={cloneDefaultChatSettings()}
        hasConnection
        messageRenderWindowSize={2}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={snapshot}
        treeProjection={createMessageTreeProjection(snapshot.branchHeaders)}
        onLoadOlderMessages={onLoadOlderMessages}
      />
    </div>
  )
}

function linearMessages(count: number): Message[] {
  const messages: Message[] = []
  for (let index = 0; index < count; index += 1) {
    messages.push(makeMessage(index, messages.at(-1)?.id ?? null))
  }
  return messages
}

function makeMessage(index: number, parentId: MessageId | null): Message {
  const role = index % 2 === 0 ? 'user' : 'assistant'
  return {
    id: `message-${index}`,
    chatId: 'chat-prepend-anchor',
    parentId,
    siblingIndex: 0,
    turnId: `turn-${index}`,
    turnIndex: index,
    createdAt: index,
    role,
    origin: role === 'assistant' ? 'generated' : 'user',
    content: [{ type: 'text', text: `message ${index}` }],
    nodeVersion: 0,
    deleted: false,
  }
}

function windowSnapshot(
  branch: readonly Message[],
  windowOffset: number,
): ActiveBranchWindowSnapshot {
  return {
    chatId: 'chat-prepend-anchor',
    branchWindow: branch.slice(windowOffset),
    branchHeaders: branch.map(toHeader),
    windowOffset,
    windowLimit: Math.max(1, branch.length - windowOffset),
    branchLength: branch.length,
  }
}

function toHeader(message: Message): MessageHeaderRow {
  const { content: _content, ...header } = structuredClone(message)
  return {
    ...header,
    requestContextVersion: message.nodeVersion,
    bodyVersion: message.nodeVersion,
    bodyWordCount: 2,
    textPreview: `message ${message.turnIndex}`,
  }
}

function domRect({ top }: { top: number }): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    right: 0,
    bottom: top,
    left: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  }
}
