import {
  GENERIC_FILE_TOKEN_FALLBACK,
  imageTokenEstimate,
  pdfTokenEstimate,
} from '../media-tokens'
import type {
  AttachmentArtifact,
  AttachmentKind,
  AttachmentProcessingState,
  ProcessAttachmentInput,
  ProcessAttachmentResult,
} from './types'

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  pdf: 'application/pdf',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  ts: 'application/typescript',
  tsx: 'application/typescript',
  js: 'application/javascript',
  jsx: 'application/javascript',
  py: 'text/x-python',
  sh: 'application/x-sh',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  md: 'markdown',
  csv: 'csv',
  json: 'json',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  sh: 'shell',
  txt: 'text',
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new globalThis.Uint8Array(bytes.length)
  digestInput.set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

export function fileExtension(filename: string): string | undefined {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const lastDot = base.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === base.length - 1) return undefined
  return base.slice(lastDot + 1).toLowerCase()
}

export function sniffMime(
  filename: string,
  bytes: Uint8Array,
  declaredMime?: string,
): string {
  const extension = fileExtension(filename)
  const declared = normalizeMime(declaredMime)
  if (declared && declared !== 'application/octet-stream') return declared

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (asciiAt(bytes, 0, 4) === 'GIF8') return 'image/gif'
  if (asciiAt(bytes, 0, 5) === '%PDF-') return 'application/pdf'
  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 12) === 'WAVE') return 'audio/wav'
  if (asciiAt(bytes, 4, 8) === 'ftyp') return extension === 'm4a' ? 'audio/mp4' : 'video/mp4'
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  if (asciiAt(bytes, 0, 2) === 'PK') return officeOrZipMime(extension)

  const sample = TEXT_DECODER.decode(bytes.slice(0, Math.min(bytes.length, 4096))).trimStart()
  if (sample.startsWith('<svg') || sample.includes('<svg ')) return 'image/svg+xml'

  if (extension && MIME_BY_EXTENSION[extension]) return MIME_BY_EXTENSION[extension]
  if (isLikelyText(bytes)) return 'text/plain'
  return 'application/octet-stream'
}

export function classifyAttachment(mime: string, filename: string): AttachmentKind {
  const extension = fileExtension(filename)
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'text/csv' || isSpreadsheetMime(mime)) return 'spreadsheet'
  if (isDocumentMime(mime)) return 'document'
  if (isPresentationMime(mime)) return 'presentation'
  if (isArchiveMime(mime)) return 'archive'
  if (isCodeMime(mime) || (extension && isCodeExtension(extension))) {
    return 'code'
  }
  if (mime.startsWith('text/')) return 'plaintext'
  return 'other'
}

export async function processAttachment(
  input: ProcessAttachmentInput,
): Promise<ProcessAttachmentResult> {
  const now = input.now ?? Date.now()
  const mime = sniffMime(input.filename, input.bytes, input.declaredMime)
  const extension = fileExtension(input.filename)
  const kind = classifyAttachment(mime, input.filename)
  const contentHash = await sha256Hex(input.bytes)
  const artifacts: AttachmentArtifact[] = []
  const processing: AttachmentProcessingState[] = [
    ready('mime-sniff-v1', now, contentHash),
    ready('sha256-v1', now, contentHash),
  ]

  const metadata = await collectMetadata(input.id, input.bytes, kind, mime, input.filename, now)
  for (const artifact of metadata.artifacts) artifacts.push(artifact)
  for (const state of metadata.processing) processing.push({ ...state, inputHash: contentHash })

  const textArtifact = artifacts.find((artifact) => artifact.kind === 'text' && artifact.text)
  const languageHint = extension ? LANGUAGE_BY_EXTENSION[extension] : undefined
  const scannedLike = metadata.scannedLike
  const tokenEstimate = estimateAttachmentTokens(kind, metadata, textArtifact?.text)
  const openRouter = openRouterContext(kind, metadata, Boolean(textArtifact))

  const attachment = {
    id: input.id,
    contentHash,
    kind,
    mime,
    filename: input.filename,
    origin: input.origin ?? 'user-upload',
    storageState: 'local-bytes' as const,
    createdAt: now,
    updatedAt: now,
    refCount: 0,
    processorLabels: processing.map((state) => state.processorId),
    ...(extension ? { extension } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.bytes.length > 0 ? { sizeBytes: input.bytes.length } : {}),
    ...(metadata.dimensions ? { dimensions: metadata.dimensions } : {}),
    ...(metadata.durationMs ? { durationMs: metadata.durationMs } : {}),
    ...(metadata.pageCount ? { pageCount: metadata.pageCount } : {}),
    ...(metadata.textCharCount ? { textCharCount: metadata.textCharCount } : {}),
    ...(languageHint ? { languageHint } : {}),
    ...(scannedLike !== undefined ? { scannedLike } : {}),
  }

  return { attachment, artifacts, processing, tokenEstimate, openRouter }
}

