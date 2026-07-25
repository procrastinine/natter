import type { WorkspaceBackupEnvelope } from '../src/core/import-export/schema'

export interface GeneratedWorkspaceScale {
  readonly name: string
  readonly seed: number
  readonly chatCount: number
  readonly profileCount: number
  readonly presetCount: number
  readonly promptPresetCount: number
  readonly folderCount: number
  readonly tagCount: number
}

export interface GeneratedWorkspaceFixtureStats {
  readonly chatCount: number
  readonly messageCount: number
  readonly profileCount: number
  readonly presetCount: number
  readonly promptPresetCount: number
  readonly folderCount: number
  readonly tagCount: number
  readonly bodyTextChars: number
  readonly assistantCost: number
  readonly assistantPromptTokens: number
  readonly assistantCompletionTokens: number
  readonly branchedParentCount: number
  readonly maxSiblingCount: number
  readonly activeChatMessageCount: number
}

export const GENERATED_WORKSPACE_FIXTURE_VERSION: number
export const GENERATED_WORKSPACE_ACTIVE_CHAT_ID: string
export const GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID: string
export const GENERATED_WORKSPACE_ACTIVE_TERMINAL_MARKER: string
export const GENERATED_WORKSPACE_SCALES: Readonly<{
  control: GeneratedWorkspaceScale
  large: GeneratedWorkspaceScale
}>

export function generateWorkspaceFixture(
  template: WorkspaceBackupEnvelope,
  scale: GeneratedWorkspaceScale,
): WorkspaceBackupEnvelope

export function generatedWorkspaceFixtureStats(
  backup: WorkspaceBackupEnvelope,
): GeneratedWorkspaceFixtureStats

export function refreshWorkspaceManifest(
  backup: WorkspaceBackupEnvelope,
): WorkspaceBackupEnvelope
