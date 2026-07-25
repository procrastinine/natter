import type { Attachment, AttachmentArtifact } from '../core/types'

export type AttachmentHeaderRow = Omit<Attachment, 'artifacts'> & {
  artifactIds: string[]
  wireVersion: number
  unreferencedAt: number | null
}

export function splitAttachmentForStorage(
  attachment: Attachment,
  wireVersion = 0,
  unreferencedAt = attachment.refCount === 0 ? Date.now() : null,
): AttachmentHeaderRow {
  const { artifacts, ...fields } = structuredClone(attachment)
  return {
    ...fields,
    artifactIds: artifacts.map((artifact) => artifact.artifactId),
    wireVersion,
    unreferencedAt,
  }
}

export function hydrateAttachment(
  header: AttachmentHeaderRow,
  artifacts: readonly (AttachmentArtifact | undefined)[],
): Attachment {
  const {
    artifactIds: _artifactIds,
    wireVersion: _wireVersion,
    unreferencedAt: _unreferencedAt,
    ...fields
  } = structuredClone(header)
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
