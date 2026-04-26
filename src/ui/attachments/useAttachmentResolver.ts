import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import {
  attachmentContextIds,
  attachmentContextPolicyForSettings,
} from '../../core/attachments/context'
import type { AttachmentResolver } from '../../core/prompt-size'
import type { Attachment, AttachmentRef, ChatSettings, Message } from '../../core/types'
import { getBrowserRepository } from '../../store/browser-repo'

const EMPTY_ATTACHMENT_MAP = new Map<string, Attachment>()

export function useAttachmentResolverForContext(input: {
  settings: ChatSettings | undefined
  messages: readonly Message[]
  draftAttachmentRefs?: readonly AttachmentRef[] | undefined
  enabled?: boolean
}): AttachmentResolver | undefined {
  const idsKey = useMemo(() => {
    if (input.enabled === false || !input.settings) return ''
    return attachmentContextIds({
      messages: input.messages,
      policy: attachmentContextPolicyForSettings(input.settings),
      ...(input.draftAttachmentRefs
        ? { draft: { refs: input.draftAttachmentRefs, role: 'user' as const } }
        : {}),
    }).join('|')
  }, [input.enabled, input.settings, input.messages, input.draftAttachmentRefs])

  const attachments = useLiveQuery(
    async () => {
      if (!idsKey) return EMPTY_ATTACHMENT_MAP
      const repo = getBrowserRepository()
      const rows = await Promise.all(
        idsKey.split('|').map(async (id) => [id, await repo.getAttachment(id)] as const),
      )
      const map = new Map<string, Attachment>()
      for (const [id, row] of rows) {
        if (row) map.set(id, row)
      }
      return map
    },
    [idsKey],
    EMPTY_ATTACHMENT_MAP,
  )

  return useMemo(() => {
    if (!idsKey) return undefined
    return (id) => attachments.get(id)
  }, [idsKey, attachments])
}
