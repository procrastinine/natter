// Ephemeral UI state. Per-tab only — not persisted to IDB and not broadcast.
// See `plan/03-storage.md §3.9`.
//
// Persistent UI preferences (theme choice, sidebar collapsed state, composer
// fullscreen) live in the `settings` IDB table and hydrate into this store on
// mount. That hydration is Phase 7+; this module only shapes the store.

import { create } from 'zustand'
import type { ChatId, ChatSettings, PresetId } from '../../core/types'

type ThemePreference = 'light' | 'dark' | 'system'

// Settings for the next chat the user starts on /new. Seeded from the MRU
// preset when the surface mounts; edits in the model panel flow here so
// the user can configure a chat before typing the first message. On send
// these get passed into createChat.
interface DraftChatSettings {
  settings: ChatSettings
  presetId: PresetId | null
}

interface UiStoreState {
  theme: ThemePreference
  sidebarCollapsed: boolean
  activeChatId: ChatId | null
  composerFullscreen: boolean
  // Edit-tree mode toggle per §10.6.1. Applies globally across open chats
  // because the user's mental model is "editing the structure of the
  // current conversation"; switching chats re-uses the same mode.
  editTreeMode: boolean
  // Cascade-delete checkbox state inside Edit-tree toolbar. UI-local; resets
  // whenever the mode toggles off per §10.6.1.
  cascadeDelete: boolean
  // "Reading mode" — hides every piece of UI chrome (sidebar, headers,
  // composer, jump-to-latest) so only the message list + a small
  // re-entry toggle remain visible. Toggled via the floating eye icon
  // at the bottom-left of the viewport.
  focusMode: boolean
  // In-memory settings for the next chat, so the chat-model panel works
  // on /new before anything is persisted. Null means "not yet seeded".
  draftChat: DraftChatSettings | null
  // Chat id whose privacy filter left zero eligible providers; triggers
  // the zero-eligible modal per §10.13.1. Cleared by any of the three
  // quick-fix actions (switch model / disable Pareto / allow fallbacks)
  // or by explicit dismiss. Only the chat id is stored, the modal reads
  // the live `usePrivacyRouting` result so it shows the current filter
  // decision, not a stale snapshot.
  zeroEligibleChatId: ChatId | null
  // Session-scoped banner dismissals. The BYOK banner is surfaced per
  // profile; dismissing it stores the profile id here so the banner
  // stays hidden for the life of the tab. A hard reload re-surfaces it
  // (user can re-dismiss). Persisting dismiss-per-profile forever would
  // be surprising the day the user actually wants to act on it.
  dismissedBanners: { kind: 'byok'; profileId: string }[]
  setTheme: (theme: ThemePreference) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setActiveChatId: (chatId: ChatId | null) => void
  setComposerFullscreen: (fullscreen: boolean) => void
  setEditTreeMode: (on: boolean) => void
  setCascadeDelete: (on: boolean) => void
  setFocusMode: (on: boolean) => void
  setDraftChat: (value: DraftChatSettings | null) => void
  patchDraftSettings: (patch: Partial<ChatSettings>) => void
  setZeroEligibleChatId: (chatId: ChatId | null) => void
  dismissBanner: (entry: { kind: 'byok'; profileId: string }) => void
  reset: () => void
}

const INITIAL: Pick<
  UiStoreState,
  | 'theme'
  | 'sidebarCollapsed'
  | 'activeChatId'
  | 'composerFullscreen'
  | 'editTreeMode'
  | 'cascadeDelete'
  | 'focusMode'
  | 'draftChat'
  | 'zeroEligibleChatId'
  | 'dismissedBanners'
> = {
  theme: 'system',
  sidebarCollapsed: false,
  activeChatId: null,
  composerFullscreen: false,
  editTreeMode: false,
  cascadeDelete: false,
  focusMode: false,
  draftChat: null,
  zeroEligibleChatId: null,
  dismissedBanners: [],
}

export const useUiStore = create<UiStoreState>((set) => ({
  ...INITIAL,
  setTheme: (theme) => set({ theme }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setActiveChatId: (activeChatId) => set({ activeChatId }),
  setComposerFullscreen: (composerFullscreen) => set({ composerFullscreen }),
  setEditTreeMode: (on) =>
    set((state) => ({
      editTreeMode: on,
      // Exiting edit-tree mode always clears cascade (§10.6.1 "resets when the mode is toggled off").
      cascadeDelete: on ? state.cascadeDelete : false,
    })),
  setCascadeDelete: (on) => set({ cascadeDelete: on }),
  setFocusMode: (on) => set({ focusMode: on }),
  setDraftChat: (value) => set({ draftChat: value }),
  patchDraftSettings: (patch) =>
    set((state) => {
      if (!state.draftChat) return state
      return {
        draftChat: {
          ...state.draftChat,
          settings: { ...state.draftChat.settings, ...patch },
        },
      }
    }),
  setZeroEligibleChatId: (zeroEligibleChatId) => set({ zeroEligibleChatId }),
  dismissBanner: (entry) =>
    set((state) => {
      if (
        state.dismissedBanners.some((d) => d.kind === entry.kind && d.profileId === entry.profileId)
      ) {
        return state
      }
      return { dismissedBanners: [...state.dismissedBanners, entry] }
    }),
  reset: () => set(INITIAL),
}))
