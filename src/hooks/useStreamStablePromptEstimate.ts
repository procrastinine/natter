import { useDeferredValue, useMemo, useRef } from 'react'
import type { MessageTreeNode } from '../core/active-path'
import type { BranchPathDescriptor } from '../core/branch-session'
import {
  estimatePromptSize,
  type PromptSizeEstimate,
  type PromptSizeEstimateInput,
  promptEstimateInputSignature,
} from '../core/prompt-size'
import type { ChatId } from '../core/types'

function frozenMessageIdsFromActivityKey(activityKey: string): ReadonlySet<string> {
  if (activityKey.length === 0) return EMPTY_MESSAGE_IDS
  return new Set(
    activityKey
      .split('|')
      .filter((part) => part.startsWith('m:'))
      .map((part) => part.slice(2))
      .filter(Boolean),
  )
}

const EMPTY_MESSAGE_IDS = new Set<string>()

interface CachedEstimate {
  chatId: ChatId | null
  signature: string
  value: PromptSizeEstimate | null
}

interface DeferredEstimateWork {
  chatId: ChatId | null
  input: PromptSizeEstimateInput | null
}

interface AcceptedDeferredEstimate {
  chatId: ChatId
  value: PromptSizeEstimate
}

export function useStreamStableBranchPath<T extends MessageTreeNode>(
  path: BranchPathDescriptor<T> | null,
  streamActive: boolean,
): BranchPathDescriptor<T> | null {
  const retainedRef = useRef(path)
  if (!streamActive || retainedRef.current?.identity !== path?.identity) {
    retainedRef.current = path
  }
  return retainedRef.current
}

export function useStreamStablePromptEstimate(
  chatId: ChatId | null | undefined,
  input: PromptSizeEstimateInput | null,
  streamActivityKey: string,
): PromptSizeEstimate | null {
  const frozenMessageIds = useMemo(
    () => frozenMessageIdsFromActivityKey(streamActivityKey),
    [streamActivityKey],
  )
  const signature = useMemo(
    () => (input ? promptEstimateInputSignature(input, frozenMessageIds) : ''),
    [input, frozenMessageIds],
  )
  return useCachedPromptEstimate(chatId, input, signature, streamActivityKey)
}

export function useDeferredStreamStablePromptEstimate(
  chatId: ChatId | null | undefined,
  input: PromptSizeEstimateInput | null,
  streamActivityKey: string,
): PromptSizeEstimate | null {
  const acceptedRef = useRef<AcceptedDeferredEstimate | null>(null)
  const frozenMessageIds = useMemo(
    () => frozenMessageIdsFromActivityKey(streamActivityKey),
    [streamActivityKey],
  )
  const currentSignature = useMemo(
    () => (input ? promptEstimateInputSignature(input, frozenMessageIds) : ''),
    [input, frozenMessageIds],
  )
  const currentWork = useMemo<DeferredEstimateWork>(
    () => ({ chatId: chatId ?? null, input }),
    [chatId, input],
  )
  const deferredWork = useDeferredValue(currentWork)
  const deferredSignature = useMemo(
    () =>
      deferredWork.input === input
        ? currentSignature
        : deferredWork.input
          ? promptEstimateInputSignature(deferredWork.input, frozenMessageIds)
          : '',
    [currentSignature, deferredWork.input, frozenMessageIds, input],
  )
  const estimate = useCachedPromptEstimate(
    deferredWork.chatId,
    deferredWork.input,
    deferredSignature,
    streamActivityKey,
  )
  const currentChatId = chatId ?? null
  const exact =
    currentChatId !== null &&
    input !== null &&
    currentChatId === deferredWork.chatId &&
    currentSignature === deferredSignature &&
    estimate !== null
  if (exact) {
    acceptedRef.current = { chatId: currentChatId, value: estimate }
    return estimate
  }
  return acceptedRef.current?.chatId === currentChatId ? acceptedRef.current.value : null
}

function useCachedPromptEstimate(
  chatId: ChatId | null | undefined,
  input: PromptSizeEstimateInput | null,
  signature: string,
  streamActivityKey: string,
): PromptSizeEstimate | null {
  const cacheRef = useRef<CachedEstimate>({
    chatId: null,
    signature: '',
    value: null,
  })

  return useMemo(() => {
    const nextChatId = chatId ?? null
    if (!input) {
      cacheRef.current = { chatId: nextChatId, signature: '', value: null }
      return null
    }
    const cached = cacheRef.current
    if (
      streamActivityKey.length > 0 &&
      cached.chatId === nextChatId &&
      cached.signature === signature
    ) {
      return cached.value
    }
    const nextValue = estimatePromptSize(input)
    cacheRef.current = { chatId: nextChatId, signature, value: nextValue }
    return nextValue
  }, [chatId, input, signature, streamActivityKey])
}
