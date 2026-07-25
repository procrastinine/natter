import { canonicalStreamEventV2FromUnknown } from '../core/canonical-stream-event'
import type { CanonicalStreamEventV2 } from '../core/generation-stream-events'

const STREAM_JOURNAL_EVENT_VERSION_V2 = 2 as const
export const CURRENT_STREAM_JOURNAL_EVENT_VERSION = STREAM_JOURNAL_EVENT_VERSION_V2

export interface PersistedStreamEventV2 {
  readonly version: typeof STREAM_JOURNAL_EVENT_VERSION_V2
  readonly event: CanonicalStreamEventV2
}

export function persistStreamEventV2(event: CanonicalStreamEventV2): PersistedStreamEventV2 {
  return { version: STREAM_JOURNAL_EVENT_VERSION_V2, event }
}

export function persistedStreamEventV2FromUnknown(value: unknown): PersistedStreamEventV2 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (
    keys.length !== 2 ||
    !Object.hasOwn(candidate, 'version') ||
    !Object.hasOwn(candidate, 'event') ||
    candidate.version !== STREAM_JOURNAL_EVENT_VERSION_V2
  ) {
    return null
  }
  const event = canonicalStreamEventV2FromUnknown(candidate.event)
  return event ? { version: STREAM_JOURNAL_EVENT_VERSION_V2, event } : null
}

export function requirePersistedStreamEventV2(value: unknown): PersistedStreamEventV2 {
  const event = persistedStreamEventV2FromUnknown(value)
  if (!event) throw new Error('PersistedStreamEventInvalid')
  return event
}
