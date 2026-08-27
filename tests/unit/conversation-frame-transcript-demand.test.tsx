import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
  it('claims body-window demand only when the transcript renderer is available', () => {
    const controller = new TranscriptDemandController()
    const budget = initialTranscriptWorkBudget(10, 360)
    const firstReady: ConversationTranscriptDemand = {
      chatId: 'chat-1',
      selectionRevision: 1,
      selectionEpoch: 0,
      budget,
    }
    const view = render(
      <Harness
        controller={controller as unknown as ConversationController}
        demand={null}
        rendererAvailable={false}
      />,
    )

    expect(controller.lastDemand()).toBeNull()

    view.rerender(
      <Harness
        controller={controller as unknown as ConversationController}
        demand={firstReady}
        rendererAvailable={false}
      />,
    )
    expect(controller.lastDemand()).toBeNull()
    view.rerender(
      <Harness
        controller={controller as unknown as ConversationController}
        demand={firstReady}
        rendererAvailable
      />,
    )
    expect(controller.lastDemand()).toBe(firstReady)
    const callsAfterFirstReady = controller.demandCallCount()

    const nextReady = { ...firstReady }
    view.rerender(
      <Harness
        controller={controller as unknown as ConversationController}
        demand={nextReady}
        rendererAvailable
      />,
    )
    expect(controller.lastDemand()).toBe(nextReady)
    expect(controller.demandCallCount()).toBe(callsAfterFirstReady + 1)

    view.unmount()
    expect(controller.lastDemand()).toBeNull()
  })

  it('releases body-window demand when the renderer capability leaves', () => {
    const controller = new TranscriptDemandController()
    const demand: ConversationTranscriptDemand = {
      chatId: 'chat-hidden',
      selectionRevision: 1,
      selectionEpoch: 0,
      budget: initialTranscriptWorkBudget(10, 360),
    }

    const view = render(
      <Harness
        controller={controller as unknown as ConversationController}
        demand={demand}
        rendererAvailable
      />,
    )

    expect(controller.lastDemand()).toBe(demand)
    view.rerender(
      <Harness
        controller={controller as unknown as ConversationController}
        demand={demand}
        rendererAvailable={false}
      />,
    )
    expect(controller.lastDemand()).toBeNull()
    view.unmount()
    expect(controller.lastDemand()).toBeNull()
  })
})

function Harness({
  controller,
  demand,
  rendererAvailable,
}: {
  controller: ConversationController
  demand: ConversationTranscriptDemand | null
  rendererAvailable: boolean
}) {
  useConversationTranscriptDemand(demand, controller, rendererAvailable)
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
