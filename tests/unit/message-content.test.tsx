import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageContent } from '../../src/ui/chat/MessageContent'
import { installPresentationWorkspaceFence } from '../helpers/presentation-interactions'

beforeEach(() => {
  installPresentationWorkspaceFence('message-content')
})

describe('MessageContent', () => {
  it('does not render unlocalized generated output URLs even when the text lane is empty', () => {
    const url = 'data:image/png;base64,abc123'
    const { container } = render(
      <MessageContent content={[{ type: 'output_image', url, prompt: 'red square' }]} text="" />,
    )
    expect(container.querySelector('[data-ui="message-output-image"] img')).toBeNull()
  })

  it('does not prefetch raw generated audio or video before localization', () => {
    const { container } = render(
      <MessageContent
        content={[
          { type: 'audio_output', url: 'https://media.example.test/output.mp3' },
          { type: 'output_video', url: 'https://media.example.test/output.mp4' },
        ]}
        text=""
      />,
    )

    expect(container.querySelector('audio')).toBeNull()
    expect(container.querySelector('video')).toBeNull()
  })

  it('renders structured citations through the shared transcript/tree content path without rewriting text', () => {
    const content = [
      {
        type: 'output_text' as const,
        text: 'Alpha source',
        annotations: [
          {
            type: 'url_citation' as const,
            url: 'https://example.com/source',
            title: 'Example source',
            startIndex: 6,
            endIndex: 12,
            source: 'openai-responses' as const,
            providerPayload: {
              type: 'url_citation',
              url: 'https://example.com/source',
              start_index: 6,
              end_index: 12,
            },
          },
        ],
      },
    ]
    const original = structuredClone(content)
    const { container } = render(<MessageContent content={content} text="Alpha source" />)

    const citation = container.querySelector('[data-ui="citation-link"]')
    expect(citation?.getAttribute('href')).toBe('https://example.com/source')
    expect(citation?.getAttribute('data-citation-kind')).toBe('url')
    expect(container.textContent).toContain('Alpha source')
    expect(content).toEqual(original)
  })

  it('keeps compact citation projection bounded to the visible prefix', () => {
    const prefix = 'Alpha source'.padEnd(8_100, '.')
    const coldTail = {
      type: 'output_text' as const,
      get text(): string {
        throw new Error('compact citation projection read the cold tail')
      },
    }
    const { container } = render(
      <MessageContent
        collapseMode="compact"
        content={[
          {
            type: 'output_text',
            text: prefix,
            annotations: [
              {
                type: 'url_citation',
                url: 'https://example.com/source',
                startIndex: 6,
                endIndex: 12,
                source: 'openai-responses',
                providerPayload: {
                  type: 'url_citation',
                  url: 'https://example.com/source',
                },
              },
            ],
          },
          coldTail,
        ]}
        text={prefix}
      />,
    )

    expect(container.querySelector('[data-ui="citation-link"]')).not.toBeNull()
    expect(container.textContent.endsWith('...')).toBe(true)
  })

  it('routes generated-media context changes through the attachment mutation boundary', () => {
    const onMutateAttachmentRef = vi.fn()
    const { container } = render(
      <MessageContent
        content={[
          {
            type: 'output_image',
            attachmentId: 'generated-image-1',
            prompt: 'red square',
          },
        ]}
        text=""
        messageId="assistant-1"
        attachmentRefs={[
          {
            refId: 'generated-ref-1',
            attachmentId: 'generated-image-1',
            includeInContext: true,
            presentation: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        onMutateAttachmentRef={onMutateAttachmentRef}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Hide generated image from context' }))

    expect(
      container.querySelector('[data-ui="message-output-image-context-toggle"]'),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(onMutateAttachmentRef).toHaveBeenCalledWith({
      kind: 'visibility',
      refId: 'generated-ref-1',
      includeInContext: false,
    })
  })
})
