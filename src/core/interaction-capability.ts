import type { ChatId, MessageId } from './types'

export type ConnectionAvailability = 'unknown' | 'missing' | 'available'

export type GenerationCapabilityTarget =
  | { readonly kind: 'new-chat-send' }
  | { readonly kind: 'send'; readonly chatId: ChatId; readonly expectedLeafId: MessageId | null }
  | { readonly kind: 'reply'; readonly chatId: ChatId; readonly parentUserId: MessageId }
  | {
      readonly kind: 'regenerate'
      readonly chatId: ChatId
      readonly targetAssistantId: MessageId
    }
  | { readonly kind: 'edit-resend'; readonly chatId: ChatId; readonly targetUserId: MessageId }
  | { readonly kind: 'continue'; readonly chatId: ChatId; readonly targetAssistantId: MessageId }

export type GenerationCapabilityOwner =
  | 'workspace'
  | 'configuration'
  | 'prompt-path'
  | 'attempt-target'

export type GenerationCapability =
  | { readonly state: 'pending'; readonly owner: GenerationCapabilityOwner }
  | {
      readonly state: 'unavailable'
      readonly reason: 'connection-missing' | 'configuration-missing' | 'target-unavailable'
    }
  | { readonly state: 'failed'; readonly owner: GenerationCapabilityOwner }
  | { readonly state: 'ready' }

export type NonReadyGenerationCapability = Exclude<
  GenerationCapability,
  { readonly state: 'ready' }
>
export type PendingGenerationCapability = Extract<
  GenerationCapability,
  { readonly state: 'pending' }
>
export type FailedGenerationCapability = Extract<GenerationCapability, { readonly state: 'failed' }>
export type UnavailableGenerationCapability = Extract<
  GenerationCapability,
  { readonly state: 'unavailable' }
>
export type ReadyGenerationCapability = Extract<GenerationCapability, { readonly state: 'ready' }>

export type GenerationAction = 'send' | 'reply' | 'edit-resend' | 'regenerate' | 'continue'

const PENDING_GENERATION_CAPABILITIES = Object.freeze({
  workspace: Object.freeze({ state: 'pending', owner: 'workspace' }),
  configuration: Object.freeze({ state: 'pending', owner: 'configuration' }),
  'prompt-path': Object.freeze({ state: 'pending', owner: 'prompt-path' }),
  'attempt-target': Object.freeze({ state: 'pending', owner: 'attempt-target' }),
}) satisfies Readonly<Record<GenerationCapabilityOwner, PendingGenerationCapability>>

const FAILED_GENERATION_CAPABILITIES = Object.freeze({
  workspace: Object.freeze({ state: 'failed', owner: 'workspace' }),
  configuration: Object.freeze({ state: 'failed', owner: 'configuration' }),
  'prompt-path': Object.freeze({ state: 'failed', owner: 'prompt-path' }),
  'attempt-target': Object.freeze({ state: 'failed', owner: 'attempt-target' }),
}) satisfies Readonly<Record<GenerationCapabilityOwner, FailedGenerationCapability>>

const UNAVAILABLE_GENERATION_CAPABILITIES = Object.freeze({
  'connection-missing': Object.freeze({
    state: 'unavailable',
    reason: 'connection-missing',
  }),
  'configuration-missing': Object.freeze({
    state: 'unavailable',
    reason: 'configuration-missing',
  }),
  'target-unavailable': Object.freeze({ state: 'unavailable', reason: 'target-unavailable' }),
}) satisfies Readonly<
  Record<UnavailableGenerationCapability['reason'], UnavailableGenerationCapability>
>

export const AVAILABLE_GENERATION_CAPABILITY: ReadyGenerationCapability = Object.freeze({
  state: 'ready',
})

export function pendingGenerationCapability(
  owner: GenerationCapabilityOwner,
): PendingGenerationCapability {
  return PENDING_GENERATION_CAPABILITIES[owner]
}

export function failedGenerationCapability(
  owner: GenerationCapabilityOwner,
): FailedGenerationCapability {
  return FAILED_GENERATION_CAPABILITIES[owner]
}

export function unavailableGenerationCapability(
  reason: UnavailableGenerationCapability['reason'],
): UnavailableGenerationCapability {
  return UNAVAILABLE_GENERATION_CAPABILITIES[reason]
}

export function generationNotStarted(capability: NonReadyGenerationCapability) {
  return Object.freeze({ kind: 'not-started' as const, capability })
}

export function generationCapabilityAvailable(
  capability: GenerationCapability,
): capability is ReadyGenerationCapability {
  return capability.state === 'ready'
}

export function connectionAvailabilityFromProfileCount(
  profileCount: number | undefined,
): ConnectionAvailability {
  if (profileCount === undefined) return 'unknown'
  return profileCount === 0 ? 'missing' : 'available'
}

export function generationUnavailableReason(
  capability: GenerationCapability,
  action: GenerationAction,
): string | undefined {
  if (capability.state !== 'unavailable') return undefined
  if (capability.reason === 'target-unavailable') {
    if (action === 'send') return 'The selected branch can no longer be extended.'
    if (action === 'reply') return 'This message already has a reply or is no longer available.'
    if (action === 'edit-resend') return 'This message is no longer available to resend.'
    if (action === 'regenerate') return 'This response is no longer available to regenerate.'
    return 'This response is no longer available to continue.'
  }
  if (capability.reason === 'configuration-missing') {
    if (action === 'send' || action === 'reply' || action === 'edit-resend') {
      return 'Select a connection and model to send messages.'
    }
    if (action === 'regenerate') return 'Select a connection and model to regenerate.'
    return 'Select a connection and model to continue.'
  }
  if (action === 'send' || action === 'reply' || action === 'edit-resend') {
    return 'Add a connection to send messages.'
  }
  if (action === 'regenerate') return 'Add a connection to regenerate.'
  return 'Add a connection to continue.'
}

export function generationCapabilityBlockedReason(
  capability: GenerationCapability,
  action: GenerationAction,
): string | undefined {
  const unavailableReason = generationUnavailableReason(capability, action)
  if (unavailableReason) return unavailableReason
  if (capability.state !== 'failed') return undefined
  if (capability.owner === 'workspace') {
    return 'The workspace failed to become ready. Reopen it to retry.'
  }
  if (capability.owner === 'configuration') {
    return 'Connection and model settings failed to load. Reopen the selection to retry.'
  }
  if (capability.owner === 'attempt-target') {
    return 'The active generation state failed to resolve. Reopen this response to retry.'
  }
  return 'This branch failed to resolve. Reopen it to retry.'
}
