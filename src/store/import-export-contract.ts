import type { ConversationProvedSelection } from '../core/messages'
import type { ChatId, PresetId, ProfileId } from '../core/types'

export interface ImportChatOptions {
  now?: number
  targetProfileId?: ProfileId | null
  destinationChatId?: ChatId
}

export interface ImportChatResult {
  chatId: ChatId
  destination: ConversationProvedSelection
}

export interface ImportChatPresetOptions {
  now?: number
  targetProfileId?: ProfileId | null
}

export interface ImportChatPresetResult {
  presetId: PresetId
  profileId: ProfileId
  profileMatched: boolean
}

export interface ImportConnectionProfileOptions {
  now?: number
}

export interface ImportConnectionProfileResult {
  profileId: ProfileId
}

export interface RestoreWorkspaceBackupOptions {
  now?: number
}

export interface RestoreWorkspaceBackupResult {
  chatCount: number
  messageCount: number
  attachmentCount: number
  profileCount: number
  presetCount: number
  promptPresetCount: number
  keyCount: number
}
