import type { Message } from './types'

interface SegmenterCtor {
  new (
    locale?: string | string[],
    options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
  ): {
    segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>
  }
}

const FALLBACK_WORD_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:[.'’_-][\p{L}\p{N}]+)*/gu

let segmenter: InstanceType<SegmenterCtor> | null | undefined

function getSegmenter(): InstanceType<SegmenterCtor> | null {
  if (segmenter !== undefined) return segmenter
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter
  segmenter = ctor ? new ctor(undefined, { granularity: 'word' }) : null
  return segmenter
}

export function countWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0

  const activeSegmenter = getSegmenter()
  if (activeSegmenter) {
    let total = 0
    for (const part of activeSegmenter.segment(trimmed)) {
      if (part.isWordLike) total += 1
    }
    return total
  }

  return trimmed.match(FALLBACK_WORD_RE)?.length ?? 0
}

export function countMessageWords(message: Message): number {
  let total = 0
  for (const item of message.content) {
    if (item.type === 'text' || item.type === 'output_text') {
      total += countWords(item.text)
    } else if (item.type === 'audio_output' && item.transcript) {
      total += countWords(item.transcript)
    }
  }
  return total
}

export function countMessagesWords(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    total += countMessageWords(message)
  }
  return total
}
