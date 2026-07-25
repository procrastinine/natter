// Per-tab toast + banner feed. Everything ephemeral: not persisted, not
// broadcast. Consumed by Shell's `<ToastTray>` and inline banner callers.
//
// Two surfaces:
//   - `toasts[]`: 5-second auto-dismiss notices ("Deleted pair", "Linked
//     message gone…"). Each may carry a single undo handler that the tray
//     renders as an "Undo" button.
//   - `banners[]`: non-auto-dismiss inline banners (chat-not-found,
//     mutation-conflict). The caller decides when to dismiss.
//
// Shape is intentionally small: no "tone" beyond `level`. A separate,
// always-mounted live region announces notice events; the visual cards do not.

import { create } from 'zustand'
import { useAnnouncementStore } from './announcementStore'

type ToastLevel = 'info' | 'success' | 'warning' | 'danger'

interface Toast {
  id: string
  level: ToastLevel
  text: string
  // Optional "Undo" callback. Tray renders the button when this is set.
  undo?: () => void | Promise<void>
  // Auto-dismiss duration in ms. Defaults to 5000 on push.
  durationMs: number
  // Monotonic createdAt — used for stable ordering and time-based dismiss.
  createdAt: number
  actionState?: NoticeActionState<'undo'>
}

type BannerKind = 'chat-not-found' | 'mutation-conflict' | 'stale-edit' | 'stale-reasoning'
type BannerAction = () => void | boolean | Promise<void> | Promise<boolean>

interface Banner {
  id: string
  kind: BannerKind
  text: string
  // Optional primary action (e.g. "Return to home", "Retry").
  primary?: { label: string; action: BannerAction }
  // Optional secondary action (e.g. "Dismiss", "Cancel").
  secondary?: { label: string; action: BannerAction }
  actionState?: NoticeActionState<'primary' | 'secondary'>
}

interface NoticeActionState<TKey extends string> {
  key: TKey
  pending: boolean
  error?: string
}

interface ToastStoreState {
  toasts: Toast[]
  banners: Banner[]
  push: (
    t: Omit<Toast, 'id' | 'createdAt' | 'durationMs' | 'actionState'> & {
      durationMs?: number
    },
  ) => string
  dismissToast: (id: string) => void
  runToastAction: (id: string) => Promise<boolean>
  pushBanner: (b: Omit<Banner, 'id' | 'actionState'>) => string
  dismissBanner: (id: string) => void
  runBannerAction: (id: string, key: 'primary' | 'secondary') => Promise<boolean>
  clearBannersByKind: (kind: BannerKind) => void
  reset: () => void
}

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}`
}

const ACTION_FAILED_MESSAGE = 'Action failed. Try again.'
const MAX_VISUAL_TOASTS = 24
const MAX_VISUAL_BANNERS = 24

export const useToastStore = create<ToastStoreState>((set, get) => ({
  toasts: [],
  banners: [],
  push: (t) => {
    const id = nextId('toast')
    const toast: Toast = {
      id,
      level: t.level,
      text: t.text,
      ...(t.undo ? { undo: t.undo } : {}),
      durationMs: t.durationMs ?? 5000,
      createdAt: Date.now(),
    }
    set((state) => ({
      toasts: [...state.toasts, toast].slice(-MAX_VISUAL_TOASTS),
    }))
    useAnnouncementStore.getState().announce({
      text: toast.text,
      priority: toast.level === 'danger' ? 'assertive' : 'polite',
      eventKey: toast.id,
    })
    return id
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) })),
  runToastAction: async (id) => {
    const toast = get().toasts.find((candidate) => candidate.id === id)
    if (!toast?.undo || toast.actionState?.pending) return false
    set((state) => ({
      toasts: state.toasts.map((candidate) =>
        candidate.id === id
          ? { ...candidate, actionState: { key: 'undo', pending: true } }
          : candidate,
      ),
    }))
    try {
      await toast.undo()
    } catch {
      set((state) => ({
        toasts: state.toasts.map((candidate) =>
          candidate.id === id
            ? {
                ...candidate,
                actionState: { key: 'undo', pending: false, error: ACTION_FAILED_MESSAGE },
              }
            : candidate,
        ),
      }))
      useAnnouncementStore.getState().announce({
        text: ACTION_FAILED_MESSAGE,
        priority: 'assertive',
      })
      return false
    }
    set((state) => ({ toasts: state.toasts.filter((candidate) => candidate.id !== id) }))
    useAnnouncementStore.getState().announce({ text: 'Delete undone.' })
    return true
  },
  pushBanner: (b) => {
    const id = nextId('banner')
    set((state) => ({
      banners: [...state.banners, { ...b, id }].slice(-MAX_VISUAL_BANNERS),
    }))
    useAnnouncementStore.getState().announce({ text: b.text, eventKey: id })
    return id
  },
  dismissBanner: (id) => set((state) => ({ banners: state.banners.filter((x) => x.id !== id) })),
  runBannerAction: async (id, key) => {
    const banner = get().banners.find((candidate) => candidate.id === id)
    const action = banner?.[key]?.action
    if (!banner || !action || banner.actionState?.pending) return false
    set((state) => ({
      banners: state.banners.map((candidate) =>
        candidate.id === id ? { ...candidate, actionState: { key, pending: true } } : candidate,
      ),
    }))
    try {
      const consumed = await action()
      if (consumed === false) {
        set((state) => ({
          banners: state.banners.map((candidate) =>
            candidate.id === id
              ? { ...candidate, actionState: { key, pending: false } }
              : candidate,
          ),
        }))
        return false
      }
    } catch {
      set((state) => ({
        banners: state.banners.map((candidate) =>
          candidate.id === id
            ? {
                ...candidate,
                actionState: { key, pending: false, error: ACTION_FAILED_MESSAGE },
              }
            : candidate,
        ),
      }))
      useAnnouncementStore.getState().announce({
        text: ACTION_FAILED_MESSAGE,
        priority: 'assertive',
      })
      return false
    }
    set((state) => ({ banners: state.banners.filter((candidate) => candidate.id !== id) }))
    return true
  },
  clearBannersByKind: (kind) =>
    set((state) => ({ banners: state.banners.filter((x) => x.kind !== kind) })),
  reset: () => {
    useAnnouncementStore.getState().reset()
    set({ toasts: [], banners: [] })
  },
}))
