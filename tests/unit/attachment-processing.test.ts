import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { beforeAll, describe, expect, it } from 'vitest'
import type {
  AttachmentArtifact,
  AttachmentKind,
  ProcessAttachmentResult,
} from '../../src/core/attachments'
import {
  AttachmentLibrary,
  buildOpenRouterContentPart,
  buildOpenRouterPdfPlugin,
  classifyAttachment,
  processAttachment,
  sniffMime,
} from '../../src/core/attachments'

interface ManifestEntry {
  path: string
  kind: AttachmentKind
  mime: string
  sizeBytes: number
  sha256: string
  expectedProcessors: string[]
}

const FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/attachments')
const MANIFEST_PATH = join(FIXTURE_ROOT, 'manifest.json')
globalThis.DecompressionStream = NodeDecompressionStream as typeof DecompressionStream
const manifest = existsSync(MANIFEST_PATH)
  ? (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { entries: ManifestEntry[] })
  : undefined
const entriesByPath = new Map(manifest?.entries.map((entry) => [entry.path, entry]) ?? [])

if (manifest) {
  beforeAll(() => {
    for (const entry of manifest.entries) {
      const bytes = readFileSync(join(FIXTURE_ROOT, entry.path))
      expect(bytes.byteLength, entry.path).toBe(entry.sizeBytes)
      expect(createHash('sha256').update(bytes).digest('hex'), entry.path).toBe(entry.sha256)
    }
  })
}

describe('attachment processor normalization', () => {
  it('normalizes LibreChat-style MIME aliases and broad code extensions', () => {
    const textBytes = utf8("print('hello')\n")

    expect(sniffMime('script.py', textBytes, 'text/x-python-script')).toBe('text/x-python')
    expect(sniffMime('component.ts', utf8('export const value = 1\n'), 'video/mp2t')).toBe(
      'application/typescript',
    )
    expect(sniffMime('README.markdown', utf8('# Fixture\n'))).toBe('text/markdown')
    expect(sniffMime('config.yaml', utf8('name: fixture\n'))).toBe('application/yaml')
    expect(sniffMime('Dockerfile', utf8('FROM scratch\n'))).toBe('text/x-dockerfile')
    expect(classifyAttachment('text/plain', 'script.py')).toBe('code')
    expect(
      classifyAttachment(sniffMime('component.ts', textBytes, 'video/mp2t'), 'component.ts'),
    ).toBe('code')
    expect(classifyAttachment('text/plain', 'README.markdown')).toBe('plaintext')
  })

  it('classifies common image, audio, video, Office, OpenDocument, and archive types', () => {
    expect(classifyAttachment('image/heic', 'photo.heic')).toBe('image')
    expect(classifyAttachment('audio/flac', 'voice.flac')).toBe('audio')
    expect(classifyAttachment('video/x-matroska', 'clip.mkv')).toBe('video')
    expect(classifyAttachment('application/vnd.oasis.opendocument.text', 'sample.odt')).toBe(
      'document',
    )
    expect(classifyAttachment('application/vnd.oasis.opendocument.spreadsheet', 'sample.ods')).toBe(
      'spreadsheet',
    )
    expect(
      classifyAttachment('application/vnd.oasis.opendocument.presentation', 'sample.odp'),
    ).toBe('presentation')
    expect(classifyAttachment('application/vnd.rar', 'archive.rar')).toBe('archive')
  })

  it('extracts text from OpenDocument packages through the same artifact path', async () => {
    const result = await processAttachment({
      id: 'odt-fixture',
      filename: 'sample.odt',
      bytes: storedZipEntry(
        'content.xml',
        '<office:document-content><text:p>OpenDocument text fixture</text:p></office:document-content>',
      ),
      origin: 'system-fixture',
      now: 1,
    })

    expect(result.attachment.kind).toBe('document')
    expect(result.attachment.mime).toBe('application/vnd.oasis.opendocument.text')
    expect(textOf(result, 'office-text-v1')).toContain('OpenDocument text fixture')
    expect(result.openRouter.contextForm).toBe('text-artifact')
  })
})

