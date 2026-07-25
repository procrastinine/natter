import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests } from '../../src/store/db'
import { readGlobalPreferences } from '../../src/store/global-settings'
import { GeneralSettings } from '../../src/ui/settings/GeneralSettings'

const DB_NAME = 'natter'

describe('GeneralSettings', () => {
  beforeEach(async () => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    __resetDbForTests()
    await Dexie.delete(DB_NAME)
    await openBrowserWorkspace()
  })

  afterEach(async () => {
    cleanup()
    await shutdownBrowserWorkspace()
    __resetDbForTests()
    await Dexie.delete(DB_NAME)
  })

  it('keeps token calibration mode in global settings without family controls', async () => {
    render(<GeneralSettings />)

    const mode = await screen.findByLabelText<HTMLSelectElement>('Mode')
    expect(screen.getByText('Token calibration')).toBeInTheDocument()
    expect(mode.value).toBe('adaptive')

    fireEvent.change(mode, { target: { value: 'global-only' } })

    await waitFor(async () => {
      expect((await readGlobalPreferences()).tokenCalibrationMode).toBe('global-only')
    })
    expect(screen.queryByText('Clear all calibration globally')).not.toBeInTheDocument()
  })
})
