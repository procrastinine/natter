import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey, getKey } from '../../src/store/keys'
import { listPresets } from '../../src/store/presets'
import { createProfile, getProfile, listProfiles } from '../../src/store/profiles'
import { ConnectionHeader, writeActiveProfileId } from '../../src/ui/header/ConnectionHeader'

const DB_NAME = 'natter'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  window.localStorage.clear()
  await Dexie.delete(DB_NAME)
}

async function seedProfile(
  overrides: Partial<Parameters<typeof createProfile>[0]> & { key?: string | null } = {},
) {
  const name = overrides.name ?? 'OpenRouter'
  const key =
    overrides.key === undefined
      ? 'sk-or-v1-test-0000000000000000000000000000000000000000'
      : overrides.key
  const apiKeyRef = key === null ? newId() : (await createKey({ name, plaintextKey: key })).id
  return createProfile({
    name,
    kind: overrides.kind ?? 'openrouter',
    baseUrl: overrides.baseUrl ?? 'https://openrouter.ai/api/v1',
    apiKeyRef,
  })
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

describe('ConnectionHeader', () => {
  it('creates a first connection from the full setup dialog with any provider + name', async () => {
    render(<ConnectionHeader />)
    fireEvent.click(screen.getByText('Add connection'))
    await waitFor(() => {
      expect(screen.getByLabelText('Add connection')).toBeTruthy()
    })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local llama' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'llama-server' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.getByText('Local llama')).toBeTruthy()
    })
    const profiles = await listProfiles()
    const presets = await listPresets()
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.kind).toBe('llama-server')
    expect(profiles[0]?.name).toBe('Local llama')
    expect(presets).toHaveLength(1)
  })

  it('shows Edit, Test, and Delete in viewer mode and tests non-llama connections', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/models')) {
        return Promise.resolve(jsonResponse({ data: [{ id: 'openai/gpt-4o-mini' }] }))
      }
      return Promise.resolve(
        jsonResponse({
          id: 'gen-test',
          model: 'openai/gpt-4o-mini',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      )
    })
    render(<ConnectionHeader />)
    await waitFor(() => {
      expect(screen.getByText('OpenRouter')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('OpenRouter'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    })
    expect(
      screen
        .getByRole('button', { name: 'Edit' })
        .closest('[data-ui="connection-actions-leading"]'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Test' })).toBeTruthy()
    expect(
      screen
        .getByRole('button', { name: 'Delete connection' })
        .closest('[data-ui="connection-actions-trailing"]'),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(screen.getByText(/Completed test chat/i)).toBeTruthy()
    })
  })

  it('falls back to a bundled Anthropic probe model when /models is unavailable', async () => {
    const profile = await seedProfile({
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      key: 'sk-ant-test',
    })
    writeActiveProfileId(profile.id)
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input)
      if (url.endsWith('/models')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'Invalid bearer token' } }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      return Promise.resolve(
        jsonResponse({
          id: 'gen-test',
          model: 'claude-haiku-4-5-20251001',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      )
    })
    render(<ConnectionHeader />)
    await waitFor(() => {
      expect(screen.getByText('Anthropic')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Anthropic'))
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(screen.getByText(/Completed test chat/i)).toBeTruthy()
    })
  })

  it('opens a confirmation dialog before deleting a connection', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader />)
    await waitFor(() => {
      expect(screen.getByText('OpenRouter')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('OpenRouter'))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete connection' }))
    expect(screen.getByRole('dialog', { name: 'Delete connection?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(async () => {
      expect(await listProfiles()).toHaveLength(0)
    })
  })

  it('saves in place when the name stays the same and keeps the original key when left blank', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader />)
    await waitFor(() => {
      expect(screen.getByText('OpenRouter')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('OpenRouter'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
    })
    const updated = await getProfile(profile.id)
    expect(updated?.kind).toBe('openai-compatible')
    expect(updated?.apiKeyRef).toBe(profile.apiKeyRef)
  })

  it('saves as new automatically when the name changes and blank key means no key', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader />)
    await waitFor(() => {
      expect(screen.getByText('OpenRouter')).toBeTruthy()
    })
    fireEvent.click(screen.getByText('OpenRouter'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OpenRouter copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.getByText('OpenRouter copy')).toBeTruthy()
    })
    const profiles = await listProfiles()
    const copy = profiles.find((row) => row.name === 'OpenRouter copy')
    expect(profiles).toHaveLength(2)
    expect(copy).toBeTruthy()
    if (!copy) {
      throw new Error('expected copied profile to exist')
    }
    expect(await getKey(copy.apiKeyRef)).toBeUndefined()
  })
})
