import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function downloadJson(download) {
  const stream = await download.createReadStream()
  if (!stream) throw new Error('workspace backup download stream unavailable')
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function downloadJsonFromDirectory(directory, priorNames) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const names = await readdir(directory)
    for (const name of names) {
      if (priorNames.has(name) || name.endsWith('.crdownload')) continue
      try {
        return JSON.parse(await readFile(join(directory, name), 'utf8'))
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('workspace backup native download unavailable')
}

function clone(value) {
  return structuredClone(value)
}

const PRIOR_TOAST_COMPLETION_ATTRIBUTE = 'data-e2e-prior-toast-completion'
const WORKSPACE_OPERATION_TIMEOUT_MS = 180_000

async function runAndWaitForFreshToast(page, expectedText, action) {
  const priorSelector = `[${PRIOR_TOAST_COMPLETION_ATTRIBUTE}]`
  await page.locator(priorSelector).evaluateAll((nodes, attribute) => {
    for (const node of nodes) node.removeAttribute(attribute)
  }, PRIOR_TOAST_COMPLETION_ATTRIBUTE)
  await page.locator('[data-ui="toast-text"]').evaluateAll((nodes, attribute) => {
    for (const node of nodes) node.setAttribute(attribute, '')
  }, PRIOR_TOAST_COMPLETION_ATTRIBUTE)
  try {
    await action()
    const toast = page
      .locator(
        `[data-ui="toast"]:has([data-ui="toast-text"]:not([${PRIOR_TOAST_COMPLETION_ATTRIBUTE}]))`,
      )
      .first()
    await toast.waitFor({ state: 'visible', timeout: WORKSPACE_OPERATION_TIMEOUT_MS })
    const [text, tone] = await Promise.all([
      toast.locator('[data-ui="toast-text"]').innerText(),
      toast.getAttribute('data-tone'),
    ])
    const expected =
      typeof expectedText === 'string' ? text.includes(expectedText) : expectedText.test(text)
    if (tone === 'danger' || !expected) {
      throw new Error(`Workspace fixture operation failed: ${text}`)
    }
  } finally {
    await page.locator(priorSelector).evaluateAll((nodes, attribute) => {
      for (const node of nodes) node.removeAttribute(attribute)
    }, PRIOR_TOAST_COMPLETION_ATTRIBUTE)
  }
}

function firstWorkspaceProfileAndPreset(backup) {
  if (!isRecord(backup) || !isRecord(backup.payload)) {
    throw new Error('workspace fixture backup envelope invalid')
  }
  const { payload } = backup
  if (!Array.isArray(payload.profiles) || payload.profiles.length === 0) {
    throw new Error('workspace fixture profile missing')
  }
  if (!Array.isArray(payload.presets) || payload.presets.length === 0) {
    throw new Error('workspace fixture preset missing')
  }
  const profile = payload.profiles[0]
  if (!isRecord(profile) || typeof profile.id !== 'string') {
    throw new Error('workspace fixture profile invalid')
  }
  const preset = payload.presets.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.connectionProfileId === profile.id &&
      isRecord(candidate.settings),
  )
  if (!isRecord(preset) || !isRecord(preset.settings)) {
    throw new Error('workspace fixture preset invalid')
  }
  return { payload, preset, profile }
}

const WORKSPACE_TABLE_KEYS = [
  'chats',
  'messages',
  'childLists',
  'chatBranchCache',
  'attachments',
  'profiles',
  'presets',
  'promptPresets',
  'folders',
  'tags',
  'drafts',
  'keys',
  'settings',
]

function refreshWorkspaceManifest(backup) {
  if (!isRecord(backup) || !isRecord(backup.payload)) {
    throw new Error('workspace fixture backup envelope invalid')
  }
  const counts = {}
  for (const key of WORKSPACE_TABLE_KEYS) {
    if (!Array.isArray(backup.payload[key])) {
      throw new Error(`workspace fixture table missing: ${key}`)
    }
    counts[key] = backup.payload[key].length
  }
  let attachmentBlobCount = 0
  let attachmentBlobBytes = 0
  for (const bundle of backup.payload.attachments) {
    if (!isRecord(bundle) || !Array.isArray(bundle.blobs)) {
      throw new Error('workspace fixture attachment bundle invalid')
    }
    attachmentBlobCount += bundle.blobs.length
    for (const blob of bundle.blobs) {
      if (!isRecord(blob) || !Number.isSafeInteger(blob.sizeBytes) || blob.sizeBytes < 0) {
        throw new Error('workspace fixture attachment blob invalid')
      }
      attachmentBlobBytes += blob.sizeBytes
    }
  }
  backup.payload.manifest = {
    version: 1,
    counts,
    attachmentBlobCount,
    attachmentBlobBytes,
  }
  return backup
}

function putWorkspaceSettings(backup, values) {
  if (!isRecord(backup) || !isRecord(backup.payload) || !Array.isArray(backup.payload.settings)) {
    throw new Error('workspace fixture settings table missing')
  }
  const rowsByKey = new Map()
  for (const row of backup.payload.settings) {
    if (!isRecord(row) || typeof row.key !== 'string') {
      throw new Error('workspace fixture settings row invalid')
    }
    rowsByKey.set(row.key, row)
  }
  for (const [key, value] of Object.entries(values)) {
    rowsByKey.set(key, { key, value: clone(value) })
  }
  backup.payload.settings = [...rowsByKey.values()]
  return refreshWorkspaceManifest(backup)
}

function correlateImportedMessageIds(sourceMessages, importedMessages) {
  const sourceChildren = messagesByParent(sourceMessages)
  const importedChildren = messagesByParent(importedMessages)
  const messageIdMap = {}
  const pending = [[null, null]]
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const [sourceParentId, importedParentId] = pending[cursor]
    const sourceRows = sourceChildren.get(sourceParentId) ?? []
    const importedRows = importedChildren.get(importedParentId) ?? []
    if (sourceRows.length !== importedRows.length) {
      throw new Error('portable fixture imported topology mismatch')
    }
    for (let index = 0; index < sourceRows.length; index += 1) {
      const source = sourceRows[index]
      const imported = importedRows[index]
      if (source.role !== imported.role || source.deleted !== imported.deleted) {
        throw new Error('portable fixture imported message mismatch')
      }
      messageIdMap[source.id] = imported.id
      pending.push([source.id, imported.id])
    }
  }
  if (Object.keys(messageIdMap).length !== sourceMessages.length) {
    throw new Error('portable fixture imported message map incomplete')
  }
  return messageIdMap
}

