import { fireEvent, render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveCapabilityFromEndpoints } from '../../src/core/capabilities'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ModelEndpoint } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { ContextPanel } from '../../src/ui/settings/ContextPanel'

const DB_NAME = 'natter'

function makeEndpoint(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name: 'OpenAI',
    supported_parameters: ['max_tokens'],
    context_length: 128000,
    max_prompt_tokens: 128000,
    max_completion_tokens: 8192,
    pricing: {},
    ...overrides,
  }
}

async function resetAll() {
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('ContextPanel slider persistence', () => {
  it('does not persist max context on every drag tick, only after the value settles', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o-mini'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const { container } = render(
      <ContextPanel
        chat={chat}
        capability={capability}
        endpointTokenizer={null}
      />,
    )

    const sliders = container.querySelectorAll<HTMLInputElement>('[data-ui="slider"]')
    const maxContext = sliders[0]
    expect(maxContext).toBeTruthy()
    fireEvent.change(maxContext as HTMLInputElement, { target: { value: '4096' } })

    expect((await getChat(chat.id))?.settings.customMaxContext).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 250))
    await waitFor(async () => {
      expect((await getChat(chat.id))?.settings.customMaxContext).toBe(4096)
    })
  })
})
