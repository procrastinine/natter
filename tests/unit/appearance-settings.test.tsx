import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceSettings } from '../../src/ui/settings/AppearanceSettings'

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

vi.mock('dexie-react-hooks', () => {
  return {
    useLiveQuery: <T,>(_query: () => Promise<T>, _deps: unknown[], initial: T): T | undefined => {
      return initial
    },
  }
})

beforeEach(async () => {
  const mod = (await import('../../src/store/settings')) as unknown as { __reset(): void }
  mod.__reset()
  document.documentElement.style.removeProperty('--message-max-width')
})

describe('AppearanceSettings', () => {
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
