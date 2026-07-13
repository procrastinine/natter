import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  announceGenerationOutcome,
  useAnnouncementStore,
} from '../../src/store/zustand/announcementStore'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { BannerTray } from '../../src/ui/chat/BannerTray'
import { ToastTray } from '../../src/ui/chat/ToastTray'
import { LiveRegions } from '../../src/ui/primitives/LiveRegions'

function liveLane(container: HTMLElement, priority: 'polite' | 'assertive'): HTMLElement {
  const lane = container.querySelector<HTMLElement>(
    `[data-role="live-region"][data-priority="${priority}"]`,
  )
  if (!lane) throw new Error(`missing ${priority} live region`)
  return lane
}

beforeEach(() => {
  vi.useFakeTimers()
  useToastStore.getState().reset()
  useAnnouncementStore.getState().reset()
})

afterEach(() => {
  useToastStore.getState().reset()
  useAnnouncementStore.getState().reset()
  vi.useRealTimers()
})

describe('LiveRegions', () => {
  it('keeps both empty announcement lanes mounted before the first event', () => {
    const view = render(<LiveRegions />)

    expect(liveLane(view.container, 'polite')).toHaveAttribute('role', 'status')
    expect(liveLane(view.container, 'polite')).toHaveAttribute('aria-live', 'polite')
    expect(liveLane(view.container, 'assertive')).toHaveAttribute('role', 'alert')
    expect(liveLane(view.container, 'assertive')).toHaveAttribute('aria-live', 'assertive')
  })

  it('speaks queued events in order and repeats identical text from distinct events', () => {
    const view = render(<LiveRegions />)
    const lane = liveLane(view.container, 'polite')

    act(() => {
      useAnnouncementStore.getState().announce({ text: 'Saved.' })
      useAnnouncementStore.getState().announce({ text: 'Saved.' })
    })
    expect(useAnnouncementStore.getState().polite).toHaveLength(2)
    expect(lane).toHaveTextContent('')

    act(() => {
      vi.advanceTimersByTime(40)
    })
    expect(lane).toHaveTextContent('Saved.')

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(lane).toHaveTextContent('')

    act(() => {
      vi.advanceTimersByTime(40)
    })
    expect(lane).toHaveTextContent('Saved.')

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(lane).toHaveTextContent('')
    expect(useAnnouncementStore.getState().polite).toEqual([])
  })

  it('deduplicates a repeated event key without deduplicating its text globally', () => {
    const first = useAnnouncementStore
      .getState()
      .announce({ text: 'Assistant is responding.', eventKey: 'stream-1' })
    const duplicate = useAnnouncementStore
      .getState()
      .announce({ text: 'Assistant is responding.', eventKey: 'stream-1' })
    const otherStream = useAnnouncementStore
      .getState()
      .announce({ text: 'Assistant is responding.', eventKey: 'stream-2' })

    expect(first).not.toBeNull()
    expect(duplicate).toBeNull()
    expect(otherStream).not.toBeNull()
    expect(useAnnouncementStore.getState().polite).toHaveLength(2)
  })

  it('routes terminal generation outcomes once per stream while leaving completion silent', () => {
    announceGenerationOutcome('stream-done', 'done')
    announceGenerationOutcome('stream-abort', 'abort')
    announceGenerationOutcome('stream-abort', 'abort')
    announceGenerationOutcome('stream-error', 'error')
    announceGenerationOutcome('stream-error', 'error')

    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toEqual([
      'Generation stopped. Partial response kept.',
    ])
    expect(useAnnouncementStore.getState().assertive.map((event) => event.text)).toEqual([
      'Response failed. Partial response kept if available.',
    ])
  })

  it('is the only live-region owner for visual toasts and banners', () => {
    const view = render(
      <>
        <LiveRegions />
        <ToastTray />
        <BannerTray />
      </>,
    )

    act(() => {
      useToastStore.getState().push({ level: 'danger', text: 'Request failed.' })
      useToastStore.getState().pushBanner({ kind: 'mutation-conflict', text: 'Conflict.' })
    })

    expect(view.container.querySelectorAll('[aria-live]')).toHaveLength(2)
    expect(view.container.querySelector('[data-ui="toast-tray"]')).toHaveAttribute(
      'aria-label',
      'Notifications',
    )
    expect(view.container.querySelector('[data-ui="toast"]')).not.toHaveAttribute('role')
    expect(view.container.querySelector('[data-ui="banner"]')).not.toHaveAttribute('role')
    expect(view.container.querySelector('[data-ui="toast-action-error"]')).toBeNull()
    expect(view.container.querySelector('[data-ui="banner-action-error"]')).toBeNull()
  })
})