function messagesByParent(messages) {
  const byParent = new Map()
  for (const message of messages) {
    if (!isRecord(message) || typeof message.id !== 'string') {
      throw new Error('portable fixture message invalid')
    }
    const parentId = typeof message.parentId === 'string' ? message.parentId : null
    const rows = byParent.get(parentId)
    if (rows) rows.push(message)
    else byParent.set(parentId, [message])
  }
  for (const rows of byParent.values()) rows.sort(compareFixtureSiblings)
  return byParent
}

function compareFixtureSiblings(left, right) {
  return (
    Number(left.siblingIndex) - Number(right.siblingIndex) ||
    Number(left.createdAt) - Number(right.createdAt) ||
    Number(left.turnIndex) - Number(right.turnIndex) ||
    String(left.role).localeCompare(String(right.role))
  )
}

async function exportWorkspaceThroughUi(page) {
  const returnUrl = page.url()
  const storageUrl = new URL('/#/storage', returnUrl).href
  await page.goto(storageUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-ui="storage-overview"]').waitFor({ state: 'visible' })
  await page
    .locator('[data-ui="storage-action"][title="Export the full IndexedDB workspace"]')
    .click()
  const nativeDownloadDirectory = process.env.E2E_NATIVE_CDP_ARTIFACTS_DIR
  if (nativeDownloadDirectory) {
    const priorNames = new Set(await readdir(nativeDownloadDirectory))
    const downloadPromise = downloadJsonFromDirectory(nativeDownloadDirectory, priorNames)
    await page.getByRole('button', { name: 'Export sensitive backup' }).click()
    return downloadPromise
  }
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export sensitive backup' }).click()
  return downloadJson(await downloadPromise)
}

async function restoreWorkspaceThroughUi(page, backup, options = {}) {
  const returnUrl = options.returnUrl ?? page.url()
  const storageUrl = new URL('/#/storage', returnUrl).href
  if (page.url() !== storageUrl) {
    await page.goto(storageUrl, { waitUntil: 'domcontentloaded' })
  }
  await page.locator('[data-ui="storage-overview"]').waitFor({ state: 'visible' })
  let releaseWorkspaceImportFile = async () => {}
  try {
    await runAndWaitForFreshToast(
      page,
      /^Imported workspace backup \(\d+ chats\)\.$/u,
      async () => {
        releaseWorkspaceImportFile = await setWorkspaceImportFile(
          page,
          backup,
          options.filename ?? 'natter-workspace-fixture.json',
        )
        await confirmWorkspaceReplacement(page)
      },
    )
  } finally {
    await releaseWorkspaceImportFile()
  }
  if (options.returnUrl !== undefined) {
    await page.goto(returnUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('#root > *').first().waitFor({ state: 'visible' })
    await waitForWorkspaceRunning(page)
  }
}

export async function waitForWorkspaceRunning(page) {
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-ui="app-shell"]')
        ?.getAttribute('data-workspace-runtime-state') === 'RUNNING',
  )
}

