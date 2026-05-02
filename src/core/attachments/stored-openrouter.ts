import type { AttachmentBundle } from '../../store/repository'
import type { Attachment, AttachmentArtifact } from '../types'
import { buildOpenRouterContentPart, buildOpenRouterPdfPlugin } from './openrouter'
import type {
  ProcessAttachmentResult,
  AttachmentArtifact as ProcessedArtifact,
  AttachmentProcessingState as ProcessedState,
} from './types'

interface StoredOpenRouterAttachmentWire {
  parts: unknown[]
  plugins: unknown[]
}

export async function buildStoredOpenRouterAttachmentWire(
  bundle: AttachmentBundle,
  options: { imageDetail?: 'auto' | 'low' | 'high' } = {},
): Promise<StoredOpenRouterAttachmentWire> {
  const original = bundle.blobs.find((blob) => blob.role === 'original')
  const bytes = original ? new Uint8Array(await original.blob.arrayBuffer()) : undefined
  const result = storedBundleToProcessResult(bundle)
  const part = buildOpenRouterContentPart(result, bytes, options)
  const plugin = buildOpenRouterPdfPlugin(result)
  if (!part) return { parts: [], plugins: plugin ? [plugin] : [] }
  const label = attachmentLabel(bundle.attachment)
  if (part.type === 'text') {
    return {
      parts: [{ ...part, text: `${label}\n${part.text}` }],
      plugins: plugin ? [plugin] : [],
    }
  }
  return { parts: [{ type: 'text', text: label }, part], plugins: plugin ? [plugin] : [] }
}

function storedBundleToProcessResult(bundle: AttachmentBundle): ProcessAttachmentResult {
  const attachment = bundle.attachment
  const textArtifact = bundle.artifacts.some((artifact) => artifact.kind === 'text')
  return {
    attachment: {
      id: attachment.id,
      ...(attachment.contentHash ? { contentHash: attachment.contentHash } : {}),
      kind: attachment.kind === 'file' ? 'other' : attachment.kind,
      mime: attachment.mime,
      filename: attachment.filename,
      ...(attachment.extension ? { extension: attachment.extension } : {}),
      ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
      origin: attachment.origin,
      ...(attachment.sourceUrl ? { sourceUrl: attachment.sourceUrl } : {}),
      storageState: storageState(attachment),
      createdAt: attachment.createdAt,
      updatedAt: attachment.updatedAt,
      ...(attachment.dimensions ? { dimensions: attachment.dimensions } : {}),
      ...(attachment.durationMs !== undefined ? { durationMs: attachment.durationMs } : {}),
      ...(attachment.pageCount !== undefined ? { pageCount: attachment.pageCount } : {}),
      ...(attachment.textCharCount !== undefined
        ? { textCharCount: attachment.textCharCount }
        : {}),
      ...(attachment.languageHint ? { languageHint: attachment.languageHint } : {}),
      ...(attachment.scannedLike !== undefined ? { scannedLike: attachment.scannedLike } : {}),
      refCount: attachment.refCount,
      processorLabels: attachment.processing.map((state) => state.processorId),
    },
    artifacts: bundle.artifacts.map(toProcessedArtifact),
    processing: bundle.jobs.map(toProcessedState),
    tokenEstimate:
      bundle.artifacts.find((artifact) => artifact.kind === 'text')?.tokenEstimate?.tokens ?? 0,
    openRouter: openRouterContext(attachment, textArtifact),
  }
}

function storageState(
  attachment: Attachment,
): ProcessAttachmentResult['attachment']['storageState'] {
  if (attachment.storage.kind === 'missing') return 'missing'
  if (attachment.storage.kind === 'remote-url') return 'remote-url'
  return 'local-bytes'
}

function toProcessedArtifact(artifact: AttachmentArtifact): ProcessedArtifact {
  if (artifact.kind === 'text') {
    return {
      id: artifact.artifactId,
      attachmentId: artifact.attachmentId,
      kind: 'text',
      processorId: artifact.processorId,
      label: 'extracted text',
      text: artifact.text,
      createdAt: artifact.createdAt,
    }
  }
  return {
    id: artifact.artifactId,
    attachmentId: artifact.attachmentId,
    kind: 'metadata',
    processorId: artifact.processorId,
    label: artifact.kind,
    ...(artifact.kind === 'json' ? { metadata: { value: artifact.value } } : {}),
    createdAt: artifact.createdAt,
  }
}

function toProcessedState(job: AttachmentBundle['jobs'][number]): ProcessedState {
  return {
    processorId: job.processorId,
    status: job.status === 'succeeded' ? 'ready' : job.status === 'failed' ? 'failed' : 'skipped',
    inputHash: job.inputHash,
    ...(job.error ? { message: job.error.message } : {}),
    updatedAt: job.updatedAt,
  }
}

function openRouterContext(
  attachment: Attachment,
  hasTextArtifact: boolean,
): ProcessAttachmentResult['openRouter'] {
  if (attachment.kind === 'image') {
    return { supported: true, contextForm: 'image_url', requiredProcessors: [] }
  }
  if (attachment.kind === 'audio') {
    return { supported: true, contextForm: 'input_audio', requiredProcessors: [] }
  }
  if (attachment.kind === 'video') {
    return { supported: true, contextForm: 'video_url', requiredProcessors: [] }
  }
  if (attachment.kind === 'pdf') {
    return {
      supported: true,
      contextForm: 'file',
      requiredProcessors: ['file-parser'],
      pdfEngine: attachment.scannedLike ? 'mistral-ocr' : 'cloudflare-ai',
    }
  }
  if (hasTextArtifact) {
    return { supported: true, contextForm: 'text-artifact', requiredProcessors: [] }
  }
  return { supported: false, contextForm: 'download-only', requiredProcessors: [] }
}

function attachmentLabel(attachment: Attachment): string {
  const size = attachment.sizeBytes !== undefined ? `, ${attachment.sizeBytes} bytes` : ''
  return `[Attachment: ${attachment.filename}; type=${attachment.kind}; mime=${attachment.mime}${size}]`
}
