import { act, fireEvent, render } from '@testing-library/react'
import { type ComponentProps, useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageTreeProjection } from '../../src/core/active-path'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message, MessageId } from '../../src/core/types'
import { useStableStructuralHeaders } from '../../src/hooks/useBranchUrlSync'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import type { ActiveBranchWindowSnapshot } from '../../src/store/repository'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { __setMessageRenderProbeForTests } from '../../src/ui/chat/Message'
import {
  __setMessageListIndexProbeForTests,
  MessageList as MessageListComponent,
} from '../../src/ui/chat/MessageList'
import { __setReasoningPartitionProbeForTests } from '../../src/ui/chat/ReasoningBlock'

vi.mock('../../src/ui/chat/MarkdownView', () => ({
  MarkdownView: ({ content }: { content: string }) => <span>{content}</span>,
}))
vi.mock('../../src/ui/attachments/AttachmentRefChips', () => ({ AttachmentRefChips: () => null }))
vi.mock('../../src/ui/chat/ToolEvidenceBlock', () => ({ ToolEvidenceBlock: () => null }))

interface Counts {
  messageRenders: Map<MessageId, number>
  reasoningPartitions: number
  listIndexes: string[]
}

function emptyCounts(): Counts {
  return {
    messageRenders: new Map(),
    reasoningPartitions: 0,
    listIndexes: [],
  }
}

let counts = emptyCounts()

function MessageList(
  props: Omit<ComponentProps<typeof MessageListComponent>, 'treeProjection'> & {
    navigationHeaders: readonly MessageHeaderRow[]
  },
) {
  const { navigationHeaders, ...listProps } = props
  const structuralHeaders = useStableStructuralHeaders(navigationHeaders)
  const treeProjection = useMemo(() => {
    counts.listIndexes.push('tree-projection')
    return createMessageTreeProjection(structuralHeaders)
  }, [structuralHeaders])
  return <MessageListComponent {...listProps} treeProjection={treeProjection} />
}

beforeEach(() => {
  counts = emptyCounts()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  useToastStore.getState().reset()
  useUiStore.getState().reset()
  __setMessageRenderProbeForTests((messageId) => {
    counts.messageRenders.set(messageId, (counts.messageRenders.get(messageId) ?? 0) + 1)
  })
  __setReasoningPartitionProbeForTests(() => {
    counts.reasoningPartitions += 1
  })
  __setMessageListIndexProbeForTests((operation) => counts.listIndexes.push(operation))
})

afterEach(() => {
  __setMessageRenderProbeForTests(undefined)
  __setReasoningPartitionProbeForTests(undefined)
  __setMessageListIndexProbeForTests(undefined)
})