async function setWorkspaceImportFile(page, backup, filename) {
  const bytes = Buffer.from(JSON.stringify(backup))
  if (bytes.byteLength < 32 * 1024 * 1024) {
    await page.locator('[data-ui="storage-workspace-import-input"]').setInputFiles({
      name: filename,
      mimeType: 'application/json',
      buffer: bytes,
    })
    return async () => {}
  }
  const directory = await mkdtemp(join(tmpdir(), 'natter-workspace-import-'))
  const path = join(directory, 'workspace.json')
  try {
    await writeFile(path, bytes)
    await page.locator('[data-ui="storage-workspace-import-input"]').setInputFiles(path)
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  return () => rm(directory, { recursive: true, force: true })
}

export async function transformWorkspaceThroughUi(page, transform, options = {}) {
  const returnUrl = options.returnUrl ?? page.url()
  const backup = await exportWorkspaceThroughUi(page)
  const draft = clone(backup)
  const transformed = refreshWorkspaceManifest((await transform(draft)) ?? draft)
  await restoreWorkspaceThroughUi(page, transformed, {
    filename: options.filename,
    returnUrl,
  })
  return transformed
}

export function portableChatEnvelopeFromWorkspace(backup, fixture) {
  const { preset, profile } = firstWorkspaceProfileAndPreset(backup)
  const sourceChatId = fixture.sourceChatId ?? `fixture-chat-${Date.now()}`
  const now = fixture.createdAt ?? Date.now()
  if (!Array.isArray(fixture.messages) || fixture.messages.length === 0) {
    throw new Error('portable chat fixture messages missing')
  }
  const settings = {
    ...clone(preset.settings),
    ...(fixture.settings ?? {}),
    profileId: profile.id,
  }
  const messages = fixture.messages.map((message) => ({
    ...clone(message),
    chatId: sourceChatId,
  }))
  let updatedAt = now
  for (const message of messages) {
    if (typeof message.createdAt === 'number' && message.createdAt > updatedAt) {
      updatedAt = message.createdAt
    }
  }
  return {
    objectKind: 'chat',
    exportSchemaVersion: backup.exportSchemaVersion,
    appStorageSchemaVersion: backup.appStorageSchemaVersion,
    createdAt: now,
    source: clone(backup.source),
    payload: {
      chat: {
        sourceChatId,
        title: fixture.title ?? 'Imported fixture chat',
        createdAt: now,
        updatedAt: fixture.updatedAt ?? updatedAt,
        settings,
        ...(fixture.color === undefined ? {} : { color: fixture.color }),
        ...(fixture.favoriteModels === undefined
          ? {}
          : { favoriteModels: clone(fixture.favoriteModels) }),
        ...(fixture.recentModels === undefined
          ? {}
          : { recentModels: clone(fixture.recentModels) }),
      },
      messages,
      ...(fixture.folder === undefined ? {} : { folder: clone(fixture.folder) }),
      tags: clone(fixture.tags ?? []),
      attachments: clone(fixture.attachments ?? []),
      connectionSketch: {
        sourceProfileId: profile.id,
        name: profile.name,
        kind: profile.kind,
        baseUrl: profile.baseUrl,
      },
    },
  }
}

export async function importPortableChatThroughUi(page, fixture) {
  const returnUrl = page.url()
  let backup = await exportWorkspaceThroughUi(page)
  if (fixture.workspaceSettings && Object.keys(fixture.workspaceSettings).length > 0) {
    backup = putWorkspaceSettings(backup, fixture.workspaceSettings)
    await restoreWorkspaceThroughUi(page, backup, {
      filename: 'natter-workspace-public-fixture-settings.json',
      returnUrl,
    })
  } else {
    await page.goto(returnUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('#root > *').first().waitFor({ state: 'visible' })
    await waitForWorkspaceRunning(page)
  }
  const envelope = portableChatEnvelopeFromWorkspace(backup, fixture)
  await runAndWaitForFreshToast(page, 'Imported chat.', async () => {
    await page.locator('[data-ui="sidebar-chat-import-input"]').setInputFiles({
      name: 'natter-chat-public-fixture.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(envelope)),
    })
  })
  await page.waitForFunction(() => /^#\/chat\/[^/]+(?:\/message\/[^/]+)?$/u.test(location.hash))
  await waitForWorkspaceRunning(page)
  const match = /^#\/chat\/([^/]+)/u.exec(new URL(page.url()).hash)
  if (!match) throw new Error('imported chat route missing')
  const chatId = decodeURIComponent(match[1])
  let messageIdMap = null
  if (fixture.captureMessageIds) {
    const importedUrl = page.url()
    const importedWorkspace = await exportWorkspaceThroughUi(page)
    if (
      !isRecord(importedWorkspace.payload) ||
      !Array.isArray(importedWorkspace.payload.messages)
    ) {
      throw new Error('imported workspace messages missing')
    }
    messageIdMap = correlateImportedMessageIds(
      envelope.payload.messages,
      importedWorkspace.payload.messages.filter(
        (message) => isRecord(message) && message.chatId === chatId,
      ),
    )
    await page.goto(importedUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('#root > *').first().waitFor({ state: 'visible' })
    await waitForWorkspaceRunning(page)
  }
  return { chatId, envelope, messageIdMap }
}

function targetSettings(settings, profileId, target) {
  if (!isRecord(settings)) throw new Error('workspace fixture settings missing')
  const next = {
    ...settings,
    profileId,
    api: target.api,
    model: target.model,
  }
  if (target.paretoFilter === undefined) return next
  const privacy = isRecord(settings.privacy) ? settings.privacy : {}
  return {
    ...next,
    privacy: { ...privacy, paretoFilter: target.paretoFilter },
  }
}

function configureChatSettings(settings, options) {
  if (!isRecord(settings)) throw new Error('workspace fixture settings missing')
  const next = {
    ...settings,
    ...(options.model === undefined ? {} : { model: options.model }),
  }
  if (options.paretoFilter === undefined) return next
  const privacy = isRecord(settings.privacy) ? settings.privacy : {}
  return {
    ...next,
    privacy: { ...privacy, paretoFilter: options.paretoFilter },
  }
}

export async function configureWorkspaceThroughUi(page, options = {}) {
  await transformWorkspaceThroughUi(
    page,
    (backup) => {
      if (!isRecord(backup.payload)) throw new Error('workspace fixture payload missing')
      for (const tableName of ['presets', 'chats']) {
        const rows = backup.payload[tableName]
        if (!Array.isArray(rows)) throw new Error(`workspace fixture table missing: ${tableName}`)
        backup.payload[tableName] = rows.map((row) => {
          if (!isRecord(row)) throw new Error(`workspace fixture ${tableName} row invalid`)
          return { ...row, settings: configureChatSettings(row.settings, options) }
        })
      }
      if (options.workspaceSettings) putWorkspaceSettings(backup, options.workspaceSettings)
      return backup
    },
    { filename: 'natter-workspace-configuration-fixture.json' },
  )
}

export async function appendChatCatalogFixturesThroughUi(page, fixture) {
  await transformWorkspaceThroughUi(
    page,
    (backup) => {
      const { payload, preset } = firstWorkspaceProfileAndPreset(backup)
      const now = fixture.now ?? Date.now()
      if (fixture.workspaceSettings) putWorkspaceSettings(backup, fixture.workspaceSettings)
      const folders = fixture.folders ?? []
      const tags = fixture.tags ?? []
      const chats = fixture.chats ?? []
      const existingIds = new Set(payload.chats.map((chat) => chat.id))
      const existingMessageIds = new Set(payload.messages.map((message) => message.id))
      for (const folder of folders) {
        payload.folders.push({
          ...clone(folder),
          sortIndex: folder.sortIndex ?? 0,
          createdAt: folder.createdAt ?? now,
          updatedAt: folder.updatedAt ?? now,
        })
      }
      for (const tag of tags) {
        payload.tags.push({
          ...clone(tag),
          nameLower: tag.nameLower ?? tag.name.toLocaleLowerCase(),
          createdAt: tag.createdAt ?? now,
          updatedAt: tag.updatedAt ?? now,
        })
      }
      for (const chat of chats) {
        if (existingIds.has(chat.id)) throw new Error(`workspace fixture chat exists: ${chat.id}`)
        existingIds.add(chat.id)
        const updatedAt = chat.updatedAt ?? chat.createdAt ?? now
        const previewMessageId =
          chat.previewText === undefined ? null : `catalog-preview-message:${chat.id}`
        if (previewMessageId !== null) {
          if (existingMessageIds.has(previewMessageId)) {
            throw new Error(`workspace fixture message exists: ${previewMessageId}`)
          }
          existingMessageIds.add(previewMessageId)
          payload.messages.push({
            id: previewMessageId,
            chatId: chat.id,
            parentId: null,
            siblingIndex: 0,
            turnId: `catalog-preview-turn:${chat.id}`,
            turnIndex: 0,
            createdAt: updatedAt,
            role: 'user',
            origin: 'user',
            nodeVersion: 0,
            deleted: false,
            content: [{ type: 'text', text: chat.previewText }],
          })
        }
        payload.chats.push({
          id: chat.id,
          title: chat.title,
          titleStatus: chat.titleStatus ?? 'manual',
          createdAt: chat.createdAt ?? updatedAt,
          updatedAt,
          lastViewedAt: chat.lastViewedAt ?? updatedAt,
          wordCount: chat.wordCount ?? 0,
          totalCostUsd: chat.totalCostUsd ?? 0,
          metaVersion: 0,
          summaryVersion: 0,
          configurationVersion: 0,
          settings: { ...clone(preset.settings), ...(chat.settings ?? {}) },
          presetId: preset.id,
          lastUpdatedLeafId: previewMessageId,
          lastBranchUpdatedAt: chat.lastBranchUpdatedAt ?? updatedAt,
          archived: chat.archived ?? false,
          pinned: chat.pinned ?? false,
          folderId: chat.folderId ?? null,
          tags: clone(chat.tags ?? []),
          ...(chat.previewText === undefined ? {} : { previewText: chat.previewText }),
        })
      }
      return backup
    },
    { filename: 'natter-workspace-chat-catalog-fixture.json' },
  )
}

function retargetBackup(backup, providerBaseUrl, target) {
  if (!isRecord(backup) || !isRecord(backup.payload)) {
    throw new Error('workspace fixture backup envelope invalid')
  }
  const { payload } = backup
  if (!Array.isArray(payload.profiles) || payload.profiles.length !== 1) {
    throw new Error(
      `expected one workspace fixture profile, found ${
        Array.isArray(payload.profiles) ? payload.profiles.length : 'invalid'
      }`,
    )
  }
  if (!Array.isArray(payload.presets) || payload.presets.length === 0) {
    throw new Error('workspace fixture preset missing')
  }
  if (!Array.isArray(payload.chats)) throw new Error('workspace fixture chats missing')
  const profile = payload.profiles[0]
  if (!isRecord(profile) || typeof profile.id !== 'string') {
    throw new Error('workspace fixture profile invalid')
  }
  const now = Date.now()
  payload.profiles = [
    {
      ...profile,
      name: target.name,
      kind: target.kind,
      baseUrl: providerBaseUrl,
      supportsEndpointsApi: target.kind === 'openrouter',
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      updatedAt: now,
    },
  ]
  payload.presets = payload.presets.map((preset) => {
    if (!isRecord(preset)) throw new Error('workspace fixture preset invalid')
    return {
      ...preset,
      connectionProfileId: profile.id,
      settings: targetSettings(preset.settings, profile.id, target),
      updatedAt: now,
    }
  })
  payload.chats = payload.chats.map((chat) => {
    if (!isRecord(chat)) throw new Error('workspace fixture chat invalid')
    return {
      ...chat,
      settings: targetSettings(chat.settings, profile.id, target),
    }
  })
  return backup
}

async function confirmWorkspaceReplacement(page) {
  const dialog = page.getByRole('dialog', { name: 'Replace local workspace?' })
  await dialog.waitFor({ state: 'visible' })
  await dialog.locator('[data-role="confirm"]').click()
}

export async function retargetWorkspaceThroughBackupImport(page, providerBaseUrl, options = {}) {
  const target = {
    name: options.name ?? 'Loopback fake provider',
    kind: options.kind ?? 'openai-compatible',
    api: options.api ?? 'chat',
    model: options.model ?? 'natter/fake-stream',
    paretoFilter: options.paretoFilter,
  }
  await transformWorkspaceThroughUi(
    page,
    (backup) => retargetBackup(backup, providerBaseUrl, target),
    { filename: 'natter-workspace-provider-fixture.json' },
  )
}
