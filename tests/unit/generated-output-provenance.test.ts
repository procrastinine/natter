import { describe, expect, it } from 'vitest'
import {
  prepareGeneratedOutputRemoteBundle,
  prepareGeneratedOutputTerminalWrite,
} from '../../src/store/generated-images'

const requestCredential = {
  profileId: 'profile-at-dispatch',
  selectedKeyId: 'accepted-fallback-key',
}

describe('generated-output request credential provenance', () => {
  it('binds the accepted request credential to every remote terminal output job', async () => {
    const prepared = await prepareGeneratedOutputTerminalWrite({
      messageId: 'assistant-message',
      content: [
        {
          type: 'output_image',
          url: 'https://openrouter.ai/api/v1/videos/generated/image.png',
        },
      ],
      attachmentRefs: [],
      now: 100,
      requestCredential,
    })

    expect(prepared?.attachmentBundles).toHaveLength(1)
    expect(prepared?.attachmentBundles[0]?.jobs).toHaveLength(1)
    expect(prepared?.attachmentBundles[0]?.jobs[0]?.task).toMatchObject({
      expectedSourceUrl: 'https://openrouter.ai/api/v1/videos/generated/image.png',
      requestCredential,
    })
  })

  it('copies the polling request credential onto resolved video child jobs', () => {
    const child = prepareGeneratedOutputRemoteBundle({
      id: 'resolved-video',
      url: 'https://openrouter.ai/api/v1/videos/generated/video.mp4',
      filename: 'video.mp4',
      mime: 'video/mp4',
      kind: 'video',
      now: 200,
      requestCredential,
    })

    expect(child.jobs).toHaveLength(1)
    expect(child.jobs[0]?.task).toMatchObject({
      expectedSourceUrl: 'https://openrouter.ai/api/v1/videos/generated/video.mp4',
      requestCredential,
    })
  })
})
