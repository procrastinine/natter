import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveCapabilityFromEndpoints } from '../../src/core/capabilities'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ModelEndpoint } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { ParamForm } from '../../src/ui/settings/ParamForm'

const DB_NAME = 'natter'

function makeEndpoint(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name: 'Anthropic',
    supported_parameters: ['max_tokens', 'verbosity'],
    context_length: 200000,
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
  vi.restoreAllMocks()
  await resetAll()
})

describe('ParamForm verbosity reset', () => {
  it('renders a leftmost default option for Claude verbosity controls', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-opus-4.6'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints('anthropic/claude-opus-4.6', [
      makeEndpoint(),
    ])
    const { container } = render(<ParamForm chat={chat} capability={capability} />)
    const section = container.querySelector('[data-ui-section="verbosity"]')
    expect(section).toBeTruthy()
    const labels = Array.from(
      section?.querySelectorAll<HTMLButtonElement>('[data-ui="segmented-option"]') ?? [],
    ).map((button) => button.textContent)
    expect(labels).toEqual(['default', 'low', 'medium', 'high', 'max'])
    expect(screen.getByRole('button', { name: 'default' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('clears stored verbosity when default is selected', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'anthropic/claude-opus-4.6'
    settings.verbosity = 'high'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints('anthropic/claude-opus-4.6', [
      makeEndpoint(),
    ])
    render(<ParamForm chat={chat} capability={capability} />)
    fireEvent.click(screen.getByRole('button', { name: 'default' }))
    await waitFor(async () => {
      const updated = await getChat(chat.id)
      expect(updated?.settings.verbosity).toBeUndefined()
      expect('verbosity' in (updated?.settings ?? {})).toBe(false)
    })
  })
})
