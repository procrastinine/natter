import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import {
  DEFAULT_RENDERING_PREFS,
  type RenderingPreferences,
} from '../../src/core/rendering-preferences'
import { RenderingSettings } from '../../src/ui/settings/RenderingSettings'
import { installPresentationWorkspaceFence } from '../helpers/presentation-interactions'

const preferenceState = vi.hoisted<{
  rendering: RenderingPreferences | null
  writes: Partial<RenderingPreferences>
}>(() => ({ rendering: null, writes: {} }))

vi.mock('../../src/hooks/useConfigurationPreferences', () => {
  return {
    useConfigurationPreferences: () => ({
      global: DEFAULT_GLOBAL_PREFERENCES,
      rendering: preferenceState.rendering,
    }),
  }
})

vi.mock('../../src/store/configuration-application', () => ({
  configurationApplication: {
    async patchRenderingPreferences(patch: Partial<RenderingPreferences>) {
      Object.assign(preferenceState.writes, patch)
      preferenceState.rendering = {
        ...(preferenceState.rendering ?? DEFAULT_RENDERING_PREFS),
        ...patch,
      }
    },
  },
}))

beforeEach(() => {
  installPresentationWorkspaceFence('rendering-settings')
  preferenceState.rendering = { ...DEFAULT_RENDERING_PREFS }
  preferenceState.writes = {}
})

describe('RenderingSettings', () => {
  it('shows single-dollar math disabled by default', () => {
    render(<RenderingSettings />)
    expect(screen.getByLabelText('Single-dollar LaTeX markdown')).not.toBeChecked()
  })

  it('shows single-newline hard breaks disabled by default', () => {
    render(<RenderingSettings />)
    expect(screen.getByLabelText('Single newline as line break')).not.toBeChecked()
  })

  it('writes the single-dollar math preference when toggled', async () => {
    render(<RenderingSettings />)
    fireEvent.click(screen.getByLabelText('Single-dollar LaTeX markdown'))
    await waitFor(() => {
      expect(preferenceState.writes).toMatchObject({
        singleDollarTextMath: true,
      })
    })
  })

  it('writes the single-newline hard-break preference when toggled', async () => {
    render(<RenderingSettings />)
    fireEvent.click(screen.getByLabelText('Single newline as line break'))
    await waitFor(() => {
      expect(preferenceState.writes).toMatchObject({
        singleNewlineHardBreaks: true,
      })
    })
  })
})