interface CollectedMetadata {
  artifacts: AttachmentArtifact[]
  processing: AttachmentProcessingState[]
  dimensions?: { width: number; height: number }
  durationMs?: number
  pageCount?: number
  textCharCount?: number
  scannedLike?: boolean
}

async function collectMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  kind: AttachmentKind,
  mime: string,
  filename: string,
  now: number,
): Promise<CollectedMetadata> {
  if (kind === 'image') return collectImageMetadata(attachmentId, bytes, mime, now)
  if (kind === 'pdf') return collectPdfMetadata(attachmentId, bytes, now)
  if (kind === 'audio') return collectAudioMetadata(attachmentId, bytes, mime, now)
  if (kind === 'video') return collectVideoMetadata(attachmentId, bytes, mime, now)
  if (kind === 'document' || kind === 'spreadsheet' || kind === 'presentation') {
    if (isOfficeMime(mime)) return await collectOfficeMetadata(attachmentId, bytes, mime, now)
  }
  if (kind === 'archive') return await collectArchiveMetadata(attachmentId, bytes, now)
  if (kind === 'plaintext' || kind === 'code' || mime === 'text/csv') {
    return collectTextMetadata(attachmentId, bytes, filename, now)
  }
  return { artifacts: [], processing: [skipped('generic-file-v1', now, 'no extractor registered')] }
}

function collectImageMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  mime: string,
  now: number,
): CollectedMetadata {
  const dimensions = imageDimensions(bytes, mime)
  const artifacts: AttachmentArtifact[] = []
  const processing = [dimensions ? ready('image-metadata-v1', now) : failed('image-metadata-v1', now)]
  if (dimensions) {
    artifacts.push(metadataArtifact(attachmentId, 'image-metadata-v1', 'image metadata', now, {
      width: dimensions.width,
      height: dimensions.height,
      mime,
    }))
    const resized = fitWithin(dimensions.width, dimensions.height, 1536)
    artifacts.push({
      id: `${attachmentId}:image-wire-variant`,
      attachmentId,
      kind: 'wire-variant',
      processorId: 'image-resize-plan-v1',
      mime,
      label: 'OpenRouter image resize plan',
      metadata: {
        maxEdge: 1536,
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height,
        targetWidth: resized.width,
        targetHeight: resized.height,
        resizeRequired: resized.width !== dimensions.width || resized.height !== dimensions.height,
      },
      createdAt: now,
    })
    processing.push(ready('image-resize-plan-v1', now))
  }
  return { artifacts, processing, ...(dimensions ? { dimensions } : {}) }
}

function collectPdfMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  now: number,
): CollectedMetadata {
  const raw = binaryAscii(bytes)
  const pageCount = [...raw.matchAll(/\/Type\s*\/Page\b/g)].length
  const hasImage = raw.includes('/Subtype /Image')
  const extractedText = normalizeText(extractPdfLiteralText(raw))
  const textCharCount = extractedText.length
  const scannedLike = pageCount > 0 && hasImage && textCharCount < 20
  const artifacts: AttachmentArtifact[] = [
    metadataArtifact(attachmentId, 'pdf-metadata-v1', 'PDF metadata', now, {
      pageCount,
      hasImage,
      scannedLike,
    }),
  ]
  const processing: AttachmentProcessingState[] = [ready('pdf-metadata-v1', now)]
  if (extractedText) {
    artifacts.push(textArtifact(attachmentId, 'pdfjs-text-v1', 'PDF extracted text', extractedText, now))
    processing.push(ready('pdfjs-text-v1', now))
  } else {
    processing.push(skipped('pdfjs-text-v1', now, 'no uncompressed text runs found'))
  }
  return {
    artifacts,
    processing,
    pageCount: Math.max(1, pageCount),
    textCharCount,
    scannedLike,
  }
}

function collectAudioMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  mime: string,
  now: number,
): CollectedMetadata {
  const wav = mime === 'audio/wav' ? wavMetadata(bytes) : undefined
  const artifacts: AttachmentArtifact[] = []
  const processing: AttachmentProcessingState[] = []
  if (wav) {
    artifacts.push(metadataArtifact(attachmentId, 'audio-metadata-v1', 'audio metadata', now, wav))
    processing.push(ready('audio-metadata-v1', now))
    return { artifacts, processing, durationMs: wav.durationMs }
  }
  processing.push(skipped('audio-metadata-v1', now, 'unsupported audio metadata container'))
  return { artifacts, processing }
}

function collectVideoMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  mime: string,
  now: number,
): CollectedMetadata {
  const durationMs = mime === 'video/mp4' ? mp4DurationMs(bytes) : undefined
  const metadata = { mime, ...(durationMs ? { durationMs } : {}) }
  return {
    artifacts: [metadataArtifact(attachmentId, 'video-metadata-v1', 'video metadata', now, metadata)],
    processing: [durationMs ? ready('video-metadata-v1', now) : skipped('video-metadata-v1', now)],
    ...(durationMs ? { durationMs } : {}),
  }
}

async function collectOfficeMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  mime: string,
  now: number,
): Promise<CollectedMetadata> {
  const entries = await parseZipEntries(bytes)
  const extractedText = normalizeText(extractOfficeText(entries, mime))
  const artifacts: AttachmentArtifact[] = [
    archiveInventoryArtifact(attachmentId, entries, 'office package inventory', now),
  ]
  const processing: AttachmentProcessingState[] = [ready('archive-inventory-v1', now)]
  if (extractedText) {
    artifacts.push(textArtifact(attachmentId, 'office-text-v1', 'Office extracted text', extractedText, now))
    processing.push(ready('office-text-v1', now))
  } else {
    processing.push(skipped('office-text-v1', now, 'no readable Office XML text found'))
  }
  return { artifacts, processing, textCharCount: extractedText.length }
}

async function collectArchiveMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  now: number,
): Promise<CollectedMetadata> {
  const entries = await parseZipEntries(bytes)
  return {
    artifacts: [archiveInventoryArtifact(attachmentId, entries, 'archive inventory', now)],
    processing: [ready('archive-inventory-v1', now)],
  }
}

function collectTextMetadata(
  attachmentId: string,
  bytes: Uint8Array,
  filename: string,
  now: number,
): CollectedMetadata {
  const decoded = normalizeText(stripBom(TEXT_DECODER.decode(bytes)))
  const extension = fileExtension(filename)
  return {
    artifacts: [
      textArtifact(attachmentId, 'plaintext-code-v1', 'plaintext/code text', decoded, now),
      metadataArtifact(attachmentId, 'plaintext-code-v1', 'plaintext/code metadata', now, {
        languageHint: extension ? LANGUAGE_BY_EXTENSION[extension] : undefined,
        charCount: decoded.length,
      }),
    ],
    processing: [ready('plaintext-code-v1', now)],
    textCharCount: decoded.length,
  }
}

function estimateAttachmentTokens(
  kind: AttachmentKind,
  metadata: CollectedMetadata,
  extractedText?: string,
): number {
  if (kind === 'image') return imageTokenEstimate('unknown', metadata.dimensions)
  if (kind === 'pdf') {
    return pdfTokenEstimate('unknown', {
      tier: 'server-parser',
      ...(metadata.pageCount ? { pageCount: metadata.pageCount } : {}),
    })
  }
  if (extractedText) return textTokenEstimate(extractedText)
  if (kind === 'audio' || kind === 'video') return GENERIC_FILE_TOKEN_FALLBACK
  return GENERIC_FILE_TOKEN_FALLBACK
}

