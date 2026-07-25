import { canonicalStreamEventV1FromUnknown } from './canonical-stream-event-v1'
import type { CanonicalStreamEventV1 } from './generation-stream-events-v1'

export const STREAM_JOURNAL_EVENT_VERSION_V1 = 1 as const

export interface PersistedStreamEventV1 {
  readonly version: typeof STREAM_JOURNAL_EVENT_VERSION_V1
  readonly event: CanonicalStreamEventV1
}

export function persistStreamEventV1(event: CanonicalStreamEventV1): PersistedStreamEventV1 {
  return { version: STREAM_JOURNAL_EVENT_VERSION_V1, event }
}

export function persistedStreamEventV1FromUnknown(value: unknown): PersistedStreamEventV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (
    keys.length !== 2 ||
    !Object.hasOwn(candidate, 'version') ||
    !Object.hasOwn(candidate, 'event') ||
    candidate.version !== STREAM_JOURNAL_EVENT_VERSION_V1
  ) {
    return null
  }
  const event = canonicalStreamEventV1FromUnknown(candidate.event)
  return event ? { version: STREAM_JOURNAL_EVENT_VERSION_V1, event } : null
}