describe('compact attachment processor fixtures', () => {
  it('extracts representative PDF, image, audio, Office, and archive metadata', async () => {
    const textPdf = await processBytes(
      'fixture.pdf',
      utf8('%PDF-1.4\n/Type /Page\nBT (Compact PDF text) Tj ET\n%%EOF'),
    )
    expect(textPdf.attachment).toMatchObject({ kind: 'pdf', pageCount: 1, scannedLike: false })
    expect(textOf(textPdf, 'pdfjs-text-v1')).toContain('Compact PDF text')

    const scannedPdf = await processBytes(
      'scan.pdf',
      utf8('%PDF-1.4\n/Type /Page\n/Subtype /Image\n%%EOF'),
    )
    expect(scannedPdf.attachment).toMatchObject({ kind: 'pdf', scannedLike: true })
    expect(scannedPdf.openRouter.pdfEngine).toBe('mistral-ocr')

    const image = await processBytes('fixture.png', pngBytes(128, 72))
    expect(image.attachment.dimensions).toEqual({ width: 128, height: 72 })

    const audio = await processBytes('fixture.wav', wavBytes(2, 8000, 250))
    expect(metadataOf(audio, 'audio-metadata-v1')).toMatchObject({
      channels: 2,
      sampleRate: 8000,
      durationMs: 250,
    })

    for (const [filename, entry, xml, expected] of [
      ['fixture.docx', 'word/document.xml', '<w:t>Document fixture</w:t>', 'Document fixture'],
      [
        'fixture.xlsx',
        'xl/sharedStrings.xml',
        '<si><t>Spreadsheet fixture</t></si>',
        'Spreadsheet fixture',
      ],
      [
        'fixture.pptx',
        'ppt/slides/slide1.xml',
        '<a:t>Presentation fixture</a:t>',
        'Presentation fixture',
      ],
    ] as const) {
      const result = await processBytes(filename, storedZipEntry(entry, xml))
      expect(textOf(result, 'office-text-v1')).toContain(expected)
    }

    const archive = await processBytes('fixture.zip', storedZipEntry('readme.txt', 'hello'))
    expect(metadataOf(archive, 'archive-inventory-v1')).toMatchObject({
      entries: [expect.objectContaining({ name: 'readme.txt' })],
    })
  })
})

if (manifest) {
  describe('local attachment processing corpus', () => {
    it.each(manifest.entries)('classifies and fingerprints $path', async (entry) => {
      const result = await processFixture(entry.path)
      expect(result.attachment.kind).toBe(entry.kind)
      expect(result.attachment.mime).toBe(entry.mime)
      expect(result.attachment.contentHash).toBe(entry.sha256)
      expect(result.attachment.id).toBe(`fixture:${entry.path}`)
      expect(result.tokenEstimate).toBeGreaterThan(0)
      for (const processor of entry.expectedProcessors) {
        expect(result.processing.map((state) => state.processorId)).toContain(processor)
      }
    })

    it('extracts text PDF content and selects the cheap OpenRouter parser', async () => {
      const result = await processFixture('pdfs/sample-two-page.pdf')
      expect(result.attachment.pageCount).toBe(2)
      expect(result.attachment.scannedLike).toBe(false)
      expect(textOf(result, 'pdfjs-text-v1')).toContain('Phase 12 PDF fixture - page 1')
      expect(result.openRouter).toMatchObject({
        supported: true,
        contextForm: 'file',
        pdfEngine: 'cloudflare-ai',
      })
    })

    it('detects scanned PDFs and routes them to OCR', async () => {
      const result = await processFixture('pdfs/sample-scanned.pdf')
      expect(result.attachment.pageCount).toBe(1)
      expect(result.attachment.scannedLike).toBe(true)
      expect(result.artifacts.some((artifact) => artifact.kind === 'text' && artifact.text)).toBe(
        false,
      )
      expect(result.openRouter.pdfEngine).toBe('mistral-ocr')
    })

    it('includes PDF-contained animal image pages for image-recognition tests', async () => {
      const result = await processFixture('pdfs/sample-animal-images.pdf')
      expect(result.attachment.pageCount).toBe(2)
      expect(result.attachment.scannedLike).toBe(true)
      expect(result.artifacts.some((artifact) => artifact.kind === 'text' && artifact.text)).toBe(
        false,
      )
      expect(result.openRouter).toMatchObject({
        supported: true,
        contextForm: 'file',
        pdfEngine: 'mistral-ocr',
      })
    })

    it('keeps mixed text-plus-scan PDFs searchable through extracted text', async () => {
      const result = await processFixture('pdfs/sample-mixed-text-scan.pdf')
      expect(result.attachment.pageCount).toBe(2)
      expect(result.attachment.scannedLike).toBe(false)
      expect(textOf(result, 'pdfjs-text-v1')).toContain('Text page before scanned page')
      expect(result.openRouter.pdfEngine).toBe('cloudflare-ai')
    })

    it('extracts image dimensions across raster and vector image fixtures', async () => {
      await expectImageDimensions('images/sample-grid.png', 128, 72)
      await expectImageDimensions('images/sample-photo.jpg', 320, 180)
      await expectImageDimensions('images/sample-animated.gif', 128, 72)
      await expectImageDimensions('images/sample-vector.svg', 160, 90)
    })

    it('extracts wav duration and channel metadata', async () => {
      const mono = await processFixture('audio/sample-tone.wav')
      expect(
        metadataOf<{ durationMs: number; channels: number }>(mono, 'audio-metadata-v1'),
      ).toMatchObject({
        durationMs: 500,
        channels: 1,
      })

      const stereo = await processFixture('audio/sample-stereo.wav')
      expect(
        metadataOf<{ durationMs: number; channels: number }>(stereo, 'audio-metadata-v1'),
      ).toMatchObject({
        durationMs: 750,
        channels: 2,
      })

      const speech = await processFixture('audio/sample-speech.wav')
      expect(speech.attachment.sizeBytes).toBeGreaterThan(4096)
      const speechMetadata = metadataOf<{ durationMs: number; channels: number }>(
        speech,
        'audio-metadata-v1',
      )
      expect(typeof speechMetadata.durationMs).toBe('number')
      expect(speechMetadata.channels).toBe(1)
      expect(speech.attachment.durationMs).toBeGreaterThan(1500)
    })

    it('extracts text from Office fixtures without treating duplicate names as ids', async () => {
      expect(textOf(await processFixture('office/sample.docx'), 'office-text-v1')).toContain(
        'Phase 12 generic DOCX fixture',
      )
      expect(textOf(await processFixture('office/sample.xlsx'), 'office-text-v1')).toContain(
        'phase fixture 12 1',
      )
      expect(textOf(await processFixture('office/sample.pptx'), 'office-text-v1')).toContain(
        'Phase 12 generic PPTX fixture',
      )
    })
  })
}

