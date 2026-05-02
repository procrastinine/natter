import { useMemo, useRef } from 'react'
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
