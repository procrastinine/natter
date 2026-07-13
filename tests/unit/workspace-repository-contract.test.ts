import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, openDb } from '../../src/store/db'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import {
  expectWorkspaceRepositoryCoreContract,
  expectWorkspaceRepositoryRollbackContract,
} from '../helpers/workspace-repository-contract'

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete('natter')
}

describe('browser WorkspaceRepository contract', () => {
  beforeEach(async () => {
    await reset()
    await openDb()
  })

  afterEach(reset)

  it('satisfies the reusable core read/write/version/branch contract', async () => {
    await expectWorkspaceRepositoryCoreContract(getBrowserRepository())
  })

  it('rolls failed mutation callbacks back atomically', async () => {
    await expectWorkspaceRepositoryRollbackContract(getBrowserRepository())
  })

  it('keeps default singleton selection and explicit test override exact', () => {
    const browser = getBrowserRepository()
    expect(getWorkspaceRepository()).toBe(browser)
    const override = new Proxy(browser, {})
    __setWorkspaceRepositoryForTests(override)
    expect(getWorkspaceRepository()).toBe(override)
    __resetWorkspaceRepositoryForTests()
    expect(getWorkspaceRepository()).toBe(browser)
  })
})
