export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'plaintext'
  | 'code'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'other'

type AttachmentOrigin =
  | 'user-upload'
  | 'user-remote-url'
  | 'generated-output'
  | 'server-tool-peel'
  | 'import'
  | 'system-fixture'

type AttachmentStorageState = 'local-bytes' | 'remote-url' | 'missing'

type AttachmentArtifactKind =
  | 'text'
  | 'thumbnail'
  | 'wire-variant'
  | 'metadata'
  | 'archive-inventory'

interface AttachmentRecord {
  id: string
  contentHash?: string
  kind: AttachmentKind
  mime: string
  filename: string
  extension?: string
  sizeBytes?: number
  origin: AttachmentOrigin
  sourceUrl?: string
  storageState: AttachmentStorageState
  createdAt: number
  updatedAt: number
  dimensions?: { width: number; height: number }
  durationMs?: number
  pageCount?: number
  textCharCount?: number
  languageHint?: string
  scannedLike?: boolean
  refCount: number
  processorLabels: string[]
}

export interface AttachmentArtifact {
  id: string
  attachmentId: string
  kind: AttachmentArtifactKind
  processorId: string
  mime?: string
  label: string
  text?: string
  metadata?: Record<string, unknown>
  createdAt: number
}

export interface AttachmentProcessingState {
  processorId: string
  status: 'ready' | 'skipped' | 'failed'
  inputHash?: string
  message?: string
  updatedAt: number
}

export interface ProcessAttachmentInput {
  id: string
  filename: string
  bytes: Uint8Array
  declaredMime?: string
  origin?: AttachmentOrigin
  sourceUrl?: string
  now?: number
}

export interface ProcessAttachmentResult {
  attachment: AttachmentRecord
  artifacts: AttachmentArtifact[]
  processing: AttachmentProcessingState[]
  tokenEstimate: number
  openRouter: {
    supported: boolean
    contextForm:
      | 'image_url'
      | 'input_audio'
      | 'video_url'
      | 'file'
      | 'text-artifact'
      | 'download-only'
    requiredProcessors: string[]
    pdfEngine?: 'native' | 'cloudflare-ai' | 'mistral-ocr'
  }
}
