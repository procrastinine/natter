import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'
import { createChat, putTestChats, updateChatForTest } from '../helpers/chats'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { strFromU8, unzipSync } from 'fflate'
import type { ComponentProps } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import { GLOBAL_TOKEN_CALIBRATION_KEY } from '../../src/core/token-calibration'
import type { Chat, GlobalTokenCalibration } from '../../src/core/types'
import { ConfigurationPreferencesProvider } from '../../src/hooks/useConfigurationPreferences'
import {
  addExistingAttachmentRef,
  createRemoteAttachment,
  ingestAttachmentBytes,
} from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  CHAT_SIDEBAR_AGGREGATE_ID,
  chatSidebarProjectionRow,
  emptyChatSidebarAggregateRow,
} from '../../src/store/chat-sidebar-projection'
import {
  archiveChat,
  buildChat,
  deleteArchivedChatPermanently,
  emptyArchivedChats,
  setChatTagsFromNames,
} from '../../src/store/chats'
import { configurationLinksForChat } from '../../src/store/configuration-domain-contract'
import {
  CONFIGURATION_PROFILE_MANAGER_STATE_ID,
  type ConfigurationProfileManagerStateRow,
} from '../../src/store/configuration-profile-usage-projection'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { createFolder } from '../../src/store/folders'
import {
  exportChat,
  exportWorkspaceBackup,
  restoreWorkspaceBackup,
} from '../../src/store/import-export'
import { readTokenCalibrationGlobal } from '../../src/store/token-calibration'
import type { WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { jsonEntriesZipBlob } from '../../src/ui/import-export/json-file'
import { PresentationDialogHost } from '../../src/ui/primitives/PresentationDialogHost'
import {
  deleteAttachmentForStorage,
  StorageView as ProductionStorageView,
} from '../../src/ui/storage/StorageView'

function StorageView(props: Omit<ComponentProps<typeof ProductionStorageView>, 'onOpenSidebar'>) {
  return (
    <ConfigurationPreferencesProvider>
      <ProductionStorageView {...props} onOpenSidebar={() => undefined} />
      <PresentationDialogHost />
    </ConfigurationPreferencesProvider>
  )
}

import { testGenerationLease } from '../helpers/stream-leases'

const storageWipeMocks = vi.hoisted(() => ({
  clearLocalWorkspaceStorage: vi.fn<() => Promise<void>>(),
}))

vi.mock('../../src/store/storage-administration', () => storageWipeMocks)

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()
const originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage')
const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
const originalNotificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

function setNavigatorStorage(storage: Partial<StorageManager> | undefined): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: storage,
  })
}

function setNavigatorUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  })
}

function setNotificationApi(
  permission: NotificationPermission,
  requestPermissionResult: NotificationPermission = permission,
) {
  const requestPermission = vi
    .fn<() => Promise<NotificationPermission>>()
    .mockResolvedValue(requestPermissionResult)
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: {
      permission,
      requestPermission,
    },
  })
  return { requestPermission }
}

function setDaemonWorkspaceRepository(): WorkspaceRepository {
  const fence = { workspaceId: 'daemon:natter', replacementEpoch: 0 }
  const repo = {
    query: vi.fn(async (_permit: unknown, query: { kind: string }) => {
      const value =
        query.kind === 'workspace.meta'
          ? { ...fence, backendKind: 'daemon' }
          : query.kind === 'sidebar.aggregate'
            ? {
                totalCount: 0,
                activeCount: 0,
                archivedCount: 0,
                pinnedCount: 0,
                visibleCount: 0,
                visiblePinnedCount: 0,
                folderCounts: {},
                folderAggregates: {},
                rootCount: 0,
                rootVisibleCount: 0,
                rootVisiblePinnedCount: 0,
              }
            : query.kind === 'attachment.catalog-aggregate'
              ? {
                  totalCount: 0,
                  activeCount: 0,
                  deletedCount: 0,
                  referencedCount: 0,
                  unreferencedCount: 0,
                  localCount: 0,
                  remoteCount: 0,
                  missingCount: 0,
                  generatedCount: 0,
                  totalSizeBytes: 0,
                  localSizeBytes: 0,
                }
              : null
      return { ...fence, value }
    }),
    execute: vi.fn(async () => {
      throw new Error('UnexpectedDaemonStorageWrite')
    }),
    replace: vi.fn(async () => {
      throw new Error('UnexpectedDaemonStorageReplacement')
    }),
    subscribeChanges: vi.fn(() => () => undefined),
  } as unknown as WorkspaceRepository
  __setWorkspaceRepositoryForTests(repo)
  return repo
}

function bytes(content: string): Blob {
  return new Blob([new TextEncoder().encode(content)])
}

async function writeTokenCalibrationGlobal(value: GlobalTokenCalibration): Promise<void> {
  await getDb().settings.put({ key: GLOBAL_TOKEN_CALIBRATION_KEY, value })
}

function mockBlobDownloads() {
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const createdBlobs: Blob[] = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      createdBlobs.push(blob)
      return `blob:natter-${createdBlobs.length}`
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return {
    createdBlobs,
    clickSpy,
    restore() {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      })
    },
  }
}

function storageChatTitles(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-ui="storage-chat-title-cell"] > a'),
  ).map((element) => element.textContent)
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id.localeCompare(right.id)
}

async function resetRuntimeBindings() {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  useToastStore.getState().reset()
}

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

async function restoreEmptyWorkspace(): Promise<void> {
  await resetRuntimeBindings()
  await getDb().streamLeases.clear()
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
}

