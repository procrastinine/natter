import { useCallback, useSyncExternalStore } from 'react'
import type { MessageAttachmentRef } from '../../core/types'
import { browserSessionStorage } from '../../lib/browser-storage'
import {
  COMPOSER_DRAFT_PREFIX,
  registerWorkspaceTabSessionParticipant,
} from '../../store/workspace-tab-session'

export interface ComposerContextDraft {
  text: string
  prefillText: string
  attachmentRefs: readonly MessageAttachmentRef[]
}

const EMPTY_ATTACHMENT_REFS: readonly MessageAttachmentRef[] = Object.freeze([])
const EMPTY_CONTEXT_DRAFT: ComposerContextDraft = Object.freeze({
  text: '',
  prefillText: '',
  attachmentRefs: EMPTY_ATTACHMENT_REFS,
})
const IN_MEMORY_DRAFT_LIMIT = 8
const PERSIST_DEBOUNCE_MS = 250

const draftsByKey = new Map<string, ComposerContextDraft>()
const listenersByKey = new Map<string, Set<() => void>>()
const persistenceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function storageKey(key: string): string {
  return `${COMPOSER_DRAFT_PREFIX}${encodeURIComponent(key)}`
}

function readStoredText(key: string): string {
  const storage = browserSessionStorage()
  if (!storage) return ''
  try {
    const value = storage.getItem(storageKey(key))
    return value ?? ''
  } catch {
    return ''
  }
}

function persistText(key: string, text: string): void {
  const timer = persistenceTimers.get(key)
  if (timer !== undefined) {
    clearTimeout(timer)
    persistenceTimers.delete(key)
  }
  const storage = browserSessionStorage()
  if (!storage) return
  try {
    if (text.length === 0) storage.removeItem(storageKey(key))
    else storage.setItem(storageKey(key), text)
  } catch {
    // Draft persistence is best-effort; the active in-memory draft remains authoritative.
  }
}

function scheduleTextPersistence(key: string, text: string): void {
  const current = persistenceTimers.get(key)
  if (current !== undefined) clearTimeout(current)
  persistenceTimers.set(
    key,
    setTimeout(() => persistText(key, text), PERSIST_DEBOUNCE_MS),
  )
}

function trimInactiveDrafts(): void {
  if (draftsByKey.size <= IN_MEMORY_DRAFT_LIMIT) return
  for (const [key, draft] of draftsByKey) {
    if (listenersByKey.has(key)) continue
    persistText(key, draft.text)
    draftsByKey.delete(key)
    if (draftsByKey.size <= IN_MEMORY_DRAFT_LIMIT) return
  }
}

function readComposerDraft(key: string): ComposerContextDraft {
  const cached = draftsByKey.get(key)
  if (cached) {
    draftsByKey.delete(key)
    draftsByKey.set(key, cached)
    return cached
  }
  const text = readStoredText(key)
  if (text.length === 0) return EMPTY_CONTEXT_DRAFT
  const draft = Object.freeze({ ...EMPTY_CONTEXT_DRAFT, text })
  draftsByKey.set(key, draft)
  trimInactiveDrafts()
  return draft
}

function publishDraft(key: string, draft: ComposerContextDraft): void {
  const empty =
    draft.text.length === 0 && draft.prefillText.length === 0 && draft.attachmentRefs.length === 0
  if (empty) {
    draftsByKey.delete(key)
    persistText(key, '')
  } else {
    draftsByKey.delete(key)
    draftsByKey.set(key, Object.freeze(draft))
    scheduleTextPersistence(key, draft.text)
  }
  trimInactiveDrafts()
  for (const listener of listenersByKey.get(key) ?? []) listener()
}

export function readComposerDraftText(key: string | null | undefined): string {
  return key ? readComposerDraft(key).text : ''
}

export function writeComposerDraftText(key: string | null | undefined, text: string): void {
  if (!key) return
  const current = readComposerDraft(key)
  if (current.text === text) return
  publishDraft(key, { ...current, text })
}

export function publishComposerContextDraft(
  key: string | null | undefined,
  draft: Omit<ComposerContextDraft, 'text'>,
): void {
  if (!key) return
  const current = readComposerDraft(key)
  if (
    current.prefillText === draft.prefillText &&
    current.attachmentRefs === draft.attachmentRefs
  ) {
    return
  }
  publishDraft(key, { ...current, ...draft })
}

export function moveComposerDraft(fromKey: string, toKey: string): void {
  const draft = readComposerDraft(fromKey)
  clearComposerDraft(fromKey)
  if (draft !== EMPTY_CONTEXT_DRAFT) publishDraft(toKey, draft)
}

function clearComposerDraft(key: string): void {
  draftsByKey.delete(key)
  const timer = persistenceTimers.get(key)
  if (timer !== undefined) clearTimeout(timer)
  persistenceTimers.delete(key)
  const storage = browserSessionStorage()
  if (storage) {
    try {
      storage.removeItem(storageKey(key))
    } catch {
      // The in-memory state is still cleared when browser storage is unavailable.
    }
  }
  for (const listener of listenersByKey.get(key) ?? []) listener()
}

function clearAllComposerDrafts(): void {
  draftsByKey.clear()
  for (const timer of persistenceTimers.values()) clearTimeout(timer)
  persistenceTimers.clear()
  const storage = browserSessionStorage()
  if (storage) {
    try {
      const keys: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key?.startsWith(COMPOSER_DRAFT_PREFIX)) keys.push(key)
      }
      for (const key of keys) storage.removeItem(key)
    } catch {
      // The in-memory state is still cleared when browser storage is unavailable.
    }
  }
  for (const listeners of listenersByKey.values()) {
    for (const listener of listeners) listener()
  }
}

function flushPendingComposerDrafts(): void {
  for (const [key, draft] of draftsByKey) {
    if (!persistenceTimers.has(key)) continue
    persistText(key, draft.text)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingComposerDrafts)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingComposerDrafts()
  })
}

registerWorkspaceTabSessionParticipant({
  resetWorkspace: clearAllComposerDrafts,
  deleteChat: (chatId) => clearComposerDraft(`chat:${chatId}`),
})

function readComposerContextDraft(key: string | null | undefined): ComposerContextDraft {
  return key ? readComposerDraft(key) : EMPTY_CONTEXT_DRAFT
}

export function useComposerContextDraft(key: string | null | undefined): ComposerContextDraft {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {}
      const listeners = listenersByKey.get(key) ?? new Set<() => void>()
      listeners.add(listener)
      listenersByKey.set(key, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) listenersByKey.delete(key)
        trimInactiveDrafts()
      }
    },
    [key],
  )
  const getSnapshot = useCallback(() => readComposerContextDraft(key), [key])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
