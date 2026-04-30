// Live direct-provider mode checks. Gated behind `LIVE=1`.
// Keeps prompts tiny; uses keys.json.openai/google/anthropic.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { anthropicOnce, type AnthropicContext } from '../../src/api/anthropic-messages'
import {
  chatCompletionsOnce,
  type ChatCompletionsContext,
} from '../../src/api/chat-completions'
import type { ConnectionProfile } from '../../src/core/types'

const LIVE = process.env.LIVE === '1'

function loadKey(name: 'openai' | 'google' | 'anthropic'): string {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  const key = (JSON.parse(raw) as Record<string, string>)[name]
  if (!key) throw new Error(`keys.json missing ${name}`)
  return key
}

function profile(input: {
  id: string
  name: string
  kind: ConnectionProfile['kind']
  baseUrl: string
}): ConnectionProfile {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    baseUrl: input.baseUrl,
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter-live-probe',
    appUrl: 'http://localhost',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function textFromChat(result: {
  choices?: Array<{ message?: { content?: string | null } }>
}): string {
  return result.choices?.[0]?.message?.content ?? ''
}

function textFromAnthropic(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return result.content?.find((block) => block.type === 'text')?.text ?? ''
}

describe.skipIf(!LIVE)('live — direct provider API modes', () => {
  let openAi: ChatCompletionsContext
  let googleCompat: ChatCompletionsContext
  let anthropicMessages: AnthropicContext
  let anthropicCompat: ChatCompletionsContext

  beforeAll(() => {
    openAi = {
      profile: profile({
        id: 'oa',
        name: 'OpenAI',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
      }),
      apiKey: loadKey('openai'),
    }
    googleCompat = {
      profile: profile({
        id: 'g',
        name: 'Google',
        kind: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      }),
      apiKey: loadKey('google'),
    }
    anthropicMessages = {
      profile: profile({
        id: 'a',
        name: 'Anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
      }),
      apiKey: loadKey('anthropic'),
    }
    anthropicCompat = {
      profile: anthropicMessages.profile,
      apiKey: anthropicMessages.apiKey,
    }
  })

  it('OpenAI direct Chat Completions responds on a chat-capable model', async () => {
    const result = await chatCompletionsOnce(openAi, {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Reply with exactly: natter-live-openai-chat' }],
      max_tokens: 20,
    })
    expect(textFromChat(result).toLowerCase()).toContain('natter-live-openai-chat')
  }, 60_000)

  it('Google OpenAI-compat chat-completions shim responds', async () => {
    const result = await chatCompletionsOnce(googleCompat, {
      model: 'gemini-3.1-flash-lite-preview',
      messages: [{ role: 'user', content: 'Reply with exactly: natter-live-google-compat' }],
      max_tokens: 20,
    })
    expect(textFromChat(result).toLowerCase()).toContain('natter-live-google-compat')
  }, 60_000)

  it('Anthropic native Messages responds', async () => {
    const result = await anthropicOnce(anthropicMessages, {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Reply with exactly: natter-live-anthropic-messages' }],
      max_tokens: 30,
    })
    expect(textFromAnthropic(result).toLowerCase()).toContain('natter-live-anthropic-messages')
  }, 60_000)

  it('Anthropic OpenAI-compat chat-completions shim responds', async () => {
    const result = await chatCompletionsOnce(anthropicCompat, {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Reply with exactly: natter-live-anthropic-compat' }],
      max_tokens: 30,
    })
    expect(textFromChat(result).toLowerCase()).toContain('natter-live-anthropic-compat')
  }, 60_000)
})
