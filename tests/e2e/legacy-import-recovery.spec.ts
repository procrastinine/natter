import type { BrowserContext } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'
import { expect, test } from './fixtures'
import { clearIndexedDb } from './helpers'

const LEGACY_CREATED_AT = 1_720_000_000_000
const LEGACY_PROFILE_ID = 'legacy-dangling-key-profile'
const LEGACY_CHAT_TITLE = 'Legacy two-message chat'
const LEGACY_MODEL_ID = 'anthropic/claude-opus-4.8'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('legacy storage-v25 workspace and portable chat recover through public imports', async ({
  context,
  expectRuntimeDiagnostic,
  page,
}) => {
  expectRuntimeDiagnostic({
    category: 'console-other',
    source: 'console',
    level: 'warning',
    message: "Dexie\\.delete\\('natter'\\) was blocked",
    count: 1,
  })
  await mockLegacyOpenRouterDiscovery(context)
  await page.goto('/#/storage')
  await expect(page.locator('[data-ui="storage-overview"]')).toBeVisible()
  const secondPage = await context.newPage()
  await secondPage.goto('/#/storage')
  await expect(secondPage.locator('[data-ui="storage-overview"]')).toBeVisible()
  await retainObsoleteWorkspaceDatabase(page)

  page.once('dialog', (dialog) => dialog.accept())
  await page.locator('[data-ui="storage-workspace-import-input"]').setInputFiles({
    name: 'natter-workspace-storage-v25-sanitized.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacyWorkspaceBackup())),
  })
  await expect(
    page.locator('[data-ui="toast-text"]').filter({
      hasText: 'Imported workspace backup (0 chats).',
    }),
  ).toBeVisible()
  await expect(page.locator('[data-ui="workspace-bootstrap"][data-state="failed"]')).toHaveCount(0)
  const workspaceSlot = await readWorkspaceSlotState(page)
  expect(workspaceSlot.activeDatabaseName).toBe('natter-workspace-a')
  expect(workspaceSlot.pendingPhase).toBe('cleanup')
  expect(workspaceSlot.names).toContain('natter-control')
  expect(workspaceSlot.names).toContain('natter-workspace-a')
  expect(workspaceSlot.names).toContain('natter')

  await expect(secondPage).toHaveURL(/#\/storage$/u)
  await expect(
    secondPage.locator('[data-ui="workspace-bootstrap"][data-state="failed"]'),
  ).toHaveCount(0)
  await secondPage.locator('[data-ui="open-global-settings"]').click()
  await secondPage.getByRole('tab', { name: 'Connections' }).click()
  await expect(
    secondPage
      .locator('[data-ui="connection-manager-row"]')
      .filter({ hasText: 'Legacy missing key' }),
  ).toBeVisible()
  await secondPage.getByRole('button', { name: 'Close settings' }).click()

  await page.locator('[data-ui="open-global-settings"]').click()
  await page.getByRole('tab', { name: 'Connections' }).click()
  const connections = page.locator('[data-ui="connection-manager-list"]')
  const legacyConnection = connections
    .locator('[data-ui="connection-manager-row"]')
    .filter({ hasText: 'Legacy missing key' })
  await expect(legacyConnection).toBeVisible()
  await expect(legacyConnection).toContainText('0 presets')
  await expect(legacyConnection).toContainText('0 chats')
  await legacyConnection.getByRole('button', { name: 'Duplicate' }).click()
  await expect(
    connections
      .locator('[data-ui="connection-manager-row"]')
      .filter({ hasText: 'Legacy missing key (copy)' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Close settings' }).click()

  await releaseObsoleteWorkspaceDatabase(page)
  await expect
    .poll(() => readWorkspaceSlotState(page))
    .toMatchObject({
      activeDatabaseName: 'natter-workspace-a',
      pendingPhase: null,
      names: expect.not.arrayContaining(['natter']),
    })

  await page.reload()
  await expect(page.locator('[data-ui="storage-overview"]')).toBeVisible()
  await expect(page.locator('[data-ui="workspace-bootstrap"][data-state="failed"]')).toHaveCount(0)

  await page.locator('[data-ui="sidebar-chat-import-input"]').setInputFiles({
    name: 'natter-chat-storage-v25-two-message-sanitized.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacyPortableChat())),
  })
  await expect(
    page.locator('[data-ui="toast"]').filter({ hasText: 'Imported chat.' }),
  ).toBeVisible()
  await page.waitForFunction(() => /^#\/chat\/[^/]+(?:\/message\/[^/]+)?$/u.test(location.hash))
  await expectLegacyTranscript(page)
  await page.locator('[data-role="settings-cog"]').click()
  await page.getByRole('tab', { name: 'Context' }).click()
  await expect(page.getByRole('meter', { name: 'Estimated prompt tokens used' })).toBeVisible()
  await expect(page.getByText('Waiting for prompt estimate…', { exact: true })).toHaveCount(0)
  await page.locator('[data-role="settings-pane-close"]').click()

  await page.locator('[data-ui="open-storage"]').click()
  await expect(page.locator('[data-ui="storage-overview"]')).toBeVisible()
  const chatRow = page.locator('[data-ui="chat-row"]').filter({ hasText: LEGACY_CHAT_TITLE })
  await expect(chatRow).toBeVisible()
  await chatRow.locator('[data-ui="chat-row-link"]').click()
  await expectLegacyTranscript(page)

  await page.reload()
  await expectLegacyTranscript(page)
  await expect(page.locator('[data-ui="workspace-bootstrap"][data-state="failed"]')).toHaveCount(0)
})

test('chat ZIP import is atomic and its current rows survive reload', async ({
  expectRuntimeDiagnostic,
  page,
}) => {
  expectRuntimeDiagnostic({
    category: 'console-other',
    source: 'console',
    level: 'error',
    message: 'Failed to import chat JSON/ZIP',
    count: 1,
  })
  await page.goto('/')
  await expect(page.locator('[data-ui="app-shell"]')).toBeVisible()
  const alpha = renamedLegacyPortableChat('Atomic Alpha', 'alpha')
  const beta = renamedLegacyPortableChat('Atomic Beta', 'beta')
  const importInput = page.locator('[data-ui="sidebar-chat-import-input"]')

  await importInput.setInputFiles({
    name: 'malformed-later.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(
      zipSync({
        'alpha.json': strToU8(JSON.stringify(alpha)),
        'zeta.json': strToU8(JSON.stringify({ objectKind: 'chat' })),
      }),
    ),
  })

  await expect(page.locator('[data-ui="toast"][data-tone="danger"]')).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)

  await importInput.setInputFiles({
    name: 'two-chats.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(
      zipSync({
        'alpha.json': strToU8(JSON.stringify(alpha)),
        'beta.json': strToU8(JSON.stringify(beta)),
      }),
    ),
  })

  await expect(
    page.locator('[data-ui="toast"]').filter({ hasText: 'Imported 2 chats.' }),
  ).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(2)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toContainText(
    'Atomic Beta',
  )
  await expect(page.locator('[data-ui="message"]')).toHaveCount(2)

  await page.reload()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(2)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toContainText(
    'Atomic Beta',
  )
  await expect(page.locator('[data-ui="message"]')).toHaveCount(2)
  await expect(page.locator('[data-ui="workspace-bootstrap"][data-state="failed"]')).toHaveCount(0)
})

async function expectLegacyTranscript(page: Parameters<typeof clearIndexedDb>[0]): Promise<void> {
  await expect(
    page.locator('[data-ui="message"][data-role="user"]').locator('[data-ui="message-body"]'),
  ).toContainText('Legacy user text')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').locator('[data-ui="message-body"]'),
  ).toContainText('Legacy assistant text')
  await expect(page.locator('[data-ui="message"][data-state="crashed"]')).toHaveCount(0)
}

async function retainObsoleteWorkspaceDatabase(
  page: Parameters<typeof clearIndexedDb>[0],
): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.onversionchange = () => undefined
    ;(
      window as typeof window & { __natterObsoleteWorkspaceDatabase?: IDBDatabase }
    ).__natterObsoleteWorkspaceDatabase = database
  })
}