describe('message-list accessibility', () => {
  it('exposes new transcript entries through an additions-only log', () => {
    const fixture = branchFixture(2)
    const view = render(
      <MessageList
        chatId="chat-performance"
        chatSettings={cloneDefaultChatSettings()}
        hasConnection
        messageRenderWindowSize={100}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={fixture.first}
        navigationHeaders={fixture.navigationHeaders}
        onLoadOlderMessages={() => {}}
      />,
    )

    const log = view.getByRole('log')
    expect(log).toHaveAttribute('data-ui', 'message-list')
    expect(log).toHaveAttribute('aria-live', 'polite')
    expect(log).toHaveAttribute('aria-relevant', 'additions')
  })

  it('keeps retained presentation snapshots inert beyond the DOM attribute', () => {
    const fixture = branchFixture(2)
    const initialCursor = {
      __root__: 'message-0',
      'message-0': 'message-1',
    }
    useChatStore.getState().navigateToCursor('chat-performance', initialCursor)
    const view = render(
      <MessageList
        chatId="chat-performance"
        chatSettings={cloneDefaultChatSettings()}
        hasConnection
        messageRenderWindowSize={100}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={fixture.first}
        navigationHeaders={fixture.navigationHeaders}
        authoritativePathHeaders={fixture.first.branchHeaders}
        presentationOnly
        onLoadOlderMessages={() => {}}
      />,
    )

    const log = view.getByRole('log')
    expect(log).toHaveAttribute('aria-live', 'off')
    const focusedAction = view.container.querySelector<HTMLButtonElement>(
      '[data-message-id="message-1"] [data-action="copy"]',
    )
    if (!focusedAction) throw new Error('missing retained message action')
    fireEvent.focus(focusedAction)
    fireEvent.keyDown(window, { key: ']' })
    expect(useChatStore.getState().getCursor('chat-performance')).toEqual(initialCursor)

    const infoAction = view.container.querySelector<HTMLButtonElement>(
      '[data-message-id="message-1"] [data-action="info"]',
    )
    if (!infoAction) throw new Error('missing retained message info action')
    fireEvent.click(infoAction)
    expect(view.container.querySelector('[data-ui="message-info"]')).toBeNull()
  })

  it('uses authoritative path headers for structural transcript metadata', () => {
    const fixture = branchFixture(2)
    const first = fixture.first.branchHeaders[0]
    const second = fixture.first.branchHeaders[1]
    if (!first || !second) throw new Error('missing branch headers')
    const authoritativePath = [
      first,
      { ...second, role: 'user' as const, hiddenFromContext: true },
      toHeader(makeMessage('message-2', second.id, 'assistant', 0, 2)),
    ]
    const view = render(
      <MessageList
        chatId="chat-performance"
        chatSettings={cloneDefaultChatSettings()}
        hasConnection
        messageRenderWindowSize={100}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={fixture.first}
        navigationHeaders={fixture.navigationHeaders}
        authoritativePathHeaders={authoritativePath}
        onLoadOlderMessages={() => {}}
      />,
    )

    expect(view.getByRole('log')).toHaveAttribute('data-total-count', '3')
    expect(
      view.container.querySelector(
        '[data-message-id="message-1"] [data-ui="message-role-mismatch"]',
      ),
    ).not.toBeNull()
    expect(
      view.container.querySelector('[data-message-id="message-1"] [data-ui="profile-glyph"]'),
    ).toHaveAttribute('data-excluded', 'true')
  })
})

