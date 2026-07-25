import { describe, expect, it } from 'vitest'
import { normalizeProviderOutputOwnershipRowsV82 } from '../../src/backcompat/provider-output-items'
import { createAppliedMessageView } from '../../src/core/continuation-content'
import {
  GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  projectProviderOutputForContext,
  renderProviderOutputContextFallback,
} from '../../src/core/provider-tool-context'

function legacyRows() {
  return {
    header: {
      id: 'assistant-1',
      chatId: 'chat-1',
      bodyVersion: 2,
      nodeVersion: 5,
      requestContextVersion: 4,
      contextRouteFacts: {
        reasoningCarriers: [{ kind: 'responses-encrypted' }],
        hasOpenAiResponsesProviderOutput: false,
      },
      generation: {
        serverTools: [
          {
            type: 'code_interpreter_call',
            source: 'responses-output' as const,
            outputIndex: 0,
            output: {
              id: 'ci-1',
              type: 'code_interpreter_call',
              status: 'completed',
            },
          },
        ],
      },
    },
    body: {
      id: 'assistant-1',
      chatId: 'chat-1',
      bodyVersion: 2,
      updatedAt: 10,
      content: [{ type: 'output_text', text: '  answer\nfrom tool  ' }],
    },
  }
}

describe('provider-output backcompat ownership', () => {
  it('moves legacy output into the cold body and advances coherent semantic versions once', () => {
    const stored = legacyRows()
    const normalized = normalizeProviderOutputOwnershipRowsV82(stored.header, stored.body)

    expect(normalized.header).toMatchObject({
      bodyVersion: 3,
      nodeVersion: 6,
      requestContextVersion: 6,
      contextRouteFacts: {
        reasoningCarriers: [{ kind: 'responses-encrypted' }],
        hasOpenAiResponsesProviderOutput: true,
      },
    })
    expect(normalized.header.generation?.serverTools?.[0]).not.toHaveProperty('output')
    expect(normalized.body).toMatchObject({
      bodyVersion: 3,
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'code_interpreter_call',
          outputIndex: 0,
          item: {
            id: 'ci-1',
            type: 'code_interpreter_call',
            status: 'completed',
          },
        },
      ],
    })
    expect(normalized.preview).toEqual({
      id: 'assistant-1',
      chatId: 'chat-1',
      bodyVersion: 3,
      text: 'answer from tool',
    })
  })

  it('is idempotent after the ownership move', () => {
    const stored = legacyRows()
    const first = normalizeProviderOutputOwnershipRowsV82(stored.header, stored.body)
    const second = normalizeProviderOutputOwnershipRowsV82(first.header, first.body)

    expect(second).toEqual({
      header: first.header,
      body: first.body,
      headerChanged: false,
      bodyChanged: false,
    })
  })

  it('removes Gemini thought signatures only from provider-output payloads', () => {
    const normalized = normalizeProviderOutputOwnershipRowsV82(
      {
        id: 'assistant-2',
        chatId: 'chat-1',
        bodyVersion: 1,
        nodeVersion: 1,
        requestContextVersion: 1,
      },
      {
        id: 'assistant-2',
        chatId: 'chat-1',
        bodyVersion: 1,
        updatedAt: 10,
        providerOutputItems: [
          {
            dialect: 'google-gemini',
            type: 'google:code_execution',
            item: {
              thoughtSignature: 'carrier-owned-elsewhere',
              executableCode: { code: 'print(1)', thoughtSignature: 'nested-carrier' },
            },
          },
        ],
      },
    )

    expect(normalized.body.providerOutputItems).toEqual([
      {
        dialect: 'google-gemini',
        type: 'google:code_execution',
        item: { executableCode: { code: 'print(1)' } },
      },
    ])
    expect(normalized.header.contextRouteFacts).toEqual({
      reasoningCarriers: [],
      hasOpenAiResponsesProviderOutput: false,
    })
  })
})

describe('provider-output portable context', () => {
  it('uses one bounded semantic fallback for output from another provider dialect', () => {
    const projection = projectProviderOutputForContext(
      createAppliedMessageView({
        content: [{ type: 'output_text', text: 'answer' }],
        providerOutputItems: [
          {
            dialect: 'openai-responses',
            type: 'web_search_call',
            item: {
              type: 'web_search_call',
              status: 'completed',
              query: 'portable evidence',
              results: [{ url: 'https://example.com/evidence' }],
            },
          },
        ],
      }),
      GOOGLE_PROVIDER_OUTPUT_CONTRACT,
    )

    expect(renderProviderOutputContextFallback(projection)).toBe(`<tool_evidence>
<tool_call>
Tool: Web search
Dialect: openai-responses
Type: web_search_call
Status: completed
Query: portable evidence
Sources:
- https://example.com/evidence
</tool_call>
</tool_evidence>`)
  })
})