describe('OpenRouter attachment wire parts', () => {
  it('builds image, audio, and PDF content parts from compact bytes', async () => {
    const imageBytes = pngBytes(16, 9)
    const image = await processBytes('fixture.png', imageBytes)
    const imagePart = buildOpenRouterContentPart(image, imageBytes)
    if (imagePart?.type !== 'image_url') throw new Error('expected image_url part')
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/)

    const audioBytes = wavBytes(1, 8000, 100)
    const audio = await processBytes('fixture.wav', audioBytes)
    const audioPart = buildOpenRouterContentPart(audio, audioBytes)
    if (audioPart?.type !== 'input_audio') throw new Error('expected input_audio part')
    expect(audioPart.input_audio.format).toBe('wav')
    expect(audioPart.input_audio.data.startsWith('data:')).toBe(false)

    const pdfBytes = utf8('%PDF-1.4\n/Type /Page\nBT (Wire fixture) Tj ET\n%%EOF')
    const pdf = await processBytes('fixture.pdf', pdfBytes)
    const pdfPart = buildOpenRouterContentPart(pdf, pdfBytes)
    if (pdfPart?.type !== 'file') throw new Error('expected file part')
    expect(pdfPart.file.file_data).toMatch(/^data:application\/pdf;base64,/)
    expect(buildOpenRouterPdfPlugin(pdf)).toEqual({
      id: 'file-parser',
      pdf: { engine: 'cloudflare-ai' },
    })
  })
})

describe('AttachmentLibrary', () => {
  it('searches stored objects, reuses existing objects, relinks refs, and handles missing bytes', async () => {
    const library = new AttachmentLibrary()
    const reportABytes = utf8('first report body')
    const reportBBytes = utf8('second report body')
    const reportA = library.put(
      await processBytes('report.txt', reportABytes, { id: 'report-a', now: 10 }),
    )
    const reportB = library.put(
      await processBytes('report.txt', reportBBytes, { id: 'report-b', now: 11 }),
    )

    const duplicateNameHits = library.searchAttachments({
      query: 'report.txt',
      sort: 'created-asc',
    })
    expect(duplicateNameHits.map((result) => result.attachment.id)).toEqual([
      reportA.attachment.id,
      reportB.attachment.id,
    ])
    expect(library.searchAttachments({ query: reportA.attachment.id })).toHaveLength(1)

    library.addExistingRef({
      attachmentId: reportA.attachment.id,
      refId: 'message-ref',
      messageId: 'message-1',
      now: 20,
    })
    expect(library.get(reportA.attachment.id)?.attachment.refCount).toBe(1)
    expect(library.effectiveTokenEstimateForRefs(['message-ref'])).toBeGreaterThan(0)

    library.setRefVisibility('message-ref', false, 21)
    expect(library.effectiveTokenEstimateForRefs(['message-ref'])).toBe(0)
    library.setRefVisibility('message-ref', true, 22)

    const relinked = library.relinkRef('message-ref', reportB.attachment.id, 23)
    expect(relinked.attachmentId).toBe(reportB.attachment.id)
    expect(library.get(reportA.attachment.id)?.attachment.refCount).toBe(0)
    expect(library.get(reportB.attachment.id)?.attachment.refCount).toBe(1)

    const missing = library.markObjectBytesDeleted(reportB.attachment.id, 24)
    expect(missing.attachment.storageState).toBe('missing')
    expect(library.missingRefs(['message-ref'])).toHaveLength(1)
    expect(library.contextForRefs(['message-ref'])).toHaveLength(0)
    expect(buildOpenRouterContentPart(missing, reportBBytes)).toBeUndefined()

    const replacement = await processBytes('replacement.txt', utf8('replacement upload'), {
      id: 'replacement-upload',
      now: 25,
    })
    const rehydrated = library.rehydrateMissingObject(reportB.attachment.id, replacement, 26)
    expect(rehydrated.attachment.id).toBe(reportB.attachment.id)
    expect(rehydrated.attachment.contentHash).toBe(replacement.attachment.contentHash)
    expect(library.missingRefs(['message-ref'])).toHaveLength(0)
    expect(library.contextForRefs(['message-ref'])).toHaveLength(1)
  })
})