function openRouterContext(
  kind: AttachmentKind,
  metadata: CollectedMetadata,
  hasTextArtifact: boolean,
): ProcessAttachmentResult['openRouter'] {
  if (kind === 'image') {
    return { supported: true, contextForm: 'image_url', requiredProcessors: ['image-resize-plan-v1'] }
  }
  if (kind === 'audio') return { supported: true, contextForm: 'input_audio', requiredProcessors: [] }
  if (kind === 'video') return { supported: true, contextForm: 'video_url', requiredProcessors: [] }
  if (kind === 'pdf') {
    return {
      supported: true,
      contextForm: 'file',
      requiredProcessors: ['file-parser'],
      pdfEngine: metadata.scannedLike ? 'mistral-ocr' : 'cloudflare-ai',
    }
  }
  if (hasTextArtifact) return { supported: true, contextForm: 'text-artifact', requiredProcessors: [] }
  return { supported: false, contextForm: 'download-only', requiredProcessors: [] }
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

function normalizeMime(mime?: string): string | undefined {
  const normalized = mime?.split(';', 1)[0]?.trim().toLowerCase()
  return normalized || undefined
}

function officeOrZipMime(extension: string | undefined): string {
  if (extension === 'docx') return MIME_BY_EXTENSION.docx ?? 'application/zip'
  if (extension === 'xlsx') return MIME_BY_EXTENSION.xlsx ?? 'application/zip'
  if (extension === 'pptx') return MIME_BY_EXTENSION.pptx ?? 'application/zip'
  return 'application/zip'
}

function isLikelyText(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, Math.min(bytes.length, 4096))
  if (sample.length === 0) return true
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return false
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1
  }
  return suspicious / sample.length < 0.02
}

function isCodeMime(mime: string): boolean {
  return (
    mime === 'application/json' ||
    mime === 'application/typescript' ||
    mime === 'application/javascript' ||
    mime === 'application/x-sh' ||
    mime === 'text/x-python'
  )
}

function isCodeExtension(extension: string): boolean {
  return ['json', 'ts', 'tsx', 'js', 'jsx', 'py', 'sh'].includes(extension)
}

function isDocumentMime(mime: string): boolean {
  return (
    mime === 'application/msword' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/vnd.oasis.opendocument.text'
  )
}

function isSpreadsheetMime(mime: string): boolean {
  return (
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.oasis.opendocument.spreadsheet'
  )
}

function isPresentationMime(mime: string): boolean {
  return (
    mime === 'application/vnd.ms-powerpoint' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mime === 'application/vnd.oasis.opendocument.presentation'
  )
}

function isArchiveMime(mime: string): boolean {
  return mime === 'application/zip' || mime === 'application/x-tar' || mime === 'application/gzip'
}

function isOfficeMime(mime: string): boolean {
  return isDocumentMime(mime) || isSpreadsheetMime(mime) || isPresentationMime(mime)
}

function imageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  if (mime === 'image/png' && bytes.length >= 24) {
    return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) }
  }
  if (mime === 'image/gif' && bytes.length >= 10) {
    return { width: readU16LE(bytes, 6), height: readU16LE(bytes, 8) }
  }
  if (mime === 'image/jpeg') return jpegDimensions(bytes)
  if (mime === 'image/svg+xml') return svgDimensions(TEXT_DECODER.decode(bytes))
  return undefined
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!startsWith(bytes, [0xff, 0xd8])) return undefined
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined
    const marker = bytes[offset + 1]
    const segmentLength = readU16BE(bytes, offset + 2)
    if (segmentLength < 2) return undefined
    if (
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    ) {
      return { height: readU16BE(bytes, offset + 5), width: readU16BE(bytes, offset + 7) }
    }
    offset += 2 + segmentLength
  }
  return undefined
}

function svgDimensions(svg: string): { width: number; height: number } | undefined {
  const width = numericAttribute(svg, 'width')
  const height = numericAttribute(svg, 'height')
  if (width && height) return { width, height }
  const viewBox = svg.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/)
  if (!viewBox?.[1] || !viewBox[2]) return undefined
  return { width: Number(viewBox[1]), height: Number(viewBox[2]) }
}

function numericAttribute(input: string, attr: string): number | undefined {
  const match = input.match(new RegExp(`\\b${attr}=["']([\\d.]+)`))
  if (!match?.[1]) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const edge = Math.max(width, height)
  if (edge <= maxEdge) return { width, height }
  const scale = maxEdge / edge
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function extractPdfLiteralText(raw: string): string {
  const text: string[] = []
  for (const match of raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    if (match[1]) text.push(decodePdfLiteral(match[1]))
  }
  for (const match of raw.matchAll(/\[((?:\s*\((?:\\.|[^\\)])*\)\s*)+)\]\s*TJ/g)) {
    const runs = match[1]?.matchAll(/\(((?:\\.|[^\\)])*)\)/g)
    if (!runs) continue
    for (const run of runs) {
      if (run[1]) text.push(decodePdfLiteral(run[1]))
    }
  }
  return text.join('\n')
}

