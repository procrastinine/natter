import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
  GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
  GENERATED_WORKSPACE_ACTIVE_TERMINAL_MARKER,
  GENERATED_WORKSPACE_SCALES,
  generatedWorkspaceFixtureStats,
  generateWorkspaceFixture,
} from '../../scripts/generated-workspace-fixture.mjs'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  assertNatterExportEnvelope,
  NATTER_EXPORT_SCHEMA_VERSION,
  WORKSPACE_BACKUP_TABLE_KEYS,
  type WorkspaceBackupEnvelope,
} from '../../src/core/import-export/schema'
import { validateWorkspaceBackupGraph } from '../../src/core/import-export/workspace-validation'
import type { ConnectionProfile } from '../../src/core/types'

describe('generated large-workspace fixture', () => {
  it('is deterministic, public-envelope valid, and exercises branched metadata-rich workspaces', () => {
    const first = generateWorkspaceFixture(templateWorkspace(), GENERATED_WORKSPACE_SCALES.control)
    const second = generateWorkspaceFixture(templateWorkspace(), GENERATED_WORKSPACE_SCALES.control)

    assertNatterExportEnvelope(first)
    validateWorkspaceBackupGraph(first.payload)
    expect(contentHash(first)).toBe(contentHash(second))
    expect(first.payload.manifest?.counts).toEqual(
      Object.fromEntries(
        WORKSPACE_BACKUP_TABLE_KEYS.map((key) => [key, first.payload[key].length]),
      ),
    )

    const stats = generatedWorkspaceFixtureStats(first)
    expect(stats).toMatchObject({
      chatCount: GENERATED_WORKSPACE_SCALES.control.chatCount,
      profileCount: GENERATED_WORKSPACE_SCALES.control.profileCount,
      presetCount: GENERATED_WORKSPACE_SCALES.control.presetCount,
      promptPresetCount: GENERATED_WORKSPACE_SCALES.control.promptPresetCount,
      activeChatMessageCount: 96,
    })
    expect(stats.branchedParentCount).toBeGreaterThan(0)
    expect(stats.maxSiblingCount).toBeGreaterThan(1)
    expect(stats.assistantPromptTokens).toBeGreaterThan(0)
    expect(stats.assistantCompletionTokens).toBeGreaterThan(0)
    expect(stats.assistantCost).toBeGreaterThan(0)

    const activeRows = first.payload.messages.filter(
      (message) => message.chatId === GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
    )
    const terminal = activeRows.find(
      (message) => message.id === GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
    )
    const terminalContent = terminal?.content[0]
    expect(terminalContent?.type).toBe('output_text')
    expect(terminalContent?.type === 'output_text' ? terminalContent.text : '').toContain(
      GENERATED_WORKSPACE_ACTIVE_TERMINAL_MARKER,
    )
    expect(
      first.payload.messages.some(
        (message) => message.parentId === GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
      ),
    ).toBe(false)
    const usage = activeRows.find((message) => message.role === 'assistant')?.generation?.usage
    expect(typeof usage?.prompt_tokens).toBe('number')
    expect(typeof usage?.completion_tokens).toBe('number')
    expect(typeof usage?.total_tokens).toBe('number')
    expect(typeof usage?.cost).toBe('number')
    expect(typeof usage?.prompt_tokens_details?.cached_tokens).toBe('number')
    expect(typeof usage?.completion_tokens_details?.reasoning_tokens).toBe('number')
    expectChatAggregatesMatchMessages(first)
  })

  it('materializes the requested scale without embedding a corpus in git', () => {
    const fixture = generateWorkspaceFixture(templateWorkspace(), GENERATED_WORKSPACE_SCALES.large)
    assertNatterExportEnvelope(fixture)
    validateWorkspaceBackupGraph(fixture.payload)

    const stats = generatedWorkspaceFixtureStats(fixture)
    expect(stats.chatCount).toBe(4_096)
    expect(stats.profileCount).toBe(256)
    expect(stats.presetCount).toBe(768)
    expect(stats.messageCount).toBeGreaterThan(20_000)
    expect(stats.branchedParentCount).toBeGreaterThan(2_000)
    expect(stats.bodyTextChars).toBeGreaterThan(5_000_000)
    expectChatAggregatesMatchMessages(fixture)
  })
})

function templateWorkspace(): WorkspaceBackupEnvelope {
  const profile: ConnectionProfile = {
    id: 'base-profile',
    name: 'Base profile',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultHeaders: {},
    appTitle: 'Natter fixture',
    appUrl: 'http://127.0.0.1:4173',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    requestRevision: 0,
    createdAt: 1_780_000_000_000,
    updatedAt: 1_780_000_000_000,
  }
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = 'google/gemini-3.5-flash'
  return {
    objectKind: 'workspace-backup',
    exportSchemaVersion: NATTER_EXPORT_SCHEMA_VERSION,
    appStorageSchemaVersion: 66,
    createdAt: 1_780_000_000_000,
    source: {
      app: 'natter',
      backendKind: 'browser-idb',
      workspaceId: 'generated-workspace-template',
    },
    payload: {
      chats: [],
      messages: [],
      childLists: [],
      chatBranchCache: [],
      attachments: [],
      profiles: [profile],
      presets: [
        {
          id: 'base-preset',
          name: 'Base preset',
          connectionProfileId: profile.id,
          settings,
          createdAt: 1_780_000_000_000,
          updatedAt: 1_780_000_000_000,
        },
      ],
      promptPresets: [],
      folders: [],
      tags: [],
      drafts: [],
      keys: [],
      settings: [],
    },
  }
}

function expectChatAggregatesMatchMessages(backup: WorkspaceBackupEnvelope): void {
  const messagesByChat = new Map<string, typeof backup.payload.messages>()
  for (const message of backup.payload.messages) {
    const rows = messagesByChat.get(message.chatId)
    if (rows) rows.push(message)
    else messagesByChat.set(message.chatId, [message])
  }
  for (const chat of backup.payload.chats) {
    const messages = messagesByChat.get(chat.id) ?? []
    const cost = Number(
      messages.reduce((sum, message) => sum + (message.generation?.cost ?? 0), 0).toFixed(9),
    )
    expect(chat.totalCostUsd, chat.id).toBe(cost)
    expect(
      messages.some((message) => message.id === chat.lastUpdatedLeafId),
      chat.id,
    ).toBe(true)
  }
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
