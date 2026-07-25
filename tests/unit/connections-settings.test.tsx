import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { configurationController } from '../../src/store/configuration-controller'
import { __resetDbForTests } from '../../src/store/db'
import { interchangeApplication } from '../../src/store/interchange-application'
import { ConnectionsSettings } from '../../src/ui/settings/ConnectionsSettings'
import {
  createConfigurationChatPreset,
  createConfigurationProfile,
  getConfigurationProfile,
  listConfigurationChatPresets,
  listConfigurationProfiles,
} from '../helpers/configuration'

const DB_NAME = 'natter'

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetBroadcastForTests()
  __resetDbForTests()
  configurationController.rememberProfile(null)
  await Dexie.delete(DB_NAME)
  await openBrowserWorkspace()
})

afterEach(async () => {
  cleanup()
  configurationController.rememberProfile(null)
  await shutdownBrowserWorkspace()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
})

describe('ConnectionsSettings', () => {
  it('duplicates, archives, and explicitly reassigns dependents before deletion', async () => {
    const source = await createConfigurationProfile({
      name: 'Source',
      kind: 'openrouter',
      baseUrl: 'https://source',
    })
    const replacement = await createConfigurationProfile({
      name: 'Replacement',
      kind: 'openrouter',
      baseUrl: 'https://replacement',
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = source.id
    const preset = await createConfigurationChatPreset({
      name: 'Dependent',
      connectionProfileId: source.id,
      settings,
    })
    configurationController.rememberProfile(source.id)

    render(<ConnectionsSettings />)
    const sourceRow = (await screen.findByText('Source')).closest('article')
    if (!sourceRow) throw new Error('SourceManagerRowMissing')
    expect(within(sourceRow).getByText('1 presets')).toBeVisible()

    fireEvent.click(within(sourceRow).getByRole('button', { name: 'Duplicate' }))
    await waitFor(async () => {
      expect(await listConfigurationProfiles(true)).toHaveLength(3)
    })

    fireEvent.click(within(sourceRow).getByRole('button', { name: 'Archive' }))
    await within(sourceRow).findByRole('button', { name: 'Unarchive' })
    fireEvent.click(within(sourceRow).getByRole('button', { name: 'Unarchive' }))
    await within(sourceRow).findByRole('button', { name: 'Archive' })

    fireEvent.click(within(sourceRow).getByRole('button', { name: 'Delete' }))
    const replacementSelect = await screen.findByLabelText('Replacement connection')
    fireEvent.change(replacementSelect, { target: { value: replacement.id } })
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete connection?' })).getByRole('button', {
        name: 'Delete',
      }),
    )

    await waitFor(async () => {
      expect(await getConfigurationProfile(source.id)).toBeUndefined()
    })
    const activeSeed = configurationController.getSnapshot().seed
    expect(activeSeed.settings?.profileId || activeSeed.profileId).toBe(replacement.id)
    const reassigned = (await listConfigurationChatPresets(true)).find(
      (row) => row.id === preset.id,
    )
    expect(reassigned?.connectionProfileId).toBe(replacement.id)
    expect(reassigned?.settings.profileId).toBe(replacement.id)
  })

  it('imports the portable connection envelope without credentials', async () => {
    const source = await createConfigurationProfile({
      name: 'Portable',
      kind: 'custom',
      baseUrl: 'https://portable',
    })
    const envelope = await interchangeApplication.exportConnectionProfile(source.id)
    const view = render(<ConnectionsSettings />)
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) throw new Error('ConnectionImportInputMissing')

    fireEvent.change(input, {
      target: {
        files: [
          new File([JSON.stringify(envelope)], 'connection.json', { type: 'application/json' }),
        ],
      },
    })

    await waitFor(async () => {
      const profiles = await listConfigurationProfiles(true)
      expect(profiles.map((profile) => profile.name).sort()).toEqual(['Portable', 'Portable (2)'])
    })
  })
})
