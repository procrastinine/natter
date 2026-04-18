// Ephemeral UI state. Per-tab only — not persisted to IDB and not broadcast.
// See `plan/03-storage.md §3.9`.
//
// Persistent UI preferences (theme choice, sidebar collapsed state, composer
// fullscreen) live in the `settings` IDB table and hydrate into this store on
// mount. That hydration is Phase 7+; here we only shape the store.

import { create } from 'zustand'
import type { ChatId } from '../../core/types'

export type ThemePreference = 'light' | 'dark' | 'system'

export interface UiStoreState {
  theme: ThemePreference
  sidebarCollapsed: boolean
  activeChatId: ChatId | null
  composerFullscreen: boolean
  setTheme: (theme: ThemePreference) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setActiveChatId: (chatId: ChatId | null) => void
  setComposerFullscreen: (fullscreen: boolean) => void
  reset: () => void
}

const INITIAL: Pick<
  UiStoreState,
  'theme' | 'sidebarCollapsed' | 'activeChatId' | 'composerFullscreen'
> = {
  theme: 'system',
  sidebarCollapsed: false,
  activeChatId: null,
  composerFullscreen: false,
}

export const useUiStore = create<UiStoreState>((set) => ({
  ...INITIAL,
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setActiveChatId: (activeChatId) => set({ activeChatId }),
  setComposerFullscreen: (composerFullscreen) => set({ composerFullscreen }),
  reset: () => set(INITIAL),
}))
