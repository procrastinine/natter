import type { Message } from '../types'
import type { PortableAttachmentBundle } from './schema'

export interface IncomingAttachmentRoots {
  readonly messages: readonly Message[]
  readonly drafts?: readonly {
    readonly attachmentRefs: readonly { readonly attachmentId: string }[]
  }[]
}

export function retainReachableIncomingAttachments(
  attachments: PortableAttachmentBundle[],
  roots: IncomingAttachmentRoots,
): PortableAttachmentBundle[] {
  if (attachments.length === 0) return attachments
  const byId = new Map(attachments.map((bundle) => [bundle.attachment.id, bundle] as const))
  const pending: string[] = []
  for (const message of roots.messages) {
    for (const ref of message.attachmentRefs ?? []) pending.push(ref.attachmentId)
    for (const item of message.content) {
      if ('attachmentId' in item && typeof item.attachmentId === 'string') {
        pending.push(item.attachmentId)
      }
    }
  }
  for (const draft of roots.drafts ?? []) {
    for (const ref of draft.attachmentRefs) pending.push(ref.attachmentId)
  }

  const reachable = new Set<string>()
  for (let index = 0; index < pending.length; index += 1) {
    const attachmentId = pending[index] as string
    if (reachable.has(attachmentId)) continue
    reachable.add(attachmentId)
    const supersedingId = byId.get(attachmentId)?.attachment.supersededByAttachmentId
    if (supersedingId !== undefined) pending.push(supersedingId)
  }
  if (attachments.every((bundle) => reachable.has(bundle.attachment.id))) return attachments
  return attachments.filter((bundle) => reachable.has(bundle.attachment.id))
}
