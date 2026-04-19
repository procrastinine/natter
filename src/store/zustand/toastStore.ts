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
// Shape is intentionally small: no "tone" beyond `level` because the
// renderers read the banner role directly.

import { create } from 'zustand'

export type ToastLevel = 'info' | 'success' | 'warning' | 'danger'

export interface Toast {
  id: string
  level: ToastLevel
  text: string
  // Optional "Undo" callback. Tray renders the button when this is set.
  undo?: () => void | Promise<void>
  // Auto-dismiss duration in ms. Defaults to 5000 on push.
  durationMs: number
  // Monotonic createdAt — used for stable ordering and time-based dismiss.
  createdAt: number
}

export type BannerKind = 'chat-not-found' | 'mutation-conflict' | 'stale-edit'

export interface Banner {
  id: string
  kind: BannerKind
  text: string
  // Optional primary action (e.g. "Return to home", "Retry").
  primary?: { label: string; action: () => void | Promise<void> }
  // Optional secondary action (e.g. "Dismiss", "Cancel").
  secondary?: { label: string; action: () => void | Promise<void> }
}

export interface ToastStoreState {
  toasts: Toast[]
  banners: Banner[]
  push: (t: Omit<Toast, 'id' | 'createdAt' | 'durationMs'> & { durationMs?: number }) => string
  dismissToast: (id: string) => void
  pushBanner: (b: Omit<Banner, 'id'>) => string
  dismissBanner: (id: string) => void
  clearBannersByKind: (kind: BannerKind) => void
  reset: () => void
}

let counter = 0
function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}`
}

export const useToastStore = create<ToastStoreState>((set) => ({
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
    set((state) => ({ toasts: [...state.toasts, toast] }))
    return id
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((x) => x.id !== id) })),
  pushBanner: (b) => {
    const id = nextId('banner')
    set((state) => ({ banners: [...state.banners, { ...b, id }] }))
    return id
  },
  dismissBanner: (id) => set((state) => ({ banners: state.banners.filter((x) => x.id !== id) })),
  clearBannersByKind: (kind) =>
    set((state) => ({ banners: state.banners.filter((x) => x.kind !== kind) })),
  reset: () => set({ toasts: [], banners: [] }),
}))
