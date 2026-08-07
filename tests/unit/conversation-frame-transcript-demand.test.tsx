import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialTranscriptWorkBudget } from '../../src/core/transcript-work-budget'
import {
  type ConversationTranscriptDemand,
  useConversationTranscriptDemand,
} from '../../src/hooks/useConversationFrame'
import type {
  ConversationController,
  TranscriptDemand,
} from '../../src/store/conversation-controller'

describe('conversation transcript demand phases', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('claims body-window demand after the destination paint boundary without releasing admitted work', () => {
    const frames = installFrameHarness()
    const controller = new TranscriptDemandController()
    const budget = initialTranscriptWorkBudget(10, 360)
    const firstReady: ConversationTranscriptDemand = {
      chatId: 'chat-1',
      selectionRevision: 1,
      selectionEpoch: 0,
      budget,
    }
    const view = render(
      <Harness controller={controller as unknown as ConversationController} demand={null} />,
    )

    expect(controller.lastDemand()).toBeNull()

    view.rerender(
      <Harness controller={controller as unknown as ConversationController} demand={firstReady} />,
    )
    expect(controller.lastDemand()).toBeNull()
    frames.flush()
    expect(controller.lastDemand()).toBeNull()
    frames.flush()
    expect(controller.lastDemand()).toBe(firstReady)
    const callsAfterFirstReady = controller.demandCallCount()

    const nextReady = { ...firstReady }
    view.rerender(
      <Harness controller={controller as unknown as ConversationController} demand={nextReady} />,
    )
    expect(controller.lastDemand()).toBe(firstReady)
    frames.flush()
    expect(controller.lastDemand()).toBe(firstReady)
    frames.flush()
    expect(controller.lastDemand()).toBe(nextReady)
    expect(controller.demandCallCount()).toBe(callsAfterFirstReady + 1)

    view.unmount()
    expect(controller.lastDemand()).toBeNull()
  })

  it('claims body-window demand immediately when the document cannot paint frames', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const frames = installFrameHarness()
    const controller = new TranscriptDemandController()
    const demand: ConversationTranscriptDemand = {
      chatId: 'chat-hidden',
      selectionRevision: 1,
      selectionEpoch: 0,
      budget: initialTranscriptWorkBudget(10, 360),
    }

    const view = render(
      <Harness controller={controller as unknown as ConversationController} demand={demand} />,
    )

    expect(controller.lastDemand()).toBe(demand)
    expect(frames.pending()).toBe(0)
    view.unmount()
    expect(controller.lastDemand()).toBeNull()
  })
})

function installFrameHarness(): { flush(): void; pending(): number } {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId
    nextId += 1
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    callbacks.delete(id)
  })
  return {
    flush: () => {
      const current = [...callbacks]
      callbacks.clear()
      for (const [, callback] of current) callback(performance.now())
    },
    pending: () => callbacks.size,
  }
}

function Harness({
  controller,
  demand,
}: {
  controller: ConversationController
  demand: ConversationTranscriptDemand | null
}) {
  useConversationTranscriptDemand(demand, controller)
  return null
}

class TranscriptDemandController {
  private demand: TranscriptDemand | null = null
  private demandCalls = 0

  setTranscriptDemand = (_owner: object, demand: TranscriptDemand | null) => {
    this.demand = demand
    this.demandCalls += 1
  }

  lastDemand() {
    return this.demand
  }

  demandCallCount() {
    return this.demandCalls
  }
}
