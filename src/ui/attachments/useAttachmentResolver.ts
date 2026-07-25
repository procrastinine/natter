import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  attachmentContextIds,
  attachmentContextPolicyForSettings,
} from '../../core/attachments/context'
import type { AttachmentResolver } from '../../core/prompt-size'
import type {
  Attachment,
  AttachmentId,
  AttachmentRef,
  ChatSettings,
  Message,
} from '../../core/types'
import { attachmentContextController } from '../../store/attachment-catalog-workspace'

const EMPTY_ATTACHMENTS: readonly Attachment[] = Object.freeze([])
const EMPTY_ATTACHMENT_IDS: readonly AttachmentId[] = Object.freeze([])

export function useAttachmentResolverForContext(input: {
  settings: ChatSettings | undefined
  messages: readonly Message[]
  baseAttachments?: readonly Attachment[] | undefined
  draftAttachmentRefs?: readonly AttachmentRef[] | undefined
  enabled?: boolean
}): AttachmentResolver | undefined {
  const contextIds = useMemo(() => {
    if (input.enabled === false || !input.settings) return []
    return attachmentContextIds({
      messages: input.messages,
      policy: attachmentContextPolicyForSettings(input.settings),
      ...(input.draftAttachmentRefs
        ? { draft: { refs: input.draftAttachmentRefs, role: 'user' as const } }
        : {}),
    })
  }, [input.enabled, input.settings, input.messages, input.draftAttachmentRefs])

  const baseAttachments = input.baseAttachments ?? EMPTY_ATTACHMENTS
  const baseById = useMemo(
    () => new Map(baseAttachments.map((attachment) => [attachment.id, attachment] as const)),
    [baseAttachments],
  )
  const missingIdsIdentity = useMemo(
    () => JSON.stringify(contextIds.filter((id) => !baseById.has(id))),
    [baseById, contextIds],
  )
  const missingIds = useMemo(
    () => JSON.parse(missingIdsIdentity) as AttachmentId[],
    [missingIdsIdentity],
  )
  const demand = useMemo(
    () =>
      attachmentContextController.demand(missingIds.length > 0 ? missingIds : EMPTY_ATTACHMENT_IDS),
    [missingIds],
  )
  const attachments = useSyncExternalStore(demand.subscribe, demand.getSnapshot, demand.getSnapshot)
  useEffect(() => () => demand.release(), [demand])

  return useMemo(() => {
    if (contextIds.length === 0) return undefined
    return (id) => baseById.get(id) ?? attachments.rowsById.get(id)
  }, [attachments.rowsById, baseById, contextIds])
}
