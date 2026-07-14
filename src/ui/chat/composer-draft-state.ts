import { useCallback, useSyncExternalStore } from 'react'
import type { MessageAttachmentRef } from '../../core/types'

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

const composerDraftTexts = new Map<string, string>()
const composerContextDrafts = new Map<string, ComposerContextDraft>()
const listenersByKey = new Map<string, Set<() => void>>()

export function readComposerDraftText(key: string | null | undefined): string {
  return key ? (composerDraftTexts.get(key) ?? '') : ''
}

export function writeComposerDraftText(key: string | null | undefined, text: string): void {
  if (!key) return
  if (text.length === 0) {
    composerDraftTexts.delete(key)
    return
  }
  composerDraftTexts.set(key, text)
}

export function publishComposerContextDraft(
  key: string | null | undefined,
  draft: ComposerContextDraft,
): void {
  if (!key) return
  if (
    draft.text.length === 0 &&
    draft.prefillText.length === 0 &&
    draft.attachmentRefs.length === 0
  ) {
    if (!composerContextDrafts.delete(key)) return
  } else {
    const current = composerContextDrafts.get(key)
    if (
      current?.text === draft.text &&
      current.prefillText === draft.prefillText &&
      current.attachmentRefs === draft.attachmentRefs
    ) {
      return
    }
    composerContextDrafts.set(key, draft)
  }
  for (const listener of listenersByKey.get(key) ?? []) listener()
}

export function moveComposerDraft(fromKey: string, toKey: string): void {
  const text = composerDraftTexts.get(fromKey)
  composerDraftTexts.delete(fromKey)
  if (text && text.length > 0) composerDraftTexts.set(toKey, text)

  const contextDraft = composerContextDrafts.get(fromKey)
  composerContextDrafts.delete(fromKey)
  if (contextDraft) composerContextDrafts.set(toKey, contextDraft)
  for (const listener of listenersByKey.get(fromKey) ?? []) listener()
  for (const listener of listenersByKey.get(toKey) ?? []) listener()
}

function readComposerContextDraft(key: string | null | undefined): ComposerContextDraft {
  return key ? (composerContextDrafts.get(key) ?? EMPTY_CONTEXT_DRAFT) : EMPTY_CONTEXT_DRAFT
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
      }
    },
    [key],
  )
  const getSnapshot = useCallback(() => readComposerContextDraft(key), [key])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
