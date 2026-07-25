import type { Page } from '@playwright/test'

export interface PortableChatFixture {
  sourceChatId?: string
  title?: string
  createdAt?: number
  updatedAt?: number
  settings?: Record<string, unknown>
  workspaceSettings?: Record<string, unknown>
  captureMessageIds?: boolean
  color?: string
  favoriteModels?: string[]
  recentModels?: string[]
  messages: Array<Record<string, unknown>>
  folder?: { name: string; color?: string }
  tags?: Array<{ name: string; color?: string }>
  attachments?: Array<Record<string, unknown>>
}

export function transformWorkspaceThroughUi(
  page: Page,
  transform: (
    backup: Record<string, unknown>,
  ) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>,
  options?: { filename?: string; returnUrl?: string },
): Promise<Record<string, unknown>>

export function waitForWorkspaceRunning(page: Page): Promise<void>

export function portableChatEnvelopeFromWorkspace(
  backup: Record<string, unknown>,
  fixture: PortableChatFixture,
): Record<string, unknown>

export function importPortableChatThroughUi(
  page: Page,
  fixture: PortableChatFixture,
): Promise<{
  chatId: string
  envelope: Record<string, unknown>
  messageIdMap: Record<string, string> | null
}>

export function configureWorkspaceThroughUi(
  page: Page,
  options?: {
    model?: string
    paretoFilter?: boolean
    workspaceSettings?: Record<string, unknown>
  },
): Promise<void>

export interface WorkspaceChatCatalogFixture {
  id: string
  title: string
  titleStatus?: string
  createdAt?: number
  updatedAt?: number
  lastViewedAt?: number
  wordCount?: number
  totalCostUsd?: number
  settings?: Record<string, unknown>
  lastBranchUpdatedAt?: number
  archived?: boolean
  pinned?: boolean
  folderId?: string | null
  tags?: string[]
  previewText?: string
}

export function appendChatCatalogFixturesThroughUi(
  page: Page,
  fixture: {
    now?: number
    workspaceSettings?: Record<string, unknown>
    folders?: Array<{
      id: string
      name: string
      sortIndex?: number
      createdAt?: number
      updatedAt?: number
      lastUsedAt?: number
    }>
    tags?: Array<{
      id: string
      name: string
      nameLower?: string
      createdAt?: number
      updatedAt?: number
      lastUsedAt?: number
    }>
    chats?: WorkspaceChatCatalogFixture[]
  },
): Promise<void>

export interface WorkspaceProviderFixtureTarget {
  name?: string
  kind?: 'openrouter' | 'openai-compatible' | 'anthropic' | 'google' | 'llama-server' | 'custom'
  api?: 'auto' | 'chat' | 'responses' | 'text' | 'gemini-native' | 'anthropic-messages'
  model?: string
  paretoFilter?: boolean
}

export function retargetWorkspaceThroughBackupImport(
  page: Page,
  providerBaseUrl: string,
  target?: WorkspaceProviderFixtureTarget,
): Promise<void>
