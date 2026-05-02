import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { strFromU8, unzipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import {
  readTokenCalibrationGlobal,
  writeTokenCalibrationGlobal,
} from '../../src/core/token-calibration'
import { ingestAttachmentBytes } from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  archiveChat,
  createChat,
  deleteArchivedChatPermanently,
  emptyArchivedChats,
  setChatTagsFromNames,
} from '../../src/store/chats'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { createFolder } from '../../src/store/folders'
import { exportChat, exportWorkspaceBackup } from '../../src/store/import-export'
import { __resetSearchSessionRunnerForTests } from '../../src/store/search-session'
import { listTags } from '../../src/store/tags'
import { __resetSearchStoreForTests } from '../../src/store/zustand/searchStore'
import { jsonEntriesZipBlob } from '../../src/ui/import-export/json-file'
import { StorageView } from '../../src/ui/storage/StorageView'

const debugNukeMocks = vi.hoisted(() => ({
  nukeSiteStorage: vi.fn<() => Promise<void>>(),
}))

vi.mock('../../src/lib/debug-nuke', () => debugNukeMocks)

const DB_NAME = 'natter'
const originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage')

function setNavigatorStorage(storage: Partial<StorageManager> | undefined): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: storage,
  })
}

function bytes(content: string): Blob {
  return new Blob([new TextEncoder().encode(content)])
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

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetSearchSessionRunnerForTests()
  __resetSearchStoreForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

describe('StorageView', () => {
  beforeEach(async () => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    await resetAll()
    debugNukeMocks.nukeSiteStorage.mockReset()
    debugNukeMocks.nukeSiteStorage.mockResolvedValue(undefined)
    setNavigatorStorage({
      estimate: vi.fn<StorageManager['estimate']>().mockResolvedValue({
        usage: 4096,
        quota: 8192,
        usageDetails: { indexedDB: 1024, caches: 3072 },
      } as StorageEstimate),
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
    await resetAll()
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

  it('runs the local data wipe from the overview clear-all action', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<StorageView route={{ section: 'overview' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }))

    await waitFor(() => {
      expect(debugNukeMocks.nukeSiteStorage).toHaveBeenCalledTimes(1)
    })
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining('Clear all local Natter data for this browser origin?'),
    )
  })

  it('exports a full workspace backup from the overview', async () => {
    await createChat({ id: 'chat-alpha', title: 'Alpha' })
    const downloads = mockBlobDownloads()
    try {
      render(<StorageView route={{ section: 'overview' }} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Export all' }))

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
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const { container } = render(<StorageView route={{ section: 'overview' }} />)
    const input = container.querySelector<HTMLInputElement>(
      '[data-ui="storage-workspace-import-input"]',
    )
    expect(input).toBeTruthy()

    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [new File([JSON.stringify(backup)], 'backup.json', { type: 'application/json' })],
      },
    })

    await waitFor(async () => {
      const chats = await getDb().chats.toArray()
      expect(chats.map((chat) => chat.id)).toEqual(['chat-alpha'])
    })
    expect(confirmSpy).toHaveBeenCalled()
  })

  it('clears global calibration families from per-chat samples', async () => {
    const openaiKey = tokenCalibrationKey('openai/gpt-4o')
    const googleKey = tokenCalibrationKey('google/gemini-2.5-pro-preview')
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha' })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta' })
    await getDb().chats.update(alpha.id, {
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
    await getDb().chats.update(beta.id, {
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
    await getDb().chats.update(live.id, {
      tokenCalibration: {
        [openaiKey]: {
          totalTextChars: 400,
          totalTextTokens: 100,
          sampleCount: 2,
          updatedAt: 10,
        },
      },
    })
    await getDb().chats.update(archivedOne.id, {
      tokenCalibration: {
        [openaiKey]: {
          totalTextChars: 600,
          totalTextTokens: 150,
          sampleCount: 3,
          updatedAt: 20,
        },
      },
    })
    await getDb().chats.update(archivedTwo.id, {
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
    await getDb().chats.update(chat.id, {
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
    await getDb().chats.update(alpha.id, { previewText: 'plain preview' })
    await getDb().chats.update(beta.id, { previewText: 'matching preview' })

    const { container } = render(<StorageView route={{ section: 'chats' }} />)

    await waitFor(() => {
      expect(container).toHaveTextContent('Alpha')
      expect(container).toHaveTextContent('Needle beta')
    })

    fireEvent.change(screen.getByLabelText('Search chats'), { target: { value: 'needle' } })

    await waitFor(() => {
      expect(container).not.toHaveTextContent('Alpha')
      expect(container).toHaveTextContent('Needle beta')
    })
  })

  it('includes archived rows locally without starting an empty search loop', async () => {
    const live = await createChat({ id: 'chat-live', title: 'Live chat', now: 1000 })
    const archived = await createChat({ id: 'chat-archived', title: 'Archived chat', now: 2000 })
    await getDb().chats.update(live.id, { previewText: 'Live preview' })
    await getDb().chats.update(archived.id, { archived: true, previewText: 'Archived preview' })
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

  it('selects chats with shift-click and applies mixed bulk tags from a blank default', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta', now: 2000 })
    const gamma = await createChat({ id: 'chat-gamma', title: 'Gamma', now: 3000 })
    await setChatTagsFromNames(alpha.id, ['One'], 4000)
    await setChatTagsFromNames(beta.id, ['Two'], 4000)
    await setChatTagsFromNames(gamma.id, ['Three'], 4000)
    await getDb().chats.update(alpha.id, { previewText: 'Alpha preview' })
    await getDb().chats.update(beta.id, { previewText: 'Beta preview' })
    await getDb().chats.update(gamma.id, { previewText: 'Gamma preview' })
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Shared, Later')

    const { container } = render(<StorageView route={{ section: 'chats' }} />)

    await waitFor(() => expect(container).toHaveTextContent('Gamma'))
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-select"]'),
    )
    fireEvent.click(checkboxes[0] as HTMLInputElement)
    fireEvent.click(checkboxes[2] as HTMLInputElement, { shiftKey: true })

    await waitFor(() => expect(container).toHaveTextContent('3 selected'))
    fireEvent.click(screen.getByRole('button', { name: 'Tags' }))

    await waitFor(async () => {
      expect(promptSpy).toHaveBeenCalledWith('Tags for 3 chats, comma-separated', '')
      const tags = await listTags()
      const tagById = new Map(tags.map((tag) => [tag.id, tag.name]))
      for (const id of [alpha.id, beta.id, gamma.id]) {
        const stored = await getDb().chats.get(id)
        expect((stored?.tags ?? []).map((tagId) => tagById.get(tagId))).toEqual(['Shared', 'Later'])
      }
    })
  })

  it('uses the shared folder default for bulk move', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Beta', now: 2000 })
    const work = await createFolder({ name: 'Work' })
    await getDb().chats.update(alpha.id, { folderId: work.id })
    await getDb().chats.update(beta.id, { folderId: work.id })
    await getDb().chats.update(alpha.id, { previewText: 'Alpha preview' })
    await getDb().chats.update(beta.id, { previewText: 'Beta preview' })
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Done')

    const { container } = render(<StorageView route={{ section: 'chats' }} />)

    await waitFor(() => expect(container).toHaveTextContent('Beta'))
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-select"]'),
    )
    fireEvent.click(checkboxes[0] as HTMLInputElement)
    fireEvent.click(checkboxes[1] as HTMLInputElement, { metaKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))

    await waitFor(async () => {
      expect(promptSpy).toHaveBeenCalledWith(
        'Move 2 chats to folder (blank removes folder)',
        'Work',
      )
      const folders = await getDb().folders.toArray()
      const done = folders.find((folder) => folder.name === 'Done')
      expect(done).toBeTruthy()
      expect((await getDb().chats.get(alpha.id))?.folderId).toBe(done?.id)
      expect((await getDb().chats.get(beta.id))?.folderId).toBe(done?.id)
    })
  })

  it('downloads multiple selected chats as a zip with unique filenames', async () => {
    const alpha = await createChat({ id: 'chat-alpha', title: 'Untitled Chat', now: 1000 })
    const beta = await createChat({ id: 'chat-beta', title: 'Untitled Chat', now: 2000 })
    await getDb().chats.update(alpha.id, { titleStatus: 'manual', previewText: 'Alpha preview' })
    await getDb().chats.update(beta.id, { titleStatus: 'manual', previewText: 'Beta preview' })
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
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))

      await waitFor(() => expect(clickSpy).toHaveBeenCalled())
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
    await getDb().chats.update(chat.id, { titleStatus: 'manual', previewText: 'Alpha preview' })
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
    await getDb().chats.update(alpha.id, { titleStatus: 'manual', previewText: 'Alpha preview' })
    await getDb().chats.update(beta.id, { titleStatus: 'manual', previewText: 'Beta preview' })
    const downloads = mockBlobDownloads()
    try {
      const { container } = render(<StorageView route={{ section: 'chats' }} />)

      await waitFor(() => expect(container).toHaveTextContent('Untitled Chat'))
      const checkboxes = Array.from(
        container.querySelectorAll<HTMLInputElement>('[data-ui="storage-chat-select"]'),
      )
      fireEvent.click(checkboxes[0] as HTMLInputElement)
      fireEvent.click(checkboxes[1] as HTMLInputElement, { metaKey: true })
      fireEvent.click(screen.getByRole('button', { name: 'Export' }))

      await waitFor(() => expect(downloads.clickSpy).toHaveBeenCalled())
      expect(downloads.createdBlobs).toHaveLength(1)
      expect(downloads.createdBlobs[0]?.type).toBe('application/zip')
      const entries = unzipSync(
        new Uint8Array(await (downloads.createdBlobs[0] as Blob).arrayBuffer()),
      )
      const filenames = Object.keys(entries).sort()
      expect(filenames).toHaveLength(2)
      expect(new Set(filenames).size).toBe(2)
      expect(filenames.every((filename) => filename.endsWith('.json'))).toBe(true)
      expect(filenames.some((filename) => filename.includes('-2.json'))).toBe(true)
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
    await resetAll()

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
})