function decodePdfLiteral(input: string): string {
  return input.replace(/\\([nrtbf()\\])/g, (_match, escaped: string) => {
    if (escaped === 'n') return '\n'
    if (escaped === 'r') return '\r'
    if (escaped === 't') return '\t'
    if (escaped === 'b') return '\b'
    if (escaped === 'f') return '\f'
    return escaped
  })
}

interface ZipEntry {
  name: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  bytes?: Uint8Array
}

async function parseZipEntries(bytes: Uint8Array): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = []
  let offset = 0
  while (offset + 30 <= bytes.length && readU32LE(bytes, offset) === 0x04034b50) {
    const compressionMethod = readU16LE(bytes, offset + 8)
    const compressedSize = readU32LE(bytes, offset + 18)
    const uncompressedSize = readU32LE(bytes, offset + 22)
    const nameLength = readU16LE(bytes, offset + 26)
    const extraLength = readU16LE(bytes, offset + 28)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) break
    const rawEntryBytes = bytes.slice(dataStart, dataEnd)
    const entryBytes =
      compressionMethod === 0 ? rawEntryBytes : await inflateZipEntry(rawEntryBytes, compressionMethod)
    const entry = {
      name: binaryAscii(bytes.slice(nameStart, nameStart + nameLength)),
      compressedSize,
      uncompressedSize,
      compressionMethod,
      ...(entryBytes ? { bytes: entryBytes } : {}),
    }
    entries.push(entry)
    offset = dataEnd
  }
  return entries
}

async function inflateZipEntry(
  bytes: Uint8Array,
  compressionMethod: number,
): Promise<Uint8Array | undefined> {
  if (compressionMethod !== 8 || typeof globalThis.DecompressionStream !== 'function') {
    return undefined
  }
  try {
    const copy = new Uint8Array(bytes)
    const stream = new Response(copy).body?.pipeThrough(new DecompressionStream('deflate-raw'))
    if (!stream) return undefined
    const inflated = await new Response(stream).arrayBuffer()
    return new Uint8Array(inflated)
  } catch {
    return undefined
  }
}

function extractOfficeText(entries: ZipEntry[], mime: string): string {
  const byName = new Map(entries.map((entry) => [entry.name, entry.bytes]))
  if (isDocumentMime(mime)) return xmlText(byName.get('word/document.xml'))
  if (isSpreadsheetMime(mime)) {
    return [
      xmlText(byName.get('xl/sharedStrings.xml')),
      ...entries
        .filter((entry) => entry.name.startsWith('xl/worksheets/') && entry.name.endsWith('.xml'))
        .map((entry) => xmlText(entry.bytes)),
    ].join('\n')
  }
  if (isPresentationMime(mime)) {
    return entries
      .filter((entry) => entry.name.startsWith('ppt/slides/') && entry.name.endsWith('.xml'))
      .map((entry) => xmlText(entry.bytes))
      .join('\n')
  }
  return ''
}

function xmlText(bytes?: Uint8Array): string {
  if (!bytes) return ''
  return decodeXmlEntities(TEXT_DECODER.decode(bytes).replace(/<[^>]+>/g, ' '))
}

function wavMetadata(bytes: Uint8Array):
  | {
      durationMs: number
      channels: number
      sampleRate: number
      bitsPerSample: number
    }
  | undefined {
  if (asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 12) !== 'WAVE') return undefined
  let offset = 12
  let channels: number | undefined
  let sampleRate: number | undefined
  let bitsPerSample: number | undefined
  let byteRate: number | undefined
  let dataSize: number | undefined
  while (offset + 8 <= bytes.length) {
    const chunkId = asciiAt(bytes, offset, offset + 4)
    const chunkSize = readU32LE(bytes, offset + 4)
    const chunkData = offset + 8
    if (chunkData + chunkSize > bytes.length) break
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      channels = readU16LE(bytes, chunkData + 2)
      sampleRate = readU32LE(bytes, chunkData + 4)
      byteRate = readU32LE(bytes, chunkData + 8)
      bitsPerSample = readU16LE(bytes, chunkData + 14)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
    }
    offset = chunkData + chunkSize + (chunkSize % 2)
  }
  if (!channels || !sampleRate || !bitsPerSample || !byteRate || !dataSize) return undefined
  return {
    durationMs: Math.round((dataSize / byteRate) * 1000),
    channels,
    sampleRate,
    bitsPerSample,
  }
}

