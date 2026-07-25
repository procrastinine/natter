import { describe, expect, it, vi } from 'vitest'
import { GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID } from '../../src/core/generated-output-localization'
import type { AttachmentRef, ContentItem } from '../../src/core/types'
import {
  contentNeedsGeneratedOutputMaterialization,
  generatedOutputAttachmentId,
  generatedOutputAttachmentIds,
  localizedGeneratedOutputFilename,
  mergeGeneratedImageAttachmentRefs,
  prepareGeneratedOutputAttachments,
  prepareGeneratedOutputTerminalWrite,
} from '../../src/store/generated-images'

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='

describe('canonical generated-output preparation', () => {
  it('turns a remote image into a durable reference and deferred localization job without fetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const source = 'https://cdn.example/output.png'
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: 'remote-image',
      content: [{ type: 'output_image', url: source, prompt: 'red square' }],
      now: 10,
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(prepared.changed).toBe(true)
    expect(prepared.content).toEqual([
      {
        type: 'output_image',
        attachmentId: 'generated:remote-image:1',
        prompt: 'red square',
      },
    ])
    expect(prepared.newRefs).toHaveLength(1)
    expect(prepared.newRefs[0]).toMatchObject({
      attachmentId: 'generated:remote-image:1',
      includeInContext: true,
    })
    expect(prepared.attachmentBundles).toHaveLength(1)
    expect(prepared.attachmentBundles[0]?.attachment).toMatchObject({
      id: 'generated:remote-image:1',
      kind: 'image',
      origin: 'generated-output',
      sourceUrl: source,
      storage: { kind: 'remote-url', url: source },
    })
    expect(prepared.attachmentBundles[0]?.jobs).toEqual([
      expect.objectContaining({
        processorId: GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
        status: 'pending',
        nextAttemptAt: 10,
        task: {
          kind: GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
          expectedSourceUrl: source,
        },
      }),
    ])
  })

  it('materializes inline image bytes immediately and schedules no localization job', async () => {
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: 'inline-image',
      content: [{ type: 'output_image', url: ONE_PIXEL_PNG }],
      now: 20,
    })

    expect(prepared.content).toEqual([
      { type: 'output_image', attachmentId: 'generated:inline-image:1' },
    ])
    expect(prepared.attachmentBundles[0]?.attachment).toMatchObject({
      id: 'generated:inline-image:1',
      kind: 'image',
      mime: 'image/png',
      origin: 'generated-output',
      storage: { kind: 'local-blob' },
    })
    expect(
      prepared.attachmentBundles[0]?.jobs.some(
        (job) => job.processorId === GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
      ),
    ).toBe(false)
    expect(prepared.attachmentBundles[0]?.blobs.some((blob) => blob.role === 'original')).toBe(true)
  })

  it('canonicalizes inline audio while preserving transcript and format metadata', async () => {
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: 'inline-audio',
      content: [
        {
          type: 'audio_output',
          url: 'data:audio/wav;base64,UklGRg==',
          transcript: 'Hi',
          format: 'wav',
          durationMs: 12,
        },
      ],
      now: 30,
    })

    expect(prepared.content).toEqual([
      {
        type: 'audio_output',
        attachmentId: 'generated:inline-audio:audio:1',
        transcript: 'Hi',
        format: 'wav',
        durationMs: 12,
      },
    ])
    expect(prepared.attachmentBundles[0]?.attachment).toMatchObject({
      kind: 'audio',
      mime: 'audio/wav',
      origin: 'generated-output',
      storage: { kind: 'local-blob' },
    })
  })

  it('prepares every remote media kind as a bounded durable job set', async () => {
    const content: ContentItem[] = [
      { type: 'output_image', url: 'https://cdn.example/a.webp' },
      { type: 'audio_output', url: 'https://cdn.example/a.mp3' },
      { type: 'output_video', url: 'https://cdn.example/a.mp4', prompt: 'motion' },
      {
        type: 'file',
        url: 'https://cdn.example/report.pdf',
        filename: 'report.pdf',
        mime: 'application/pdf',
      },
    ]
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: 'remote-media',
      content,
      now: 40,
    })

    expect(prepared.changed).toBe(true)
    expect(prepared.content.every((item) => !('url' in item))).toBe(true)
    expect(prepared.newRefs).toHaveLength(4)
    expect(prepared.attachmentBundles).toHaveLength(4)
    expect(prepared.attachmentBundles.map((bundle) => bundle.jobs.length)).toEqual([1, 1, 1, 1])
    expect(prepared.attachmentBundles.map((bundle) => bundle.attachment.storage.kind)).toEqual([
      'remote-url',
      'remote-url',
      'remote-url',
      'remote-url',
    ])
  })

  it('builds one canonical terminal write and preserves unrelated attachment refs', async () => {
    const existing: AttachmentRef = {
      refId: 'existing-ref',
      attachmentId: 'existing-attachment',
      includeInContext: false,
      presentation: {},
      createdAt: 1,
      updatedAt: 1,
    }
    const prepared = await prepareGeneratedOutputTerminalWrite({
      messageId: 'terminal-output',
      content: [{ type: 'output_image', url: 'https://cdn.example/final.png' }],
      attachmentRefs: [existing],
      now: 50,
      requestCredential: {
        profileId: 'profile-at-dispatch',
        selectedKeyId: 'accepted-fallback-key',
      },
    })

    expect(prepared).toBeDefined()
    expect(contentNeedsGeneratedOutputMaterialization(prepared?.content ?? [])).toBe(false)
    expect(prepared?.attachmentRefs).toHaveLength(2)
    expect(prepared?.attachmentRefs[0]).toMatchObject(existing)
    expect(prepared?.attachmentRefs[1]).toMatchObject({
      attachmentId: 'generated:terminal-output:1',
    })
    expect(prepared?.attachmentBundles[0]?.jobs[0]?.task).toMatchObject({
      expectedSourceUrl: 'https://cdn.example/final.png',
      requestCredential: {
        profileId: 'profile-at-dispatch',
        selectedKeyId: 'accepted-fallback-key',
      },
    })
  })

  it('deduplicates new live refs without reviving or discarding existing ref history', async () => {
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: 'merge-output',
      content: [{ type: 'output_image', url: ONE_PIXEL_PNG }],
      now: 60,
    })
    const first = mergeGeneratedImageAttachmentRefs([], prepared.newRefs, 'merge-output', 60)
    const second = mergeGeneratedImageAttachmentRefs(
      first.refs,
      prepared.newRefs,
      'merge-output',
      61,
    )

    expect(first.addedRefs).toHaveLength(1)
    expect(second.addedRefs).toHaveLength(0)
    expect(second.refs).toEqual(first.refs)
    expect(generatedOutputAttachmentIds(prepared.content)).toEqual(
      new Set(['generated:merge-output:1']),
    )
  })

  it('leaves unsupported URLs untouched and rejects them at the canonical terminal boundary', async () => {
    const content: ContentItem[] = [{ type: 'output_image', url: 'ftp://example.invalid/a.png' }]
    const prepared = await prepareGeneratedOutputAttachments({
      messageId: 'unsupported-output',
      content,
      now: 70,
    })

    expect(prepared).toMatchObject({
      changed: false,
      content,
      newRefs: [],
      attachmentBundles: [],
    })
    await expect(
      prepareGeneratedOutputTerminalWrite({
        messageId: 'unsupported-output',
        content,
        attachmentRefs: [],
        now: 70,
      }),
    ).rejects.toThrow('GeneratedOutputMaterializationFailed:unsupported-output')
  })

  it('keeps deterministic ids and localized filenames independent of persistence', () => {
    expect(
      generatedOutputAttachmentId(
        'message',
        { type: 'output_image', url: 'https://cdn.example/a.png' },
        2,
      ),
    ).toBe('generated:message:3')
    expect(
      generatedOutputAttachmentId(
        'message',
        { type: 'output_video', url: 'https://cdn.example/a.mp4' },
        2,
      ),
    ).toBe('generated:message:video:3')
    expect(localizedGeneratedOutputFilename('generated.bin', 'image/webp', 'image')).toBe(
      'generated.webp',
    )
    expect(localizedGeneratedOutputFilename('clip.bin', 'video/mp4', 'video')).toBe('clip.mp4')
    expect(localizedGeneratedOutputFilename('report.pdf', 'application/pdf', 'file')).toBe(
      'report.pdf',
    )
  })
})