async function releaseObsoleteWorkspaceDatabase(
  page: Parameters<typeof clearIndexedDb>[0],
): Promise<void> {
  await page.evaluate(() => {
    const owner = window as typeof window & { __natterObsoleteWorkspaceDatabase?: IDBDatabase }
    owner.__natterObsoleteWorkspaceDatabase?.close()
    delete owner.__natterObsoleteWorkspaceDatabase
  })
}

async function readWorkspaceSlotState(page: Parameters<typeof clearIndexedDb>[0]) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).flatMap((database) =>
      database.name === undefined ? [] : [database.name],
    )
    const control = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter-control')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const manifest = await new Promise<{
        activeDatabaseName: string
        pending?: { phase?: string }
      }>((resolve, reject) => {
        const request = control
          .transaction('manifests', 'readonly')
          .objectStore('manifests')
          .get('workspace')
        request.onsuccess = () => {
          const result: unknown = request.result
          if (
            typeof result !== 'object' ||
            result === null ||
            !('activeDatabaseName' in result) ||
            typeof result.activeDatabaseName !== 'string'
          ) {
            reject(new Error('WorkspaceManifestInvalid'))
            return
          }
          const pendingPhase =
            'pending' in result &&
            typeof result.pending === 'object' &&
            result.pending !== null &&
            'phase' in result.pending &&
            typeof result.pending.phase === 'string'
              ? result.pending.phase
              : undefined
          resolve({
            activeDatabaseName: result.activeDatabaseName,
            ...(pendingPhase === undefined ? {} : { pending: { phase: pendingPhase } }),
          })
        }
        request.onerror = () => reject(request.error)
      })
      return {
        names,
        activeDatabaseName: manifest.activeDatabaseName,
        pendingPhase: manifest.pending?.phase ?? null,
      }
    } finally {
      control.close()
    }
  })
}