describe('message-list render budgets', () => {
  it('does not rebuild structural indexes for body-only raw header publications', () => {
    const fixture = branchFixture(12)
    const settings = cloneDefaultChatSettings()
    const renderList = (navigationHeaders: readonly MessageHeaderRow[]) => (
      <MessageList
        chatId="chat-performance"
        chatSettings={settings}
        hasConnection
        messageRenderWindowSize={100}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={fixture.first}
        navigationHeaders={navigationHeaders}
        onLoadOlderMessages={() => {}}
      />
    )
    const view = render(renderList(fixture.navigationHeaders))
    expect(counts.listIndexes).toEqual(['tree-projection', 'path-index'])

    counts = emptyCounts()
    const bodyOnlyHeaders = fixture.navigationHeaders.map((header) => ({
      ...header,
      nodeVersion: header.nodeVersion + 1,
      textPreview: `Updated body preview for ${header.id}`,
    }))
    view.rerender(renderList(bodyOnlyHeaders))
    expect(counts.listIndexes).toEqual([])

    counts = emptyCounts()
    const structuralHeaders = bodyOnlyHeaders.map((header, index) =>
      index === 1 ? { ...header, siblingIndex: header.siblingIndex + 1 } : header,
    )
    view.rerender(renderList(structuralHeaders))
    expect(counts.listIndexes).toEqual(['tree-projection'])
  })

  it('uses hydrated window bodies for context rings while branch headers stay cold', () => {
    const fixture = branchFixture(3)
    const settings = {
      ...cloneDefaultChatSettings(),
      customMaxContext: 10,
      maxCompletionTokens: 0,
    }
    const view = render(
      <MessageList
        chatId="chat-performance"
        chatSettings={settings}
        hasConnection
        messageRenderWindowSize={100}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={fixture.first}
        navigationHeaders={fixture.navigationHeaders}
        onLoadOlderMessages={() => {}}
      />,
    )

    expect(
      view.container.querySelector('[data-message-id="message-0"] [data-ui="profile-glyph"]'),
    ).toHaveAttribute('data-excluded', 'true')
    expect(
      view.container.querySelector('[data-message-id="message-2"] [data-ui="profile-glyph"]'),
    ).not.toHaveAttribute('data-excluded')
  })

  it('does not guess context rings for unestimated cold rows outside the body window', () => {
    const fixture = branchFixture(3)
    const newest = fixture.active.at(-1)
    if (!newest) throw new Error('missing newest branch message')
    const windowed = {
      ...fixture.first,
      branchWindow: [newest],
      windowOffset: 2,
      windowLimit: 1,
    }
    const settings = {
      ...cloneDefaultChatSettings(),
      customMaxContext: 10,
      maxCompletionTokens: 0,
    }
    const view = render(
      <MessageList
        chatId="chat-performance"
        chatSettings={settings}
        hasConnection
        messageRenderWindowSize={1}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={windowed}
        navigationHeaders={fixture.navigationHeaders}
        onLoadOlderMessages={() => {}}
      />,
    )

    expect(view.container.querySelectorAll('[data-ui="message"]')).toHaveLength(1)
    expect(view.container.querySelector('[data-ui="profile-glyph"]')).not.toHaveAttribute(
      'data-excluded',
    )
  })

  it('isolates branch, stream, focus, and reasoning-disclosure work', () => {
    const fixture = branchFixture(12)
    const settings = cloneDefaultChatSettings()
    const view = render(
      <MessageList
        chatId="chat-performance"
        chatSettings={settings}
        hasConnection
        messageRenderWindowSize={100}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={fixture.first}
        navigationHeaders={fixture.navigationHeaders}
        onLoadOlderMessages={() => {}}
      />,
    )
    expect(totalMessageRenders()).toBe(12)
    expect(counts.reasoningPartitions).toBe(1)
    expect(counts.listIndexes).toEqual(['tree-projection', 'path-index'])

    counts = emptyCounts()
    const nextVariant = view.container.querySelector<HTMLAnchorElement>(
      '[data-ui="branch-controls"] [data-role="next"]',
    )
    if (!nextVariant) throw new Error('expected branch control')
    fireEvent.click(nextVariant)
    const cursorChange = snapshotCounts()

    counts = emptyCounts()
    view.rerender(
      <MessageList
        chatId="chat-performance"
        chatSettings={settings}
        hasConnection
        messageRenderWindowSize={100}
        messageRenderWindowLoadMode="manual"
        branchSnapshot={fixture.second}
        navigationHeaders={fixture.navigationHeaders}
        onLoadOlderMessages={() => {}}
      />,
    )
    const branchChange = snapshotCounts()

    counts = emptyCounts()
    const streamTarget = fixture.active[5]
    if (!streamTarget) throw new Error('missing stream target')
    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'stream-performance',
        replacementEpoch: 0,
        chatId: streamTarget.chatId,
        messageId: streamTarget.id,
        startedAt: 100,
        ownerClientId: 'test-client',
      })
      useStreamStore.getState().setLiveSnapshot({
        streamId: 'stream-performance',
        replacementEpoch: 0,
        chatId: streamTarget.chatId,
        messageId: streamTarget.id,
        content: [{ type: 'text', text: 'live update' }],
        textLength: 11,
        reasoningLength: 0,
        updatedAt: 101,
      })
    })
    const streamChange = snapshotCounts()

    counts = emptyCounts()
    const focusTarget = view.container.querySelector<HTMLButtonElement>(
      `[data-message-id="${fixture.active[2]?.id}"] [data-action="copy"]`,
    )
    if (!focusTarget) throw new Error('missing focus target')
    fireEvent.focus(focusTarget)
    const focusChange = snapshotCounts()

    counts = emptyCounts()
    const reasoning = view.container.querySelector<HTMLDetailsElement>(
      `[data-message-id="${streamTarget.id}"] [data-ui="reasoning"]`,
    )
    if (!reasoning) throw new Error('missing reasoning disclosure')
    reasoning.open = true
    fireEvent(reasoning, new Event('toggle', { bubbles: true }))
    const disclosureChange = snapshotCounts()

    expect(cursorChange).toEqual({
      messageRenders: 0,
      renderedIds: [],
      reasoningPartitions: 0,
      listIndexes: [],
    })
    expect(branchChange).toEqual({
      messageRenders: 1,
      renderedIds: ['alternate-11'],
      reasoningPartitions: 0,
      listIndexes: ['path-index'],
    })
    expect(streamChange).toEqual({
      messageRenders: 2,
      renderedIds: ['message-5'],
      reasoningPartitions: 0,
      listIndexes: [],
    })
    expect(focusChange).toEqual({
      messageRenders: 0,
      renderedIds: [],
      reasoningPartitions: 0,
      listIndexes: [],
    })
    expect(disclosureChange).toEqual({
      messageRenders: 0,
      renderedIds: [],
      reasoningPartitions: 0,
      listIndexes: [],
    })
  })
})

