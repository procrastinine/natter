import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { describe, expect, it } from 'vitest'
import {
  AttachmentLibrary,
  buildOpenRouterContentPart,
  buildOpenRouterPdfPlugin,
  processAttachment,
} from '../../src/core/attachments'
import type {
  AttachmentArtifact,
  AttachmentKind,
  ProcessAttachmentResult,
} from '../../src/core/attachments'

interface ManifestEntry {
  path: string
  kind: AttachmentKind
  mime: string
  sha256: string
  expectedProcessors: string[]
}

const FIXTURE_ROOT = join(process.cwd(), 'tests/fixtures/attachments')
const MANIFEST_PATH = join(FIXTURE_ROOT, 'manifest.json')
const fixtureCorpusAvailable = existsSync(MANIFEST_PATH)
const describeWithFixtures = fixtureCorpusAvailable ? describe : describe.skip
globalThis.DecompressionStream = NodeDecompressionStream as typeof DecompressionStream
const manifest = (
  fixtureCorpusAvailable ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) : { entries: [] }
) as {
  entries: ManifestEntry[]
}
const entriesByPath = new Map(manifest.entries.map((entry) => [entry.path, entry]))

describeWithFixtures('attachment processing corpus', () => {
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
    expect(
      metadataOf<{ durationMs: number; channels: number }>(speech, 'audio-metadata-v1'),
    ).toMatchObject({
      durationMs: expect.any(Number),
      channels: 1,
    })
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

describeWithFixtures('OpenRouter attachment wire parts', () => {
  it('builds image, audio, and PDF content parts from local bytes', async () => {
    const image = await processFixture('images/sample-grid.png')
    const imagePart = buildOpenRouterContentPart(image, fixtureBytes('images/sample-grid.png'))
    if (imagePart?.type !== 'image_url') throw new Error('expected image_url part')
    expect(imagePart.image_url.url).toMatch(/^data:image\/png;base64,/)

    const audio = await processFixture('audio/sample-tone.wav')
    const audioPart = buildOpenRouterContentPart(audio, fixtureBytes('audio/sample-tone.wav'))
    if (audioPart?.type !== 'input_audio') throw new Error('expected input_audio part')
    expect(audioPart.input_audio.format).toBe('wav')
    expect(audioPart.input_audio.data.startsWith('data:')).toBe(false)

    const pdf = await processFixture('pdfs/sample-two-page.pdf')
    const pdfPart = buildOpenRouterContentPart(pdf, fixtureBytes('pdfs/sample-two-page.pdf'))
    if (pdfPart?.type !== 'file') throw new Error('expected file part')
    expect(pdfPart.file.file_data).toMatch(/^data:application\/pdf;base64,/)
    expect(buildOpenRouterPdfPlugin(pdf)).toEqual({
      id: 'file-parser',
      pdf: { engine: 'cloudflare-ai' },
    })
  })
})

describeWithFixtures('AttachmentLibrary', () => {
  it('searches stored objects, reuses existing objects, relinks refs, and handles missing bytes', async () => {
    const library = new AttachmentLibrary()
    const reportA = library.put(await processFixture('duplicates/a/report.txt', { now: 10 }))
    const reportB = library.put(await processFixture('duplicates/b/report.txt', { now: 11 }))

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
    expect(
      buildOpenRouterContentPart(missing, fixtureBytes('duplicates/b/report.txt')),
    ).toBeUndefined()

    const replacement = await processFixture('text/sample-plain.txt', {
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
  return processAttachment({
    id: options.id ?? `fixture:${relativePath}`,
    filename: basename(relativePath),
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