function legacyWorkspaceBackup() {
  return {
    objectKind: 'workspace-backup',
    exportSchemaVersion: 1,
    appStorageSchemaVersion: 25,
    createdAt: LEGACY_CREATED_AT,
    source: {
      app: 'natter',
      backendKind: 'browser-idb',
      workspaceId: 'sanitized-storage-v25-workspace',
    },
    payload: {
      chats: [],
      attachments: [legacyOrphanAttachment()],
      profiles: [
        {
          id: LEGACY_PROFILE_ID,
          name: 'Legacy missing key',
          kind: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyRef: 'legacy-key-row-that-does-not-exist',
          defaultHeaders: {},
          appTitle: 'Natter legacy fixture',
          appUrl: 'http://localhost',
          supportsEndpointsApi: true,
          supportsGenerationApi: true,
          supportsPrivacyScrape: true,
          createdAt: LEGACY_CREATED_AT,
          updatedAt: LEGACY_CREATED_AT,
        },
      ],
      presets: [],
      promptPresets: [],
      folders: [],
      tags: [],
      drafts: [],
      keys: [],
      settings: [],
    },
  }
}

function legacyOrphanAttachment() {
  return {
    attachment: {
      id: 'legacy-orphan-attachment',
      kind: 'plaintext',
      mime: 'text/plain',
      filename: 'orphan.txt',
      origin: 'import',
      createdAt: LEGACY_CREATED_AT,
      updatedAt: LEGACY_CREATED_AT,
      storage: { kind: 'local-blob', blobId: 'legacy-orphan-blob' },
      artifacts: [],
      processing: [],
      refCount: 0,
    },
    blobs: [
      {
        id: 'legacy-orphan-blob',
        attachmentId: 'legacy-orphan-attachment',
        role: 'original',
        mime: 'text/plain',
        contentHash: 'sha256:must-not-be-digested',
        sizeBytes: 8_192,
        dataBase64: 'not-valid-base64',
        createdAt: LEGACY_CREATED_AT,
      },
    ],
    artifacts: [],
    jobs: [],
  }
}

