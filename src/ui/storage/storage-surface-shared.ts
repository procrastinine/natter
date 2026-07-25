import type { TokenCalibrationSample } from '../../core/types'
import { storageApplication } from '../../store/storage-application'

export function formatCalibrationRatio(sample: TokenCalibrationSample): string {
  if (sample.totalTextTokens <= 0) return 'Unknown ratio'
  const ratio = sample.totalTextChars / sample.totalTextTokens
  if (!Number.isFinite(ratio) || ratio <= 0) return 'Unknown ratio'
  return `${ratio.toFixed(2)} chars/token`
}

export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.max(0, Math.round(value)).toLocaleString()
}

export function pluralize(word: string, count: number): string {
  if (count === 1) return word
  return word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`
}

export function displayChatTitle(chat: { title: string }): string {
  const trimmed = chat.title.trim()
  return trimmed.length > 0 ? trimmed : 'Untitled chat'
}

export function permanentDeleteBlockedMessage(error: unknown): string | undefined {
  if (!storageApplication.errors.isChatStreamBusy(error)) return undefined
  return 'Wait for the active response to finish before permanently deleting this chat.'
}