async function putActiveStreamLease(input: {
  streamId: string
  chatId: string
  messageId: string
}): Promise<void> {
  await getDb().streamLeases.put(
    testGenerationLease({
      ...input,
      ownerClientId: 'other-tab',
      fenceToken: `fence-${input.streamId}`,
      replacementEpoch: 0,
      startedAt: 1,
      heartbeatAt: 1,
      admissionSequence: 1,
      revision: 1,
      targetCommittedAt: 1,
      postCommit: { usedAt: 1, profileId: 'test-profile' },
    }),
  )
}

describe('StorageView', () => {
  beforeAll(async () => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    __resetWorkspaceRepositoryForTests()
    __resetBrowserRepositoryForTests()
    __resetBroadcastForTests()
    __resetDbForTests()
    await Dexie.delete(DB_NAME)
    await workspaceSuite.open()
    emptyWorkspaceBackup = await exportWorkspaceBackup()
  })

  beforeEach(async () => {
    await restoreEmptyWorkspace()
    storageWipeMocks.clearLocalWorkspaceStorage.mockReset()
    storageWipeMocks.clearLocalWorkspaceStorage.mockResolvedValue(undefined)
    const estimate = {
      usage: 4096,
      quota: 8192,
      usageDetails: { indexedDB: 1024, caches: 3072 },
    }
    setNavigatorStorage({
      estimate: vi.fn<StorageManager['estimate']>().mockResolvedValue(estimate),
      persist: vi.fn<StorageManager['persist']>().mockResolvedValue(true),
      persisted: vi.fn<StorageManager['persisted']>().mockResolvedValue(false),
    })
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    if (originalStorageDescriptor) {
      Object.defineProperty(navigator, 'storage', originalStorageDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'storage')
    }
    if (originalUserAgentDescriptor) {
      Object.defineProperty(navigator, 'userAgent', originalUserAgentDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'userAgent')
    }
    if (originalNotificationDescriptor) {
      Object.defineProperty(globalThis, 'Notification', originalNotificationDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, 'Notification')
    }
    await resetRuntimeBindings()
  })

  it('renders the overview as mode, space, chats, and attachments panels', async () => {
    await createChat({ title: 'One' })
    await ingestAttachmentBytes({
      blob: bytes('hello'),
      filename: 'note.txt',
      now: 10,
    })

    const { container } = render(<StorageView route={{ section: 'overview' }} />)

    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll('[data-ui="storage-panel-title"]')).map(
        (node) => node.textContent,
      )
      expect(titles).toEqual([
        'Mode',
        'Origin space',
        'Chats',
        'Attachments',
        'Global token calibration',
      ])
      expect(
        container.querySelector('[data-ui="storage-panel"][href="#/storage/chats"]'),
      ).toHaveTextContent('1')
      expect(
        container.querySelector('[data-ui="storage-panel"][href="#/storage/attachments"]'),
      ).toHaveTextContent('1 (5 B)')
      expect(container).toHaveTextContent('4.0 KB / 8.0 KB')
      expect(container).toHaveTextContent('Browser-reported usage / quota')
      expect(container).toHaveTextContent('Includes all storage for this browser origin')
      expect(container).toHaveTextContent('IndexedDB')
      expect(container).toHaveTextContent('Cache API')
      expect(container).toHaveTextContent('0 families')
      expect(
        container.querySelector('[data-ui="storage-panel-row"][data-role="calibration"]'),
      ).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('Token calibration mode')).not.toBeInTheDocument()
    expect(container).toHaveTextContent('Request persistence')
    expect(screen.getByRole('button', { name: 'Export all' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import all' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeInTheDocument()
    expect(container.querySelector('[aria-label="Backups"]')).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('All attachments')
    expect(container).not.toHaveTextContent('Missing')
    expect(container).not.toHaveTextContent('Unreferenced')
    expect(container).not.toHaveTextContent('Archive')
  })

  it('triggers attachment download from the details panel', async () => {
    const attachment = await createRemoteAttachment({
      url: 'https://example.test/note.txt',
      filename: 'note.txt',
      mime: 'text/plain',
      now: 10,
    })
    const appendSpy = vi.spyOn(document.body, 'appendChild')
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<StorageView route={{ section: 'attachments', attachmentId: attachment.id }} />)

    const download = await screen.findByRole('button', { name: 'Download note.txt' })
    await waitFor(() => expect(download).toBeEnabled())
    fireEvent.click(download)

    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    const anchor = appendSpy.mock.calls
      .map(([node]) => node)
      .find(
        (node): node is HTMLAnchorElement =>
          node instanceof HTMLAnchorElement && node.download === 'note.txt',
      )
    expect(anchor?.href).toBe('https://example.test/note.txt')
  })

  it('does not escalate a stale unreferenced delete into referenced byte deletion', async () => {
    const chat = await createChat({ title: 'Race target' })
    const bundle = await ingestAttachmentBytes({
      blob: bytes('keep these bytes'),
      filename: 'race.txt',
      now: 10,
    })
    const stale = structuredClone(bundle.attachment)
    expect(stale.refCount).toBe(0)
    await addExistingAttachmentRef({
      draftChatId: chat.id,
      attachmentId: stale.id,
      now: 20,
    })

    await expect(deleteAttachmentForStorage(stale)).resolves.toBe(false)
    const stored = await getDb().attachments.get(stale.id)
    expect(stored?.refCount).toBe(1)
    expect(stored?.storage.kind).toBe('local-blob')
    expect(await getDb().attachmentBlobs.where('attachmentId').equals(stale.id).count()).toBe(1)
  })

  it('requests notification permission and shows Chromium/Safari persistence hints in browser mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persist = vi.fn<StorageManager['persist']>().mockResolvedValue(false)
    const persisted = vi.fn<StorageManager['persisted']>().mockResolvedValue(false)
    setNavigatorStorage({
      estimate: vi.fn<StorageManager['estimate']>().mockResolvedValue({
        usage: 4096,
        quota: 8192,
      }),
      persist,
      persisted,
    })
    setNavigatorUserAgent(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    )
    const notification = setNotificationApi('default', 'granted')

    const { container } = render(<StorageView route={{ section: 'overview' }} />)

    await waitFor(() => {
      expect(container).toHaveTextContent('bookmarking this page')
      expect(container).toHaveTextContent('installing Natter as an app')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Request persistence' }))

    await waitFor(() => {
      expect(notification.requestPermission).toHaveBeenCalledTimes(1)
      expect(persist).toHaveBeenCalledTimes(1)
    })
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('storage persistence denied'))
  })

  it('hides browser persistence actions outside IndexedDB mode', async () => {
    const persist = vi.fn<StorageManager['persist']>().mockResolvedValue(true)
    setNavigatorStorage({
      estimate: vi.fn<StorageManager['estimate']>().mockResolvedValue({
        usage: 4096,
        quota: 8192,
      }),
      persist,
      persisted: vi.fn<StorageManager['persisted']>().mockResolvedValue(false),
    })
    setNavigatorUserAgent(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    )
    const notification = setNotificationApi('default', 'granted')
    setDaemonWorkspaceRepository()

    const { container } = render(<StorageView route={{ section: 'overview' }} />)

    await waitFor(() => {
      expect(container).toHaveTextContent('Daemon')
    })
    expect(screen.queryByRole('button', { name: 'Request persistence' })).not.toBeInTheDocument()
    expect(container).not.toHaveTextContent('bookmarking this page')
    expect(notification.requestPermission).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  it('runs the local data wipe from the overview clear-all action', async () => {
    render(<StorageView route={{ section: 'overview' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }))
    const dialog = await screen.findByRole('dialog', { name: 'Clear all local data?' })
    expect(dialog).toHaveTextContent('This removes chats, presets, connections, keys')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear and reload' }))

    await waitFor(() => {
      expect(storageWipeMocks.clearLocalWorkspaceStorage).toHaveBeenCalledTimes(1)
    })
  })

  it('exports a full workspace backup from the overview', async () => {
    await createChat({ id: 'chat-alpha', title: 'Alpha' })
    const downloads = mockBlobDownloads()
    try {
      render(<StorageView route={{ section: 'overview' }} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Export all' }))
      expect(
        screen.getByRole('dialog', { name: 'Export sensitive workspace backup?' }),
      ).toBeVisible()
      expect(screen.getByText(/browser's install secret/u)).toBeVisible()
      expect(
        screen.getByText(/Passphrase-protected keys still require their passphrase/u),
      ).toBeVisible()
      expect(downloads.clickSpy).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(downloads.clickSpy).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Export all' }))
      fireEvent.click(screen.getByRole('button', { name: 'Export sensitive backup' }))

      await waitFor(() => expect(downloads.clickSpy).toHaveBeenCalled())
      expect(downloads.createdBlobs).toHaveLength(1)
      expect(downloads.createdBlobs[0]?.type).toBe('application/json;charset=utf-8')
      const exported = JSON.parse(await (downloads.createdBlobs[0] as Blob).text()) as {
        objectKind: string
        payload: { chats: unknown[] }
      }
      expect(exported.objectKind).toBe('workspace-backup')
      expect(exported.payload.chats).toHaveLength(1)
    } finally {
      downloads.restore()
    }
  })

  it('imports a full workspace backup from the overview and replaces the database', async () => {
    await createChat({ id: 'chat-alpha', title: 'Alpha' })
    const backup = await exportWorkspaceBackup()
    await createChat({ id: 'chat-beta', title: 'Beta' })
    const { container } = render(<StorageView route={{ section: 'overview' }} />)
    const input = await waitFor(() => {
      const candidate = container.querySelector<HTMLInputElement>(
        '[data-ui="storage-workspace-import-input"]',
      )
      if (!candidate) throw new Error('expected workspace import input')
      return candidate
    })

    fireEvent.change(input, {
      target: {
        files: [new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' })],
      },
    })
    const dialog = await screen.findByRole('dialog', { name: 'Replace local workspace?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import and replace' }))

    await waitFor(
      () => {
        expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
          level: 'success',
          text: 'Imported workspace backup (1 chats).',
        })
      },
      { timeout: 5_000 },
    )
    const chats = await getDb().chats.toArray()
    expect(chats.map((chat) => chat.id)).toEqual(['chat-alpha'])
  })

  it('clears global calibration families from per-chat samples', async () => {
    const openaiKey = tokenCalibrationKey('openai/gpt-4o')
    const googleKey = tokenCalibrationKey('google/gemini-2.5-pro-preview')
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha' })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta' })
    await updateChatForTest(alpha.id, {
      tokenCalibration: {
        [openaiKey]: {
          totalTextChars: 400,
          totalTextTokens: 100,
          sampleCount: 2,
          updatedAt: 10,
        },
        [googleKey]: {
          totalTextChars: 900,
          totalTextTokens: 300,
          sampleCount: 3,
          updatedAt: 10,
        },
      },
    })
    await updateChatForTest(beta.id, {
      tokenCalibration: {
        [openaiKey]: {
          totalTextChars: 600,
          totalTextTokens: 150,
          sampleCount: 3,
          updatedAt: 20,
        },
      },
    })
    await writeTokenCalibrationGlobal({
      version: 1,
      updatedAt: 20,
      byModel: {
        [openaiKey]: {
          totalTextChars: 1_000,
          totalTextTokens: 250,
          sampleCount: 5,
          updatedAt: 20,
        },
        [googleKey]: {
          totalTextChars: 900,
          totalTextTokens: 300,
          sampleCount: 3,
          updatedAt: 10,
        },
      },
    })

    const { container } = render(<StorageView route={{ section: 'overview' }} />)

    await waitFor(() => {
      expect(container).toHaveTextContent(openaiKey)
      expect(container).toHaveTextContent(googleKey)
      expect(container).toHaveTextContent('5 samples')
      expect(container).toHaveTextContent('3 samples')
    })

    fireEvent.click(screen.getByRole('button', { name: `Clear calibration for ${openaiKey}` }))

    await waitFor(async () => {
      const global = await readTokenCalibrationGlobal()
      const storedAlpha = await getDb().chats.get(alpha.id)
      const storedBeta = await getDb().chats.get(beta.id)
      expect(global.byModel[openaiKey]).toBeUndefined()
      expect(global.byModel[googleKey]?.sampleCount).toBe(3)
      expect(storedAlpha?.tokenCalibration?.[openaiKey]).toBeUndefined()
      expect(storedAlpha?.tokenCalibration?.[googleKey]?.sampleCount).toBe(3)
      expect(storedBeta?.tokenCalibration).toEqual({})
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear all calibration globally' }))

    await waitFor(async () => {
      const global = await readTokenCalibrationGlobal()
      const storedAlpha = await getDb().chats.get(alpha.id)
      expect(global.byModel).toEqual({})
      expect(storedAlpha?.tokenCalibration).toEqual({})
    })
  })

  it('subtracts archived chat calibration from global rollups on permanent delete', async () => {
    const openaiKey = tokenCalibrationKey('openai/gpt-4o')
    const live = await createChat({ id: 'chat-live', title: 'Live' })
    const archivedOne = await createChat({ id: 'chat-archived-one', title: 'Archived one' })
    const archivedTwo = await createChat({ id: 'chat-archived-two', title: 'Archived two' })
    await updateChatForTest(live.id, {
      tokenCalibration: {
        [openaiKey]: {
          totalTextChars: 400,
          totalTextTokens: 100,
          sampleCount: 2,
          updatedAt: 10,
        },
      },
    })
    await updateChatForTest(archivedOne.id, {
      tokenCalibration: {
        [openaiKey]: {
          totalTextChars: 600,
          totalTextTokens: 150,
          sampleCount: 3,
          updatedAt: 20,
        },
      },
    })
    await updateChatForTest(archivedTwo.id, {
      tokenCalibration: {
        [openaiKey]: {
          totalTextChars: 800,
          totalTextTokens: 200,
          sampleCount: 4,
          updatedAt: 30,
        },
      },
    })
    await archiveChat(archivedOne.id, 40)
    await archiveChat(archivedTwo.id, 40)
    await writeTokenCalibrationGlobal({
      version: 1,
      updatedAt: 30,
      byModel: {
        [openaiKey]: {
          totalTextChars: 1_800,
          totalTextTokens: 450,
          sampleCount: 9,
          updatedAt: 30,
        },
      },
    })

    await deleteArchivedChatPermanently(archivedOne.id, 50)

    await waitFor(async () => {
      const global = await readTokenCalibrationGlobal()
      expect(global.byModel[openaiKey]).toMatchObject({
        totalTextChars: 1_200,
        totalTextTokens: 300,
        sampleCount: 6,
        updatedAt: 50,
      })
    })

    await emptyArchivedChats(60)

    const global = await readTokenCalibrationGlobal()
    expect(global.byModel[openaiKey]).toMatchObject({
      totalTextChars: 400,
      totalTextTokens: 100,
      sampleCount: 2,
      updatedAt: 60,
    })
  })

  it('renders chats as a searchable metadata table with calibration controls', async () => {
    const chat = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const folder = await createFolder({ name: 'Work' })
    const tagIds = await setChatTagsFromNames(chat.id, ['Research'], 2000)
    await updateChatForTest(chat.id, {
      previewText: 'Alpha preview',
      folderId: folder.id,
      tags: tagIds,
      createdAt: 1000,
      updatedAt: 5000,
      lastViewedAt: 3000,
      totalCostUsd: 1.25,
      wordCount: 321,
      tokenCalibration: {
        [tokenCalibrationKey('openai/gpt-4o')]: {
          totalTextChars: 400,
          totalTextTokens: 100,
          sampleCount: 2,
          updatedAt: 6000,
        },
        [tokenCalibrationKey('google/gemini-2.5-pro-preview')]: {
          totalTextChars: 900,
          totalTextTokens: 300,
          sampleCount: 3,
          updatedAt: 7000,
        },
      },
    })
    const updatedAtBefore = (await getDb().chats.get(chat.id))?.updatedAt

    const { container } = render(<StorageView route={{ section: 'chats' }} />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="storage-chat-table"]')).toBeInTheDocument()
      expect(container).toHaveTextContent('Title')
      expect(container).toHaveTextContent('Preview')
      expect(container).toHaveTextContent('Updated')
      expect(container).toHaveTextContent('Created')
      expect(container).toHaveTextContent('Viewed')
      expect(container).toHaveTextContent('Cost')
      expect(container).toHaveTextContent('Words')
      expect(container).toHaveTextContent('Folder')
      expect(container).toHaveTextContent('Tags')
      expect(container).toHaveTextContent('Calibration')
      expect(container).not.toHaveTextContent('Actions')
      expect(container).toHaveTextContent('Alpha')
      expect(container).toHaveTextContent('Alpha preview')
      expect(container).toHaveTextContent('Work')
      expect(container).toHaveTextContent('Research')
      expect(container).toHaveTextContent('$1.25')
      expect(container).toHaveTextContent('321')
      expect(container).toHaveTextContent('2 families')
      expect(container.querySelector('[data-ui="storage-chat-preview-cell"] a')).toHaveAttribute(
        'href',
        '#/chat/chat-alpha',
      )
      expect(container.querySelector('[data-ui="storage-chat-select"]')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: /2 families/i }))
    await waitFor(() => expect(container).toHaveTextContent('openai:o200k_base'))

    fireEvent.click(screen.getAllByRole('button', { name: /^Clear$/ })[0] as HTMLElement)
    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(Object.keys(stored?.tokenCalibration ?? {})).toHaveLength(1)
      expect(stored?.updatedAt).toBe(updatedAtBefore)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Clear all calibration' }))
    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(stored?.tokenCalibration).toEqual({})
      expect(stored?.updatedAt).toBe(updatedAtBefore)
    })
  })

  it('uses the sidebar search session behavior on the chats table', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Needle beta', now: 2000 })
    await updateChatForTest(alpha.id, { previewText: 'plain preview' })
    await updateChatForTest(beta.id, { previewText: 'matching preview' })

    const { container } = render(<StorageView route={{ section: 'chats' }} />)

    await waitFor(() => {
      expect(container).toHaveTextContent('Alpha')
      expect(container).toHaveTextContent('Needle beta')
    })

    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'needle' } })
    expect(screen.getByText('Searching...')).toBeVisible()

    await waitFor(() => {
      expect(container).not.toHaveTextContent('Alpha')
      expect(container).toHaveTextContent('Needle beta')
    })
  })

  it('pushes Storage sort and folder/tag filters into the compact paged catalog', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta', now: 2000 })
    const gamma = await createChat({ id: 'chat-gamma', title: 'Gamma', now: 3000 })
    const work = await createFolder({ name: 'Work' })
    const home = await createFolder({ name: 'Home' })
    const alphaTags = await setChatTagsFromNames(alpha.id, ['Red'], 4000)
    const betaTags = await setChatTagsFromNames(beta.id, ['Blue'], 4000)
    const gammaTags = await setChatTagsFromNames(gamma.id, ['Blue'], 4000)
    await updateChatForTest(alpha.id, {
      previewText: 'Alpha preview',
      folderId: work.id,
      tags: alphaTags,
      totalCostUsd: 10,
    })
    await updateChatForTest(beta.id, {
      previewText: 'Beta preview',
      folderId: home.id,
      tags: betaTags,
      totalCostUsd: 1,
    })
    await updateChatForTest(gamma.id, {
      previewText: 'Gamma preview',
      folderId: work.id,
      tags: gammaTags,
      totalCostUsd: 5,
    })

    const { container } = render(<StorageView route={{ section: 'chats' }} />)
    await waitFor(() => expect(storageChatTitles(container)).toEqual(['Gamma', 'Beta', 'Alpha']))

    fireEvent.change(screen.getByLabelText(/^Sort:/), {
      target: { value: 'totalCostUsd-desc' },
    })
    await waitFor(() => expect(storageChatTitles(container)).toEqual(['Alpha', 'Gamma', 'Beta']))

    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(storageChatTitles(container)).toEqual(['Alpha', 'Gamma']))

    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    await waitFor(() => expect(storageChatTitles(container)).toEqual(['Gamma']))

    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    await waitFor(() => expect(storageChatTitles(container)).toEqual(['Beta']))
  })

  it('includes archived rows locally without starting an empty search loop', async () => {
    const live = await createChat({ id: 'chat-live', title: 'Live chat', now: 1000 })
    const archived = await createChat({ id: 'chat-archived', title: 'Archived chat', now: 2000 })
    await updateChatForTest(live.id, { previewText: 'Live preview' })
    await updateChatForTest(archived.id, { archived: true, previewText: 'Archived preview' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { container } = render(<StorageView route={{ section: 'chats' }} />)

      await waitFor(() => {
        expect(container).toHaveTextContent('Live chat')
        expect(container).not.toHaveTextContent('Archived chat')
      })
      const archiveCheckboxes = Array.from(
        container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-filters"] input'),
      )
      fireEvent.click(archiveCheckboxes[2] as HTMLInputElement)

      await waitFor(() => {
        expect(container).toHaveTextContent('Live chat')
        expect(container).toHaveTextContent('Archived chat')
      })
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Maximum update depth exceeded'),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('keeps an archived selection and explains when an active stream blocks bulk deletion', async () => {
    const archived = await createChat({ id: 'chat-streaming-bulk', title: 'Streaming bulk' })
    await updateChatForTest(archived.id, { archived: true, previewText: 'Streaming response' })
    await putActiveStreamLease({
      streamId: 'streaming-bulk-lease',
      chatId: archived.id,
      messageId: 'reserved-assistant',
    })
    const { container } = render(<StorageView route={{ section: 'chats' }} />)
    fireEvent.click(
      container.querySelector<HTMLInputElement>(
        '[data-ui="storage-chat-filters"] label:nth-of-type(3) input',
      ) as HTMLInputElement,
    )
    await waitFor(() => expect(container).toHaveTextContent('Streaming bulk'))
    fireEvent.click(
      container.querySelector<HTMLInputElement>('[data-ui="storage-chat-select"]') as HTMLElement,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete selected chats?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        level: 'warning',
        text: 'Wait for the active response to finish before permanently deleting this chat.',
      })
    })
    expect(container).toHaveTextContent('1 selected')
    expect(await getDb().chats.get(archived.id)).toBeDefined()
  })

  it('selects and applies a bulk action to every matching chat beyond the retained page', async () => {
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const initial = buildChat({ id: 'chat-000', title: 'Chat 000', now: 1 })
    const seed: Chat = {
      ...initial,
      settings: { ...initial.settings, profileId: 'profile-bulk-selection' },
    }
    const chats: Chat[] = Array.from({ length: 205 }, (_, index) => ({
      ...seed,
      id: `chat-${index.toString().padStart(3, '0')}`,
      title: `Chat ${index.toString().padStart(3, '0')}`,
      createdAt: index + 1,
      updatedAt: index + 1,
      lastViewedAt: index + 1,
      lastBranchUpdatedAt: index + 1,
      previewText: `Preview ${index}`,
      settings: structuredClone(seed.settings),
    }))
    const db = getDb()
    const managerBeforeSeed = (await db.configurationCatalogAggregates.get(
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
    )) as ConfigurationProfileManagerStateRow | undefined
    await putTestChats(chats)
    expect(await db.chats.count()).toBe(205)
    expect(await db.chatSidebarRows.count()).toBe(205)
    expect(await db.chatSidebarAggregates.get(CHAT_SIDEBAR_AGGREGATE_ID)).toEqual({
      ...emptyChatSidebarAggregateRow(),
      totalCount: 205,
      activeCount: 205,
      visibleCount: 205,
      rootCount: 205,
      rootVisibleCount: 205,
    })
    expect((await db.chatSidebarRows.toArray()).sort(byId)).toEqual(
      chats.map(chatSidebarProjectionRow).sort(byId),
    )
    expect((await db.configurationLinks.toArray()).sort(byId)).toEqual(
      chats.flatMap(configurationLinksForChat).sort(byId),
    )
    expect(await db.configurationProfileUsageRows.get(seed.settings.profileId)).toEqual({
      id: seed.settings.profileId,
      presetCount: 0,
      activePresetCount: 0,
      chatCount: 205,
      activeChatCount: 205,
    })
    const managerAfterSeed = (await db.configurationCatalogAggregates.get(
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
    )) as ConfigurationProfileManagerStateRow | undefined
    expect(managerAfterSeed?.revision).toBe((managerBeforeSeed?.revision ?? 0) + 1)

    const { container } = render(<StorageView route={{ section: 'chats' }} />)
    await waitFor(() => expect(container).toHaveTextContent('205 chats'))
    fireEvent.click(screen.getByLabelText('Select all matching chats'))
    await waitFor(() => expect(container).toHaveTextContent('205 selected'))

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(
      async () => {
        expect((await db.chats.toArray()).filter((chat) => chat.archived)).toHaveLength(205)
      },
      { timeout: 10_000 },
    )
    const archivedChats = (await db.chats.toArray()).sort(byId)
    expect(archivedChats).toHaveLength(205)
    expect(archivedChats.every((chat) => chat.archived)).toBe(true)
    expect(new Set(archivedChats.map((chat) => chat.updatedAt)).size).toBe(205)
    for (let index = 0; index < archivedChats.length; index += 1) {
      const archived = archivedChats[index] as Chat
      const previous = chats[index] as Chat
      expect(archived.updatedAt).toBeGreaterThan(previous.updatedAt)
      expect(archived.metaVersion).toBe(previous.metaVersion + 1)
      expect(archived.summaryVersion).toBe(previous.summaryVersion + 1)
    }
    expect((await db.chatSidebarRows.toArray()).sort(byId)).toEqual(
      archivedChats.map(chatSidebarProjectionRow).sort(byId),
    )
    expect(await db.chatSidebarAggregates.get(CHAT_SIDEBAR_AGGREGATE_ID)).toEqual({
      ...emptyChatSidebarAggregateRow(),
      totalCount: 205,
      archivedCount: 205,
      rootCount: 205,
    })
    const archivedLinks = archivedChats.flatMap(configurationLinksForChat).sort(byId)
    expect((await db.configurationLinks.toArray()).sort(byId)).toEqual(archivedLinks)
    expect(archivedLinks.every((link) => link.ownerActive === false)).toBe(true)
    expect(await db.configurationProfileUsageRows.get(seed.settings.profileId)).toEqual({
      id: seed.settings.profileId,
      presetCount: 0,
      activePresetCount: 0,
      chatCount: 205,
      activeChatCount: 0,
    })
    const managerAfterArchive = (await db.configurationCatalogAggregates.get(
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
    )) as ConfigurationProfileManagerStateRow | undefined
    expect(managerAfterArchive?.revision).toBe((managerAfterSeed?.revision ?? 0) + 1)
    expect(diagnostic).not.toHaveBeenCalled()
  })

  it('explains when an active stream blocks permanent deletion from the archive', async () => {
    const archived = await createChat({ id: 'chat-streaming-archive', title: 'Streaming archive' })
    await updateChatForTest(archived.id, { archived: true })
    await putActiveStreamLease({
      streamId: 'streaming-archive-lease',
      chatId: archived.id,
      messageId: 'reserved-assistant',
    })
    render(<StorageView route={{ section: 'archive' }} />)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Permanently delete Streaming archive' }),
    )
    const dialog = await screen.findByRole('dialog', { name: 'Permanently delete chat?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
        level: 'warning',
        text: 'Wait for the active response to finish before permanently deleting this chat.',
      })
    })
    expect(screen.getByText('Streaming archive')).toBeInTheDocument()
    expect(await getDb().chats.get(archived.id)).toBeDefined()
  })

  it('selects chats with shift-click and applies mixed bulk tags from a blank default', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta', now: 2000 })
    const gamma = await createChat({ id: 'chat-gamma', title: 'Gamma', now: 3000 })
    await setChatTagsFromNames(alpha.id, ['One'], 4000)
    await setChatTagsFromNames(beta.id, ['Two'], 4000)
    await setChatTagsFromNames(gamma.id, ['Three'], 4000)
    await updateChatForTest(alpha.id, { previewText: 'Alpha preview' })
    await updateChatForTest(beta.id, { previewText: 'Beta preview' })
    await updateChatForTest(gamma.id, { previewText: 'Gamma preview' })
    const { container } = render(<StorageView route={{ section: 'chats' }} />)

    await waitFor(() => expect(container).toHaveTextContent('Gamma'))
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-select"]'),
    )
    fireEvent.click(checkboxes[0] as HTMLInputElement)
    fireEvent.click(checkboxes[2] as HTMLInputElement, { shiftKey: true })

    await waitFor(() => expect(container).toHaveTextContent('3 selected'))
    const tagsButton = screen.getByRole('button', { name: 'Tags' })
    fireEvent.click(tagsButton)
    const tagsDialog = await screen.findByRole('dialog', { name: 'Set tags for 3 chats' })
    const tagsInput = within(tagsDialog).getByRole('textbox')
    expect(tagsInput).toHaveValue('')
    fireEvent.change(tagsInput, { target: { value: 'Shared, Later' } })
    fireEvent.click(within(tagsDialog).getByRole('button', { name: 'Save' }))

    await waitFor(async () => {
      const tags = await getDb().tags.toArray()
      const tagById = new Map(tags.map((tag) => [tag.id, tag.name]))
      for (const id of [alpha.id, beta.id, gamma.id]) {
        const stored = await getDb().chats.get(id)
        expect((stored?.tags ?? []).map((tagId) => tagById.get(tagId))).toEqual(['Shared', 'Later'])
      }
      expect(tags.map((tag) => tag.name).sort()).toEqual(['Later', 'Shared'])
      expect(tagsButton).not.toBeDisabled()
    })
  })

  it('uses the shared folder default for bulk move', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta', now: 2000 })
    const work = await createFolder({ name: 'Work' })
    await updateChatForTest(alpha.id, { folderId: work.id })
    await updateChatForTest(beta.id, { folderId: work.id })
    await updateChatForTest(alpha.id, { previewText: 'Alpha preview' })
    await updateChatForTest(beta.id, { previewText: 'Beta preview' })
    const { container } = render(<StorageView route={{ section: 'chats' }} />)

    await waitFor(() => expect(container).toHaveTextContent('Beta'))
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-select"]'),
    )
    fireEvent.click(checkboxes[0] as HTMLInputElement)
    fireEvent.click(checkboxes[1] as HTMLInputElement, { metaKey: true })
    const moveButton = screen.getByRole('button', { name: 'Move' })
    fireEvent.click(moveButton)
    const moveDialog = await screen.findByRole('dialog', { name: 'Move 2 chats' })
    const moveInput = within(moveDialog).getByRole('textbox')
    expect(moveInput).toHaveValue('Work')
    fireEvent.change(moveInput, { target: { value: 'Done' } })
    fireEvent.click(within(moveDialog).getByRole('button', { name: 'Move' }))

    await waitFor(async () => {
      const folders = await getDb().folders.toArray()
      const done = folders.find((folder) => folder.name === 'Done')
      expect(done).toBeTruthy()
      expect((await getDb().chats.get(alpha.id))?.folderId).toBe(done?.id)
      expect((await getDb().chats.get(beta.id))?.folderId).toBe(done?.id)
      expect(moveButton).not.toBeDisabled()
    })
  })

  it('downloads multiple selected chats as a zip with unique filenames', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Untitled Chat', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Untitled Chat', now: 2000 })
    await updateChatForTest(alpha.id, { titleStatus: 'manual', previewText: 'Alpha preview' })
    await updateChatForTest(beta.id, { titleStatus: 'manual', previewText: 'Beta preview' })
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createdBlobs: Blob[] = []
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        createdBlobs.push(blob)
        return 'blob:natter-chat-zip'
      }),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const { container } = render(<StorageView route={{ section: 'chats' }} />)

      await waitFor(() => expect(container).toHaveTextContent('Untitled Chat'))
      const checkboxes = Array.from(
        container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-select"]'),
      )
      fireEvent.click(checkboxes[0] as HTMLInputElement)
      fireEvent.click(checkboxes[1] as HTMLInputElement, { metaKey: true })
      const downloadButton = screen.getByRole('button', { name: 'Download' })
      fireEvent.click(downloadButton)

      await waitFor(() => {
        expect(clickSpy).toHaveBeenCalled()
        expect(downloadButton).not.toBeDisabled()
      })
      expect(createdBlobs).toHaveLength(1)
      expect(createdBlobs[0]?.type).toBe('application/zip')
      const entries = unzipSync(new Uint8Array(await (createdBlobs[0] as Blob).arrayBuffer()))
      const filenames = Object.keys(entries).sort()
      expect(filenames).toHaveLength(2)
      expect(new Set(filenames).size).toBe(2)
      expect(filenames.every((filename) => filename.endsWith('.txt'))).toBe(true)
      expect(filenames.some((filename) => filename.includes('-2.txt'))).toBe(true)
      expect(strFromU8(entries[filenames[0] as string] as Uint8Array)).toContain('# Untitled Chat')
    } finally {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      })
    }
  })

  it('exports a single selected chat as portable JSON from the chats table', async () => {
    const chat = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    await updateChatForTest(chat.id, { titleStatus: 'manual', previewText: 'Alpha preview' })
    const downloads = mockBlobDownloads()
    try {
      const { container } = render(<StorageView route={{ section: 'chats' }} />)

      await waitFor(() => expect(container).toHaveTextContent('Alpha'))
      const checkbox = container.querySelector<HTMLInputElement>('[data-ui="storage-chat-select"]')
      fireEvent.click(checkbox as HTMLInputElement)
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))

      await waitFor(() => expect(downloads.clickSpy).toHaveBeenCalled())
      expect(downloads.createdBlobs).toHaveLength(1)
      const exported = JSON.parse(await (downloads.createdBlobs[0] as Blob).text()) as {
        objectKind: string
        payload: { chat: { title: string; sourceChatId: string } }
      }
      expect(exported.objectKind).toBe('chat')
      expect(exported.payload.chat).toMatchObject({ title: 'Alpha', sourceChatId: 'chat-alpha' })
    } finally {
      downloads.restore()
    }
  })

  it('exports multiple selected chats as a ZIP of portable JSON files', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Untitled Chat', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Untitled Chat', now: 2000 })
    await updateChatForTest(alpha.id, { titleStatus: 'manual', previewText: 'Alpha preview' })
    await updateChatForTest(beta.id, { titleStatus: 'manual', previewText: 'Beta preview' })
    const downloads = mockBlobDownloads()
    try {
      const { container } = render(<StorageView route={{ section: 'chats' }} />)

      await waitFor(() => expect(container).toHaveTextContent('Untitled Chat'))
      const checkboxes = Array.from(
        container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-select"]'),
      )
      fireEvent.click(checkboxes[0] as HTMLInputElement)
      fireEvent.click(checkboxes[1] as HTMLInputElement, { metaKey: true })
      const chatTable = getDb().chats
      const originalGet = chatTable.get.bind(chatTable)
      let activeExports = 0
      let maxActiveExports = 0
      const trackedGet = ((chatId: string) => {
        activeExports += 1
        maxActiveExports = Math.max(maxActiveExports, activeExports)
        return originalGet(chatId).finally(() => {
          activeExports -= 1
        })
      }) as typeof chatTable.get
      const chatReads = vi.spyOn(chatTable, 'get').mockImplementation(trackedGet)
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))

      await waitFor(() => expect(downloads.clickSpy).toHaveBeenCalled())
      expect(chatReads).toHaveBeenCalledTimes(2)
      expect(maxActiveExports).toBe(1)
      expect(downloads.createdBlobs).toHaveLength(1)
      expect(downloads.createdBlobs[0]?.type).toBe('application/zip')
      const entries = unzipSync(
        new Uint8Array(await (downloads.createdBlobs[0] as Blob).arrayBuffer()),
      )
      const filenames = Object.keys(entries).sort()
      expect(filenames).toHaveLength(2)
      expect(new Set(filenames).size).toBe(2)
      expect(filenames.every((filename) => filename.endsWith('.json'))).toBe(true)
      const exported = filenames.map(
        (filename) =>
          JSON.parse(strFromU8(entries[filename] as Uint8Array)) as {
            objectKind: string
            payload: { chat: { sourceChatId: string } }
          },
      )
      expect(exported.every((entry) => entry.objectKind === 'chat')).toBe(true)
      expect(exported.map((entry) => entry.payload.chat.sourceChatId).sort()).toEqual([
        'chat-alpha',
        'chat-beta',
      ])
    } finally {
      downloads.restore()
    }
  })

  it('imports a chat JSON export from the chats table', async () => {
    const source = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const envelope = await exportChat(source.id)

    const { container } = render(<StorageView route={{ section: 'chats' }} />)
    expect(screen.getByRole('button', { name: 'Import chat JSON or ZIP' })).toBeInTheDocument()
    const input = container.querySelector<HTMLInputElement>('[data-ui="storage-chat-import-input"]')
    expect(input).toBeTruthy()

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File([JSON.stringify(envelope)], 'chat.json', { type: 'application/json' })],
      },
    })

    await waitFor(async () => {
      const chats = await getDb().chats.orderBy('createdAt').toArray()
      expect(chats).toHaveLength(2)
      expect(chats.map((chat) => chat.title)).toEqual(['Alpha', 'Alpha'])
      expect(chats[1]?.id).not.toBe(source.id)
    })
  })

  it('imports a ZIP of chat JSON exports from the chats table', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta', now: 2000 })
    const alphaEnvelope = await exportChat(alpha.id)
    const betaEnvelope = await exportChat(beta.id)
    const zip = await jsonEntriesZipBlob([
      { filename: 'alpha.json', value: alphaEnvelope },
      { filename: 'beta.json', value: betaEnvelope },
    ])
    await restoreEmptyWorkspace()

    const { container } = render(<StorageView route={{ section: 'chats' }} />)
    const input = container.querySelector<HTMLInputElement>('[data-ui="storage-chat-import-input"]')
    expect(input).toBeTruthy()

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [
          new File([zip], 'chats.zip', {
            type: 'application/zip',
          }),
        ],
      },
    })

    await waitFor(async () => {
      const chats = (await getDb().chats.toArray()).sort((left, right) =>
        left.title.localeCompare(right.title),
      )
      expect(chats.map((chat) => chat.title)).toEqual(['Alpha', 'Beta'])
      expect(chats.map((chat) => chat.id).sort()).not.toEqual(['chat-alpha', 'chat-beta'])
    })
  })

  it('leaves IndexedDB unchanged when a later chat in an import ZIP is malformed', async () => {
    const source = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const zip = await jsonEntriesZipBlob([
      { filename: 'alpha.json', value: await exportChat(source.id) },
      { filename: 'zeta.json', value: { objectKind: 'chat' } },
    ])
    await restoreEmptyWorkspace()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { container } = render(<StorageView route={{ section: 'chats' }} />)
    const input = container.querySelector<HTMLInputElement>('[data-ui="storage-chat-import-input"]')
    expect(input).toBeTruthy()

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File([zip], 'chats.zip', { type: 'application/zip' })],
      },
    })

    await waitFor(() => {
      expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ level: 'danger' })
    })
    expect(await getDb().chats.count()).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith('Failed to import chat JSON/ZIP', expect.anything())
  })
})