function mp4DurationMs(bytes: Uint8Array): number | undefined {
  const moov = findMp4Box(bytes, 'moov', 0, bytes.length)
  if (!moov) return undefined
  const mvhd = findMp4Box(bytes, 'mvhd', moov.contentStart, moov.end)
  if (!mvhd) return undefined
  const version = bytes[mvhd.contentStart]
  if (version === 0) {
    const timescale = readU32BE(bytes, mvhd.contentStart + 12)
    const duration = readU32BE(bytes, mvhd.contentStart + 16)
    if (!timescale) return undefined
    return Math.round((duration / timescale) * 1000)
  }
  if (version === 1) {
    const timescale = readU32BE(bytes, mvhd.contentStart + 20)
    const duration = readU64BE(bytes, mvhd.contentStart + 24)
    if (!timescale || duration > Number.MAX_SAFE_INTEGER) return undefined
    return Math.round((duration / timescale) * 1000)
  }
  return undefined
}

function findMp4Box(
  bytes: Uint8Array,
  type: string,
  start: number,
  end: number,
): { contentStart: number; end: number } | undefined {
  let offset = start
  while (offset + 8 <= end) {
    const size = readU32BE(bytes, offset)
    const name = asciiAt(bytes, offset + 4, offset + 8)
    if (size < 8 || offset + size > end) return undefined
    if (name === type) return { contentStart: offset + 8, end: offset + size }
    offset += size
  }
  return undefined
}

function archiveInventoryArtifact(
  attachmentId: string,
  entries: ZipEntry[],
  label: string,
  now: number,
): AttachmentArtifact {
  return {
    id: `${attachmentId}:archive-inventory`,
    attachmentId,
    kind: 'archive-inventory',
    processorId: 'archive-inventory-v1',
    label,
    metadata: {
      entries: entries.map((entry) => ({
        name: entry.name,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        compressionMethod: entry.compressionMethod,
      })),
    },
    createdAt: now,
  }
}

function textArtifact(
  attachmentId: string,
  processorId: string,
  label: string,
  text: string,
  now: number,
): AttachmentArtifact {
  return {
    id: `${attachmentId}:${processorId}:text`,
    attachmentId,
    kind: 'text',
    processorId,
    mime: 'text/plain',
    label,
    text,
    metadata: { charCount: text.length },
    createdAt: now,
  }
}

function metadataArtifact(
  attachmentId: string,
  processorId: string,
  label: string,
  now: number,
  metadata: Record<string, unknown>,
): AttachmentArtifact {
  return {
    id: `${attachmentId}:${processorId}:metadata`,
    attachmentId,
    kind: 'metadata',
    processorId,
    label,
    metadata,
    createdAt: now,
  }
}

function ready(processorId: string, now: number, inputHash?: string): AttachmentProcessingState {
  return { processorId, status: 'ready', updatedAt: now, ...(inputHash ? { inputHash } : {}) }
}

function skipped(
  processorId: string,
  now: number,
  message = 'not applicable',
): AttachmentProcessingState {
  return { processorId, status: 'skipped', message, updatedAt: now }
}

function failed(processorId: string, now: number): AttachmentProcessingState {
  return { processorId, status: 'failed', message: 'metadata parse failed', updatedAt: now }
}

function textTokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function binaryAscii(bytes: Uint8Array): string {
  let output = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    output += String.fromCharCode(...bytes.slice(i, i + chunkSize))
  }
  return output
}

function asciiAt(bytes: Uint8Array, start: number, end: number): string {
  if (end > bytes.length) return ''
  return binaryAscii(bytes.slice(start, end))
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  )
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function readU64BE(bytes: Uint8Array, offset: number): number {
  return readU32BE(bytes, offset) * 2 ** 32 + readU32BE(bytes, offset + 4)
}
