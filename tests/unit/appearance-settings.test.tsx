import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { AppearanceSettings } from '../../src/ui/settings/AppearanceSettings'

const liveQueryState = vi.hoisted<{ value: unknown }>(() => ({
  value: undefined,
}))

vi.mock('../../src/store/settings', () => {
  const state = new Map<string, unknown>()
  return {
    async getSetting<T>(key: string): Promise<T | undefined> {
      return state.get(key) as T | undefined
    },
    async setSetting<T>(key: string, value: T): Promise<void> {
      state.set(key, value)
    },
    __get(key: string): unknown {
      return state.get(key)
    },
    __reset(): void {
      state.clear()
    },
  }
})

vi.mock('../../src/store/reactive-query', () => {
  return {
    useRepositoryQuery: <T,>(_key: string, _query: () => Promise<T>, initial: T): T => initial,
    useRepositoryQueryState: <T,>(_key: string, _query: () => Promise<T>, initial: T) =>
      liveQueryState.value === undefined
        ? { status: 'loading', value: initial, error: null }
        : { status: 'ready', value: liveQueryState.value as T, error: null },
  }
})

beforeEach(async () => {
  const mod = (await import('../../src/store/settings')) as unknown as { __reset(): void }
  mod.__reset()
  liveQueryState.value = DEFAULT_GLOBAL_PREFERENCES
  document.documentElement.style.removeProperty('--message-max-width')
})

describe('AppearanceSettings', () => {
  it('does not apply fallback layout preferences while storage is still loading', () => {
    liveQueryState.value = undefined

    render(<AppearanceSettings />)

    expect(screen.queryByLabelText(/Chat width/, { selector: 'input' })).not.toBeInTheDocument()
    expect(document.documentElement.style.getPropertyValue('--message-max-width')).toBe('')
  })

  it('persists chat width immediately when the slider changes', async () => {
    render(<AppearanceSettings />)
    const slider = screen.getByLabelText(/Chat width/, { selector: 'input' })

    fireEvent.change(slider, { target: { value: '960' } })

    const mod = (await import('../../src/store/settings')) as unknown as {
      __get(key: string): unknown
    }
    await waitFor(() => {
      expect(mod.__get('global:chat-max-width')).toBe(960)
    })
    expect(document.documentElement.style.getPropertyValue('--message-max-width')).toBe('960px')
  })

  it('persists the long-message default display mode', async () => {
    render(<AppearanceSettings />)
    fireEvent.change(screen.getByLabelText('Long messages', { selector: 'select' }), {
      target: { value: 'compact' },
    })

    const mod = (await import('../../src/store/settings')) as unknown as {
      __get(key: string): unknown
    }
    await waitFor(() => {
      expect(mod.__get('global:long-message-display-mode')).toBe('compact')
    })
  })
})
