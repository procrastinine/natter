import type { ReasoningDetail } from './types'

export function mergeReasoningText(
  existingRaw: string | null | undefined,
  incomingRaw: string | null | undefined,
): string {
  const existing = existingRaw ?? ''
  const incoming = incomingRaw ?? ''
  if (incoming.length === 0) return existing
  if (existing.length === 0) return incoming
  if (incoming === existing) return existing
  if (incoming.startsWith(existing)) return incoming
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) return existing
  for (let overlap = Math.min(existing.length, incoming.length); overlap > 0; overlap -= 1) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap)
    }
  }
  return existing + incoming
}

export function mergeReasoningDetail(
  existing: ReasoningDetail | undefined,
  incoming: ReasoningDetail,
): ReasoningDetail {
  if (!existing) return incoming
  if (existing.type === 'reasoning.text' && incoming.type === 'reasoning.text') {
    return {
      ...existing,
      ...incoming,
      text: mergeReasoningText(existing.text, incoming.text),
    }
  }
  if (existing.type === 'reasoning.summary' && incoming.type === 'reasoning.summary') {
    return { ...existing, ...incoming }
  }
  if (existing.type === 'reasoning.encrypted' && incoming.type === 'reasoning.encrypted') {
    return { ...existing, ...incoming }
  }
  return incoming
}

export function normalizeReasoningDetails(details: ReasoningDetail[]): ReasoningDetail[] {
  const normalized: ReasoningDetail[] = []
  for (const detail of details) {
    if (detail.id?.startsWith('tool_')) continue
    const target = findMergeTargetIndex(normalized, detail)
    if (target >= 0) {
      normalized[target] = mergeReasoningDetail(normalized[target], detail)
      continue
    }
    normalized.push(detail)
  }
  return normalized
}

function findMergeTargetIndex(details: ReasoningDetail[], incoming: ReasoningDetail): number {
  for (let index = details.length - 1; index >= 0; index -= 1) {
    const existing = details[index]
    if (!existing || existing.type !== incoming.type) continue
    if (shareIdentity(existing, incoming)) return index
    if (incoming.type === 'reasoning.text' && existing.type === 'reasoning.text') {
      const merged = mergeReasoningText(existing.text, incoming.text)
      const appended = `${existing.text ?? ''}${incoming.text ?? ''}`
      if (merged !== appended) return index
      continue
    }
    if (incoming.type === 'reasoning.summary' && existing.type === 'reasoning.summary') {
      if (existing.summary === incoming.summary) return index
      continue
    }
    if (incoming.type === 'reasoning.encrypted' && existing.type === 'reasoning.encrypted') {
      if (existing.data === incoming.data) return index
    }
  }
  return -1
}

function shareIdentity(existing: ReasoningDetail, incoming: ReasoningDetail): boolean {
  if (existing.type !== incoming.type) return false
  if (existing.id && incoming.id) return existing.id === incoming.id
  return existing.index !== undefined && incoming.index !== undefined && existing.index === incoming.index
}