function legacyPortableChat() {
  const sourceChatId = 'legacy-portable-source-chat'
  return {
    objectKind: 'chat',
    exportSchemaVersion: 1,
    appStorageSchemaVersion: 25,
    createdAt: LEGACY_CREATED_AT,
    source: {
      app: 'natter',
      backendKind: 'browser-idb',
      workspaceId: 'sanitized-storage-v25-workspace',
    },
    payload: {
      chat: {
        sourceChatId,
        title: LEGACY_CHAT_TITLE,
        createdAt: LEGACY_CREATED_AT,
        updatedAt: LEGACY_CREATED_AT + 2,
        settings: legacyChatSettings(),
      },
      messages: [
        {
          id: 'legacy-user-message',
          chatId: sourceChatId,
          parentId: null,
          siblingIndex: 0,
          turnId: 'legacy-user-turn',
          turnIndex: 0,
          createdAt: LEGACY_CREATED_AT + 1,
          role: 'user',
          origin: 'user',
          content: [{ type: 'text', text: 'Legacy user text' }],
          nodeVersion: 0,
          deleted: false,
        },
        {
          id: 'legacy-assistant-message',
          chatId: sourceChatId,
          parentId: 'legacy-user-message',
          siblingIndex: 0,
          turnId: 'legacy-assistant-turn',
          turnIndex: 1,
          createdAt: LEGACY_CREATED_AT + 2,
          role: 'assistant',
          origin: 'imported',
          content: [{ type: 'output_text', text: 'Legacy assistant text' }],
          nodeVersion: 0,
          deleted: false,
        },
      ],
      tags: [],
      attachments: [],
      connectionSketch: {
        sourceProfileId: LEGACY_PROFILE_ID,
        name: 'Legacy missing key',
        kind: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
    },
  }
}

function renamedLegacyPortableChat(title: string, suffix: string) {
  const value = legacyPortableChat()
  const sourceChatId = `legacy-portable-source-${suffix}`
  value.payload.chat = { ...value.payload.chat, sourceChatId, title }
  value.payload.messages = value.payload.messages.map((message) => ({
    ...message,
    chatId: sourceChatId,
  }))
  return value
}

function legacyChatSettings() {
  return {
    profileId: LEGACY_PROFILE_ID,
    model: LEGACY_MODEL_ID,
    systemPrompt: '',
    systemRole: 'system',
    appendPrompt: '',
    continueSystemPrompt: 'Continue exactly where the response stopped.',
    continueUserPrompt: 'Continue.',
    defaultPrefill: '',
    continuePrefill: false,
    sampling: {},
    reasoning: {
      mode: 'default',
      exclude: false,
      summary: 'auto',
      include: { encrypted: true, summary: false, text: false },
      echoAsThinkTags: false,
    },
    contextStrategy: {
      kind: 'sliding_window',
      reservedForCompletion: 512,
      onOverflow: 'ask',
    },
    allowFallbacks: true,
    mediaContextStrategy: 'echo-all',
    mediaEchoN: 5,
    cacheRemoteImages: true,
    stripExifOnUpload: true,
    toolContextStrategy: 'echo-all',
    toolContextSummarizeAfterN: 6,
    toolCallContext: { include: true },
    enabledToolIds: [],
    tools: {
      openrouter: { enabledServerToolIds: [] },
      openai: { enabledServerToolIds: [] },
      anthropic: { enabledServerToolIds: [] },
      google: { enabledServerToolIds: [] },
    },
    enabledPluginIds: [],
    trustedToolIds: [],
    autoContinueToolLoop: true,
    anthropicCache: { mode: 'off', ttl: '5m' },
    privacy: {
      denyDataCollection: true,
      zdrOnly: false,
      paretoFilter: true,
      byokEnabled: false,
    },
    api: 'auto',
    responses: { store: false },
    userIdMode: 'omit',
    serviceTier: 'auto',
  }
}

async function mockLegacyOpenRouterDiscovery(context: BrowserContext): Promise<void> {
  const architecture = {
    input_modalities: ['text'],
    output_modalities: ['text'],
    tokenizer: 'claude',
  }
  const supportedParameters = ['provider', 'max_tokens']
  await context.route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: LEGACY_MODEL_ID,
            name: LEGACY_MODEL_ID,
            context_length: 200_000,
            architecture,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: supportedParameters,
          },
        ],
      }),
    })
  })
  await context.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: LEGACY_MODEL_ID,
          name: LEGACY_MODEL_ID,
          context_length: 200_000,
          architecture,
          endpoints: [
            {
              provider_name: 'Deterministic fixture',
              supported_parameters: supportedParameters,
              context_length: 200_000,
              max_prompt_tokens: 200_000,
              max_completion_tokens: 8_192,
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        },
      }),
    })
  })
  await context.route('**/_or_scrape/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"providers":[]}}}</script>',
    })
  })
}
