import { useMemo, useRef } from 'react'
import {
  estimatePromptSize,
  promptEstimateInputSignature,
  type PromptSizeEstimate,
  type PromptSizeEstimateInput,
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
  const liveEstimate = useMemo(() => (input ? estimatePromptSize(input) : null), [input])
  const cacheRef = useRef<CachedEstimate>({
    chatId: null,
    signature: '',
    value: null,
  })

  return useMemo(() => {
    const nextChatId = chatId ?? null
    if (!input || !liveEstimate) {
      cacheRef.current = { chatId: nextChatId, signature: '', value: null }
      return null
    }
    if (streamActivityKey.length === 0) {
      cacheRef.current = { chatId: nextChatId, signature, value: liveEstimate }
      return liveEstimate
    }
    const cached = cacheRef.current
    if (cached.chatId === nextChatId && cached.signature === signature && cached.value) {
      return cached.value
    }
    cacheRef.current = { chatId: nextChatId, signature, value: liveEstimate }
    return liveEstimate
  }, [chatId, input, liveEstimate, signature, streamActivityKey])
}
