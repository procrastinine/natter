import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { loadKnownBranchPageSnapshot } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import type { WorkspaceRepository } from '../../src/store/repository'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import {
  expectWorkspaceRepositoryCoreContract,
  expectWorkspaceRepositoryExpectedLeafAppendContract,
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

  it('atomically admits one append to an expected live leaf', async () => {
    await expectWorkspaceRepositoryExpectedLeafAppendContract(getBrowserRepository())
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

  it('routes the public active-branch page loader through the repository boundary', async () => {
    const result = {
      kind: 'stale-path' as const,
      chatId: 'delegated-chat',
      reason: 'non-contiguous' as const,
      messageId: 'delegated-child',
    }
    const getKnownBranchPageSnapshot = vi.fn(async () => result)
    __setWorkspaceRepositoryForTests({
      getKnownBranchPageSnapshot,
    } as unknown as WorkspaceRepository)

    await expect(
      loadKnownBranchPageSnapshot('delegated-chat', ['delegated-root', 'delegated-child'], {
        offset: 1,
        limit: 1,
      }),
    ).resolves.toBe(result)
    expect(getKnownBranchPageSnapshot).toHaveBeenCalledOnce()
    expect(getKnownBranchPageSnapshot).toHaveBeenCalledWith(
      'delegated-chat',
      ['delegated-root', 'delegated-child'],
      { offset: 1, limit: 1 },
    )
  })
})
