import { normalizeAttachmentRefs } from '../../store/attachment-refs'
import type {
  AttachmentRef,
  ChatSettings,
  MediaContextStrategy,
  Message,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
} from '../types'

export const DRAFT_ATTACHMENT_CONTEXT_ID = '__draft__'

type AttachmentContextOwnerId = MessageId

interface AttachmentContextPolicy {
  mediaContextStrategy?: MediaContextStrategy
  mediaEchoN?: number
}

interface AttachmentContextDraft {
  refs?: readonly AttachmentRef[]
  role?: MessageRole
  createdAt?: number
}

interface Candidate {
  ownerId: AttachmentContextOwnerId
  ref: MessageAttachmentRef
}

function strategyFor(policy: AttachmentContextPolicy): MediaContextStrategy {
  return policy.mediaContextStrategy ?? 'echo-all'
}

function recentLimit(policy: AttachmentContextPolicy): number {
  const n = policy.mediaEchoN ?? 5
  if (!Number.isFinite(n)) return 5
  return Math.max(0, Math.floor(n))
}

export function attachmentsDisabledByTextProtocol(
  settings: Pick<ChatSettings, 'api' | 'protocol'>,
): boolean {
  return settings.api === 'text' || settings.protocol === 'text'
}

export function attachmentContextPolicyForSettings(
  settings: Pick<ChatSettings, 'api' | 'protocol' | 'mediaContextStrategy' | 'mediaEchoN'>,
): AttachmentContextPolicy {
  if (attachmentsDisabledByTextProtocol(settings)) return { mediaContextStrategy: 'drop-all' }
  return {
    mediaContextStrategy: settings.mediaContextStrategy,
    ...(settings.mediaEchoN !== undefined ? { mediaEchoN: settings.mediaEchoN } : {}),
  }
}

function pushLiveRefs(
  candidates: Candidate[],
  ownerId: AttachmentContextOwnerId,
  refs: readonly AttachmentRef[] | undefined,
  owner: Parameters<typeof normalizeAttachmentRefs>[1],
): void {
  for (const ref of normalizeAttachmentRefs(refs, owner)) {
    if (ref.deletedAt !== undefined || ref.includeInContext === false) continue
    candidates.push({ ownerId, ref })
  }
}

export function resolveAttachmentContextRefs(input: {
  messages: readonly Message[]
  policy: AttachmentContextPolicy | Pick<ChatSettings, 'mediaContextStrategy' | 'mediaEchoN'>
  draft?: AttachmentContextDraft
}): Map<AttachmentContextOwnerId, MessageAttachmentRef[]> {
  const strategy = strategyFor(input.policy)
  const out = new Map<AttachmentContextOwnerId, MessageAttachmentRef[]>()
  if (strategy === 'drop-all') return out

  let candidates: Candidate[] = []
  for (const message of input.messages) {
    if (message.deleted || message.hiddenFromContext) continue
    if (strategy === 'echo-user-only' && message.role !== 'user') continue
    pushLiveRefs(candidates, message.id, message.attachmentRefs, {
      messageId: message.id,
      createdAt: message.createdAt,
    })
  }

  const draft = input.draft
  if (draft?.refs && draft.refs.length > 0) {
    const draftRole = draft.role ?? 'user'
    if (strategy !== 'echo-user-only' || draftRole === 'user') {
      pushLiveRefs(candidates, DRAFT_ATTACHMENT_CONTEXT_ID, draft.refs, {
        draftChatId: DRAFT_ATTACHMENT_CONTEXT_ID,
        createdAt: draft.createdAt ?? 0,
      })
    }
  }

  if (strategy === 'echo-last-N') candidates = candidates.slice(-recentLimit(input.policy))

  for (const candidate of candidates) {
    const refs = out.get(candidate.ownerId)
    if (refs) {
      refs.push(candidate.ref)
    } else {
      out.set(candidate.ownerId, [candidate.ref])
    }
  }
  return out
}

export function attachmentContextIds(input: {
  messages: readonly Message[]
  policy: AttachmentContextPolicy | Pick<ChatSettings, 'mediaContextStrategy' | 'mediaEchoN'>
  draft?: AttachmentContextDraft
}): string[] {
  const refsByOwner = resolveAttachmentContextRefs(input)
  const ids = new Set<string>()
  for (const refs of refsByOwner.values()) {
    for (const ref of refs) ids.add(ref.attachmentId)
  }
  return [...ids].sort()
}

export function attachmentContextHasRefs(input: {
  messages: readonly Message[]
  policy: AttachmentContextPolicy | Pick<ChatSettings, 'mediaContextStrategy' | 'mediaEchoN'>
  draft?: AttachmentContextDraft
}): boolean {
  return attachmentContextIds(input).length > 0
}
