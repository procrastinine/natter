import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import { DEFAULT_SIDEBAR_SORT_MODE } from '../../src/core/sidebar-sort'
import { ConfigurationPreferencesContext } from '../../src/hooks/useConfigurationPreferences'
import { EmptyState } from '../../src/ui/chat/EmptyState'

function renderWithPreferences(children: ReactNode, samplePromptsDismissed = false) {
  return render(
    <ConfigurationPreferencesContext.Provider
      value={{
        global: DEFAULT_GLOBAL_PREFERENCES,
        rendering: DEFAULT_RENDERING_PREFS,
        sidebarSortMode: DEFAULT_SIDEBAR_SORT_MODE,
        collapsedFolderIds: [],
        imageAllowlist: [],
        samplePromptsDismissed,
      }}
    >
      {children}
    </ConfigurationPreferencesContext.Provider>,
  )
}

describe('EmptyState', () => {
  it('renders sample prompts and populates the composer via the callback', async () => {
    const onPick = vi.fn()
    renderWithPreferences(<EmptyState onPick={onPick} />)
    expect(screen.getByText(/Explain to a beginner/i)).toBeTruthy()
    fireEvent.click(screen.getByText(/Explain to a beginner/i))
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick.mock.calls[0]?.[0]).toMatch(/TCP congestion control/i)
  })

  it('dismissed state hides the prompt grid and offers a restore button', () => {
    const onPick = vi.fn()
    renderWithPreferences(<EmptyState onPick={onPick} />, true)
    expect(screen.queryByText(/Explain to a beginner/i)).toBeNull()
    expect(screen.getByText(/Show sample prompts/i)).toBeTruthy()
  })
})