async function processFixture(
  relativePath: string,
  options: { id?: string; now?: number } = {},
): Promise<ProcessAttachmentResult> {
  const bytes = fixtureBytes(relativePath)
  return processBytes(basename(relativePath), bytes, {
    id: options.id ?? `fixture:${relativePath}`,
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

async function processBytes(
  filename: string,
  bytes: Uint8Array,
  options: { id?: string; now?: number } = {},
): Promise<ProcessAttachmentResult> {
  return processAttachment({
    id: options.id ?? `fixture:${filename}`,
    filename,
    bytes,
    origin: 'system-fixture',
    now: options.now ?? 1,
  })
}

function fixtureBytes(relativePath: string): Uint8Array {
  const entry = entriesByPath.get(relativePath)
  if (!entry) throw new Error(`unknown fixture: ${relativePath}`)
  return new Uint8Array(readFileSync(join(FIXTURE_ROOT, relativePath)))
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function storedZipEntry(name: string, text: string): Uint8Array {
  const nameBytes = utf8(name)
  const dataBytes = utf8(text)
  const header = new Uint8Array(30)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(8, 0, true)
  view.setUint32(18, dataBytes.length, true)
  view.setUint32(22, dataBytes.length, true)
  view.setUint16(26, nameBytes.length, true)
  const output = new Uint8Array(header.length + nameBytes.length + dataBytes.length)
  output.set(header, 0)
  output.set(nameBytes, header.length)
  output.set(dataBytes, header.length + nameBytes.length)
  return output
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

function wavBytes(channels: number, sampleRate: number, durationMs: number): Uint8Array {
  const bytesPerSample = 2
  const dataSize = Math.round((channels * sampleRate * bytesPerSample * durationMs) / 1000)
  const bytes = new Uint8Array(44 + dataSize)
  const view = new DataView(bytes.buffer)
  writeAscii(bytes, 0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  writeAscii(bytes, 8, 'WAVE')
  writeAscii(bytes, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, channels * sampleRate * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(bytes, 36, 'data')
  view.setUint32(40, dataSize, true)
  return bytes
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (const [index, character] of [...value].entries()) {
    bytes[offset + index] = character.charCodeAt(0)
  }
}

async function expectImageDimensions(
  relativePath: string,
  width: number,
  height: number,
): Promise<void> {
  const result = await processFixture(relativePath)
  expect(result.attachment.dimensions).toEqual({ width, height })
  expect(metadataOf(result, 'image-metadata-v1')).toMatchObject({ width, height })
}

function textOf(result: ProcessAttachmentResult, processorId: string): string {
  const artifact = artifactFor(result, processorId)
  if (!artifact.text) throw new Error(`text missing for ${processorId}`)
  return artifact.text
}

function metadataOf<T extends Record<string, unknown>>(
  result: ProcessAttachmentResult,
  processorId: string,
): T {
  const artifact = artifactFor(result, processorId)
  if (!artifact.metadata) throw new Error(`metadata missing for ${processorId}`)
  return artifact.metadata as T
}

function artifactFor(result: ProcessAttachmentResult, processorId: string): AttachmentArtifact {
  const artifact = result.artifacts.find((candidate) => candidate.processorId === processorId)
  if (!artifact) throw new Error(`artifact missing for ${processorId}`)
  return artifact
}
