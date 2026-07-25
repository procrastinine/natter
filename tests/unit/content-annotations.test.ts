import { describe, expect, it } from 'vitest'
import {
  anthropicWireCitations,
  normalizeContentAnnotations,
  normalizeGeminiGroundingAnnotations,
  planCitationDisplay,
  responsesWireAnnotations,
} from '../../src/core/content-annotations'

describe('content annotations', () => {
  it('normalizes OpenAI URL and provider-file citations without conflating file ids with attachments', () => {
    const text = 'Alpha beta.'
    const annotations = normalizeContentAnnotations(
      [
        {
          type: 'url_citation',
          start_index: 0,
          end_index: 5,
          url: 'https://example.com/source',
          title: 'Source',
        },
        {
          type: 'container_file_citation',
          start_index: 6,
          end_index: 10,
          file_id: 'provider-file-1',
          container_id: 'container-1',
          filename: 'evidence.txt',
        },
      ],
      { source: 'openai-responses', text },
    )

    expect(annotations).toEqual([
      expect.objectContaining({
        type: 'url_citation',
        startIndex: 0,
        endIndex: 5,
        url: 'https://example.com/source',
      }),
      expect.objectContaining({
        type: 'file_citation',
        startIndex: 6,
        endIndex: 10,
        file: {
          kind: 'provider-file',
          provider: 'openai-responses',
          fileId: 'provider-file-1',
          containerId: 'container-1',
        },
      }),
    ])
  })

  it('derives Anthropic cited-text offsets and preserves unknown payloads losslessly', () => {
    const unknown = { type: 'future_citation', opaque: { token: 'keep-me' } }
    const annotations = normalizeContentAnnotations(
      [
        {
          type: 'web_search_result_location',
          cited_text: 'second',
          url: 'https://example.com/second',
          title: 'Second',
          encrypted_index: 'encrypted',
        },
        unknown,
      ],
      { source: 'anthropic-messages', text: 'first then second' },
    )

    expect(annotations[0]).toMatchObject({ startIndex: 11, endIndex: 17 })
    expect(annotations[1]).toEqual({
      type: 'unknown',
      annotationType: 'future_citation',
      source: 'anthropic-messages',
      startIndex: 17,
      endIndex: 17,
      providerPayload: unknown,
    })
  })

  it('maps every Gemini grounding support source onto the supported text range', () => {
    const annotations = normalizeGeminiGroundingAnnotations(
      {
        groundingChunks: [
          { web: { uri: 'https://a.example', title: 'A' } },
          { web: { uri: 'https://b.example', title: 'B' } },
        ],
        groundingSupports: [
          { segment: { startIndex: 0, endIndex: 5 }, groundingChunkIndices: [0, 1] },
        ],
      },
      'Alpha beta',
    )
    expect(annotations).toHaveLength(2)
    expect(
      annotations.map((annotation) => annotation.type === 'url_citation' && annotation.url),
    ).toEqual(['https://a.example', 'https://b.example'])
    expect(
      annotations.every((annotation) => annotation.startIndex === 0 && annotation.endIndex === 5),
    ).toBe(true)
  })

  it('builds a linear opaque-marker plan for overlaps, invalid ranges, and surrogate boundaries', () => {
    const text = 'A😀B'
    const annotations = normalizeContentAnnotations(
      [
        { type: 'url_citation', start_index: 0, end_index: 2, url: 'https://safe.example/a' },
        { type: 'url_citation', start_index: 1, end_index: 99, url: 'https://safe.example/b' },
        { type: 'url_citation', start_index: 0, end_index: 1, url: 'javascript:alert(1)' },
      ],
      { source: 'openai-responses', text },
    )
    const plan = planCitationDisplay(text, annotations)

    expect(plan.targets).toHaveLength(2)
    expect(plan.markdown).not.toContain('https://')
    expect(plan.markdown).not.toContain('javascript:')
    expect(plan.markdown).toContain('[1](#natter-citation-c-0)')
    expect(plan.markdown).toContain('[2](#natter-citation-c-1)')
    expect(plan.markdown.replace(/ \[\d\]\([^)]*\)/gu, '')).toBe(text)
  })

  it('echoes only annotations owned by the matching provider dialect', () => {
    const responses = normalizeContentAnnotations(
      [{ type: 'url_citation', start_index: 0, end_index: 1, url: 'https://openai.example' }],
      { source: 'openai-responses', text: 'x' },
    )
    const anthropic = normalizeContentAnnotations(
      [{ type: 'char_location', cited_text: 'x', document_index: 0 }],
      { source: 'anthropic-messages', text: 'x' },
    )
    expect(responsesWireAnnotations([...responses, ...anthropic])).toEqual([
      expect.objectContaining({ url: 'https://openai.example' }),
    ])
    expect(anthropicWireCitations([...responses, ...anthropic])).toEqual([
      expect.objectContaining({ type: 'char_location' }),
    ])
  })

  it('does not trust incomplete canonical-looking annotations at the import boundary', () => {
    const annotations = normalizeContentAnnotations(
      [
        {
          type: 'url_citation',
          source: 'openai-responses',
          startIndex: 0,
          endIndex: 1,
          providerPayload: { type: 'url_citation' },
        },
        {
          type: 'file_citation',
          source: 'openai-responses',
          startIndex: 0,
          endIndex: 1,
          providerPayload: { type: 'file_citation' },
        },
      ],
      { source: 'imported', text: 'x' },
    )

    expect(annotations).toEqual([
      expect.objectContaining({ type: 'unknown', annotationType: 'url_citation' }),
      expect.objectContaining({
        type: 'file_citation',
        file: { kind: 'unresolved', provider: 'imported' },
      }),
    ])
  })
})