function branchFixture(count: number): {
  active: Message[]
  navigationHeaders: MessageHeaderRow[]
  first: ActiveBranchWindowSnapshot
  second: ActiveBranchWindowSnapshot
} {
  const active: Message[] = []
  const alternates: Message[] = []
  let parentId: MessageId | null = null
  for (let index = 0; index < count; index += 1) {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const message = makeMessage(`message-${index}`, parentId, role, 0, index)
    const alternate = makeMessage(`alternate-${index}`, parentId, role, 1, index)
    if (index === 5) {
      message.reasoningDetails = [
        { type: 'reasoning.text', id: 'reasoning-performance', text: 'measured reasoning' },
      ]
      alternate.reasoningDetails = message.reasoningDetails
    }
    active.push(message)
    alternates.push(alternate)
    parentId = message.id
  }
  const all = active.flatMap((message, index) => [message, alternates[index] as Message])
  const secondBranch = [...active.slice(0, -1), alternates.at(-1) as Message]
  return {
    active,
    navigationHeaders: all.map(toHeader),
    first: snapshot(active, all),
    second: snapshot(secondBranch, all),
  }
}

function makeMessage(
  id: MessageId,
  parentId: MessageId | null,
  role: Message['role'],
  siblingIndex: number,
  turnIndex: number,
): Message {
  return {
    id,
    chatId: 'chat-performance',
    parentId,
    siblingIndex,
    turnId: `turn-${turnIndex}`,
    turnIndex,
    createdAt: turnIndex,
    role,
    origin: role === 'assistant' ? 'generated' : 'user',
    content: [{ type: 'text', text: `${role} ${id}` }],
    nodeVersion: 0,
    deleted: false,
  }
}

function snapshot(branch: readonly Message[], all: readonly Message[]): ActiveBranchWindowSnapshot {
  const allHeaders = all.map(toHeader)
  const branchHeadersById = new Map(allHeaders.map((header) => [header.id, header]))
  return {
    chatId: 'chat-performance',
    branchWindow: branch.map((message) => structuredClone(message)),
    branchHeaders: branch.map((message) => branchHeadersById.get(message.id) as MessageHeaderRow),
    windowOffset: 0,
    windowLimit: branch.length,
    branchLength: branch.length,
  }
}

function toHeader(message: Message): MessageHeaderRow {
  const {
    content: _content,
    reasoningDetails: _reasoningDetails,
    toolCalls: _toolCalls,
    refusal: _refusal,
    phase: _phase,
    responsesEchoItem: _responsesEchoItem,
    providerOutputItems: _providerOutputItems,
    continuationAttempts: _continuationAttempts,
    ...header
  } = structuredClone(message)
  return {
    ...header,
    requestContextVersion: message.nodeVersion,
    bodyVersion: message.nodeVersion,
    bodyWordCount: 0,
    textPreview: `${message.role} ${message.id}`,
  }
}

function totalMessageRenders(): number {
  return [...counts.messageRenders.values()].reduce((sum, value) => sum + value, 0)
}

function snapshotCounts() {
  return {
    messageRenders: totalMessageRenders(),
    renderedIds: [...counts.messageRenders.keys()],
    reasoningPartitions: counts.reasoningPartitions,
    listIndexes: [...counts.listIndexes],
  }
}
