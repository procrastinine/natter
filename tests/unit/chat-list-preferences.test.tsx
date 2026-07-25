import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import { DEFAULT_SIDEBAR_SORT_MODE } from '../../src/core/sidebar-sort'
import { ConfigurationPreferencesContext } from '../../src/hooks/useConfigurationPreferences'
import type { ConfigurationPreferencesProjection } from '../../src/store/workspace-protocol'
import { ChatList } from '../../src/ui/sidebar/ChatList'

describe('ChatList configuration preferences', () => {
  it('accepts a newer canonical sidebar render preference after bootstrap without remounting', () => {
    const initial = preferences(50)
    const view = render(
      <ConfigurationPreferencesContext.Provider value={initial}>
        <ChatList activeChatId={null} />
      </ConfigurationPreferencesContext.Provider>,
    )
    const list = view.container.querySelector('[data-ui="chat-list"]')
    expect(list).toHaveAttribute('data-render-window-size', '50')

    view.rerender(
      <ConfigurationPreferencesContext.Provider value={preferences(73)}>
        <ChatList activeChatId={null} />
      </ConfigurationPreferencesContext.Provider>,
    )

    expect(view.container.querySelector('[data-ui="chat-list"]')).toBe(list)
    expect(list).toHaveAttribute('data-render-window-size', '73')
  })
})

function preferences(sidebarRenderWindowSize: number): ConfigurationPreferencesProjection {
  return {
    global: { ...DEFAULT_GLOBAL_PREFERENCES, sidebarRenderWindowSize },
    rendering: { ...DEFAULT_RENDERING_PREFS },
    sidebarSortMode: DEFAULT_SIDEBAR_SORT_MODE,
    collapsedFolderIds: [],
    imageAllowlist: [],
    samplePromptsDismissed: false,
  }
}
