import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey, getKey } from '../../src/store/keys'
import { listPresets } from '../../src/store/presets'
import * as profileStore from '../../src/store/profiles'
import { createProfile, getProfile, listProfiles } from '../../src/store/profiles'
import { __setRepositoryMutationSubscriberForTests } from '../../src/store/reactive-query'
import {
  ConnectionHeader,
  readActiveProfileId,
  writeActiveProfileId,
} from '../../src/ui/header/ConnectionHeader'

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

function connectionButtonMatcher(name: string): RegExp {
  return new RegExp(`Connection: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
}

async function openConnectionPopover(name: string) {
  const button = await screen.findByRole('button', { name: connectionButtonMatcher(name) })
  fireEvent.click(button)
  await screen.findByRole('region', { name: `Connection: ${name}` })
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  // Unmount the React tree BEFORE resetting the DB. The header's
  // observable queries hold a live Dexie handle; closing the DB while
  // those are still resolving makes vitest flag a `DatabaseClosedError`
  // unhandled rejection. Cleanup first cancels the subscriptions.
  cleanup()
  __setRepositoryMutationSubscriberForTests(undefined)
  vi.restoreAllMocks()
  await new Promise((resolve) => setTimeout(resolve, 10))
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
    await waitFor(async () => {
      expect(await listProfiles()).toHaveLength(1)
      expect(await listPresets()).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add connection' })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Add connection' })).toBeNull()
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
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
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
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy()
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
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
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
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('Anthropic')
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(screen.getByText(/Completed test chat/i)).toBeTruthy()
    })
  })

  it('clears the completed connection test result when switching profiles', async () => {
    const a = await seedProfile({ name: 'OpenRouter A' })
    const b = await seedProfile({ name: 'OpenRouter B' })
    writeActiveProfileId(a.id)
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
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
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter A')
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    await waitFor(() => {
      expect(screen.getByText(/Completed test chat/i)).toBeTruthy()
    })

    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: b.id } })

    await waitFor(() => {
      expect(screen.getByText('OpenRouter B')).toBeTruthy()
    })
    expect(screen.queryByText(/Completed test chat/i)).toBeNull()
  })

  it('opens a confirmation dialog before deleting a connection', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
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
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
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
    render(<ConnectionHeader variant="title-icon" />)
    await openConnectionPopover('OpenRouter')
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'OpenRouter copy' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter copy') })
    const profiles = await listProfiles()
    const copy = profiles.find((row) => row.name === 'OpenRouter copy')
    expect(profiles).toHaveLength(2)
    expect(copy).toBeTruthy()
    if (!copy) {
      throw new Error('expected copied profile to exist')
    }
    expect(await getKey(copy.apiKeyRef)).toBeUndefined()
  })

  it('shows the active chat profile while viewed, then falls back to the remembered tab default', async () => {
    const a = await seedProfile({ name: 'OpenRouter A' })
    const b = await seedProfile({ name: 'OpenRouter B' })
    writeActiveProfileId(b.id)
    const { rerender } = render(
      <ConnectionHeader variant="title-icon" activeChatProfileId={a.id} />,
    )
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter A') })
    expect(readActiveProfileId()).toBe(b.id)
    rerender(<ConnectionHeader variant="title-icon" activeChatProfileId={null} />)
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter B') })
  })

  it('does not keep a cached profile visible after a later live deletion', async () => {
    const profile = await seedProfile()
    writeActiveProfileId(profile.id)
    render(<ConnectionHeader variant="title-icon" />)
    await screen.findByRole('button', { name: connectionButtonMatcher('OpenRouter') })

    await profileStore.deleteProfile(profile.id, { force: true })

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: connectionButtonMatcher('OpenRouter') }),
      ).toBeNull()
    })
  })

  it('keeps a saved profile through rerenders until its live query catches up', async () => {
    const pendingPublications: Array<() => void> = []
    __setRepositoryMutationSubscriberForTests(undefined, 'natter', undefined, (task) =>
      pendingPublications.push(task),
    )
    const view = render(<ConnectionHeader />)
    await waitFor(() => {
      expect(pendingPublications.length).toBeGreaterThan(0)
    })
    act(() => {
      for (const publish of pendingPublications.splice(0)) publish()
    })
    fireEvent.click(await screen.findByText('Add connection'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local llama' } })
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'llama-server' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Add connection' })).not.toBeInTheDocument()
    })

    view.rerender(<ConnectionHeader variant="mobile-menu" />)

    expect(screen.getByRole('region', { name: 'Connection: Local llama' })).toBeTruthy()
  })

  it('keeps the previous header state visible while the next profile load is still resolving', async () => {
    const a = await seedProfile({
      name: 'llama A',
      kind: 'llama-server',
      baseUrl: 'http://127.0.0.1:8080/v1',
      key: null,
    })
    const b = await seedProfile({
      name: 'llama B',
      kind: 'llama-server',
      baseUrl: 'http://127.0.0.1:8081/v1',
      key: null,
    })
    writeActiveProfileId(b.id)
    const listProfilesActual = profileStore.listProfiles
    let resolveBlockedRows!: (value: Awaited<ReturnType<typeof listProfilesActual>>) => void
    const blockedRows = new Promise<Awaited<ReturnType<typeof listProfilesActual>>>((resolve) => {
      resolveBlockedRows = resolve
    })
    const spy = vi.spyOn(profileStore, 'listProfiles')
    let blockNextLoad = false
    spy.mockImplementation(() => {
      if (blockNextLoad) {
        blockNextLoad = false
        return blockedRows
      }
      return listProfilesActual()
    })

    const { rerender } = render(
      <ConnectionHeader variant="title-icon" activeChatProfileId={a.id} />,
    )
    await screen.findByRole('button', { name: connectionButtonMatcher('llama A') })

    blockNextLoad = true
    rerender(<ConnectionHeader variant="title-icon" activeChatProfileId={null} />)
    expect(screen.queryByText('No connection configured')).toBeNull()
    expect(screen.getByRole('button', { name: connectionButtonMatcher('llama A') })).toBeTruthy()

    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(2)
    })
    resolveBlockedRows(await listProfilesActual())

    await waitFor(() => {
      expect(screen.getByRole('button', { name: connectionButtonMatcher('llama B') })).toBeTruthy()
    })
  })
})
