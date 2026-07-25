import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import { AppearanceSettings } from '../../src/ui/settings/AppearanceSettings'
import { installPresentationWorkspaceFence } from '../helpers/presentation-interactions'

const preferenceState = vi.hoisted<{
  value: unknown
  writes: Map<string, unknown>
}>(() => ({ value: null, writes: new Map() }))

vi.mock('../../src/hooks/useConfigurationPreferences', () => {
  return { useConfigurationPreferences: () => preferenceState.value }
})

vi.mock('../../src/store/preferences-application', () => {
  const write = (key: string) => async (value: unknown) => {
    preferenceState.writes.set(key, value)
  }
  return {
    writeTheme: write('global:theme'),
    writeChatMaxWidth: write('global:chat-max-width'),
    writeFontFamily: write('global:font-family'),
    writeBaseFontSize: write('global:base-font-size'),
    writeLongMessageDisplayMode: write('global:long-message-display-mode'),
  }
})

beforeEach(() => {
  installPresentationWorkspaceFence('appearance-settings')
  preferenceState.writes.clear()
  preferenceState.value = {
    global: DEFAULT_GLOBAL_PREFERENCES,
    rendering: DEFAULT_RENDERING_PREFS,
  }
  document.documentElement.style.removeProperty('--message-max-width')
})

describe('AppearanceSettings', () => {
  it('does not apply fallback layout preferences while storage is still loading', () => {
    preferenceState.value = null

    render(<AppearanceSettings />)

    expect(screen.queryByLabelText(/Chat width/, { selector: 'input' })).not.toBeInTheDocument()
    expect(document.documentElement.style.getPropertyValue('--message-max-width')).toBe('')
  })

  it('persists chat width immediately when the slider changes', async () => {
    render(<AppearanceSettings />)
    const slider = screen.getByLabelText(/Chat width/, { selector: 'input' })

    fireEvent.change(slider, { target: { value: '960' } })

    await waitFor(() => {
      expect(preferenceState.writes.get('global:chat-max-width')).toBe(960)
    })
    expect(document.documentElement.style.getPropertyValue('--message-max-width')).toBe('960px')
  })

  it('persists the long-message default display mode', async () => {
    render(<AppearanceSettings />)
    fireEvent.change(screen.getByLabelText('Long messages', { selector: 'select' }), {
      target: { value: 'compact' },
    })

    await waitFor(() => {
      expect(preferenceState.writes.get('global:long-message-display-mode')).toBe('compact')
    })
  })
})
