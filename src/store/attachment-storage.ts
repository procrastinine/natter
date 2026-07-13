import type { Attachment, AttachmentArtifact } from '../core/types'

export type AttachmentHeaderRow = Omit<Attachment, 'artifacts'> & {
  artifactIds: string[]
}

export function splitAttachmentForStorage(attachment: Attachment): AttachmentHeaderRow {
  const { artifacts, ...fields } = structuredClone(attachment)
  return { ...fields, artifactIds: artifacts.map((artifact) => artifact.artifactId) }
}

export function attachmentHeaderFromStoredRow(
  row: Attachment | AttachmentHeaderRow,
): AttachmentHeaderRow {
  return 'artifactIds' in row ? structuredClone(row) : splitAttachmentForStorage(row)
}

export function hydrateAttachment(
  header: AttachmentHeaderRow,
  artifacts: readonly (AttachmentArtifact | undefined)[],
): Attachment {
  const { artifactIds: _artifactIds, ...fields } = structuredClone(header)
  const byId = new Map(
    artifacts.flatMap((artifact) => (artifact ? [[artifact.artifactId, artifact] as const] : [])),
  )
  return {
    ...fields,
    artifacts: header.artifactIds.flatMap((artifactId) => {
      const artifact = byId.get(artifactId)
      return artifact ? [structuredClone(artifact)] : []
    }),
  }
}
