import type { ChatSettingsPatch } from '../core/chat-metadata'
import {
  AVAILABLE_GENERATION_CAPABILITY,
  failedGenerationCapability,
  type GenerationCapability,
  type GenerationCapabilityTarget,
  pendingGenerationCapability,
  unavailableGenerationCapability,
} from '../core/interaction-capability'
import type { ChatId } from '../core/types'
import type { AttemptTargetAdmissionFrame } from './attempt-controller'
import {
  type ActiveConfigurationTarget,
  type ActiveGenerationConfigurationFrame,
  type ActiveGenerationConfigurationRequirement,
  type ActiveGenerationConfigurationResolution,
  configurationController,
  type SelectedGenerationConfigurationClaim,
} from './configuration-controller'
import { type ConversationPromptPathFrame, conversationController } from './conversation-controller'
import type { WorkspaceFence } from './repository'
import { getWorkspaceRuntimeFence, getWorkspaceRuntimeState } from './workspace-runtime'

export type GenerationAdmissionCapabilityProbe = GenerationCapabilityTarget

export type ActiveTargetGenerationConfigurationCaptureState =
  | {
      readonly kind: 'resolved-active-target'
      readonly chatId: ChatId
      readonly resolution: ActiveGenerationConfigurationResolution
    }
  | {
      readonly kind: 'selected-active-target'
      readonly chatId: ChatId
      readonly claim: SelectedGenerationConfigurationClaim
    }
  | {
      readonly kind: 'pending-active-target'
      readonly chatId: ChatId
    }

type GenerationCapabilityRequirementProbe = GenerationAdmissionCapabilityProbe & {
  readonly settingsPatch?: ChatSettingsPatch
}

export interface GenerationCapabilityFrame {
  capability(probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability
}

export interface GenerationCapabilityContext {
  readonly workspace: WorkspaceFence | null
  readonly configuration: ActiveGenerationConfigurationFrame | null
  readonly configurationTarget: ActiveConfigurationTarget | null
  readonly promptPath: ConversationPromptPathFrame | null
  readonly attemptAdmission: AttemptTargetAdmissionFrame | null
  readonly frame: GenerationCapabilityFrame
}

export interface GenerationCapabilityController {
  captureContext(
    attemptAdmission?: AttemptTargetAdmissionFrame | null,
    promptPathOverride?: ConversationPromptPathFrame,
    configurationOverride?: ActiveGenerationConfigurationResolution,
  ): GenerationCapabilityContext
  captureFrame(attemptAdmission?: AttemptTargetAdmissionFrame | null): GenerationCapabilityFrame
  capability(probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability
}

const NEW_CHAT_GENERATION_CONFIGURATION_REQUIREMENT: ActiveGenerationConfigurationRequirement =
  Object.freeze({ kind: 'new-chat' })

class TabGenerationCapabilityController implements GenerationCapabilityController {
  private cache: {
    readonly workspaceId: string
    readonly replacementEpoch: number
    readonly configuration: ActiveGenerationConfigurationFrame
    readonly configurationTarget: ActiveConfigurationTarget
    readonly promptPath: ConversationPromptPathFrame
    readonly attemptAdmission: AttemptTargetAdmissionFrame | null
    readonly configurationOverride: ActiveGenerationConfigurationResolution | undefined
    readonly context: GenerationCapabilityContext
  } | null = null

  captureContext(
    attemptAdmission: AttemptTargetAdmissionFrame | null = null,
    promptPathOverride?: ConversationPromptPathFrame,
    configurationOverride?: ActiveGenerationConfigurationResolution,
  ): GenerationCapabilityContext {
    const workspaceState = getWorkspaceRuntimeState()
    if (workspaceState === 'FAILED_CLOSED' || workspaceState === 'SEALED') {
      return FAILED_WORKSPACE_CAPABILITY_CONTEXT
    }
    if (workspaceState !== 'RUNNING') return PENDING_WORKSPACE_CAPABILITY_CONTEXT
    const workspace = getWorkspaceRuntimeFence()
    if (!workspace) return PENDING_WORKSPACE_CAPABILITY_CONTEXT
    const configurationFrame = configurationController.getSnapshot().frame
    const configuration = configurationFrame.generation
    const configurationTarget = configurationFrame.target
    const promptPath =
      promptPathOverride &&
      promptPathOverride.workspaceId === workspace.workspaceId &&
      promptPathOverride.replacementEpoch === workspace.replacementEpoch
        ? promptPathOverride
        : conversationController.capturePromptPathFrame(workspace)
    if (
      configuration.workspaceId !== workspace.workspaceId ||
      configuration.replacementEpoch !== workspace.replacementEpoch
    ) {
      return Object.freeze({
        workspace,
        configuration: null,
        configurationTarget: null,
        promptPath,
        attemptAdmission,
        frame: Object.freeze({
          capability: (probe: GenerationAdmissionCapabilityProbe | null) => {
            if (!probe) return pendingGenerationCapability('prompt-path')
            const configurationCapability = configurationOverride
              ? generationConfigurationCapability(configurationOverride)
              : probe.kind === 'new-chat-send'
                ? pendingGenerationCapability('configuration')
                : AVAILABLE_GENERATION_CAPABILITY
            if (configurationCapability.state !== 'ready') return configurationCapability
            return probe.kind === 'new-chat-send'
              ? AVAILABLE_GENERATION_CAPABILITY
              : existingGenerationCapability(workspace, attemptAdmission, probe)
          },
        }),
      })
    }
    const cached = this.cache
    if (
      cached?.workspaceId === workspace.workspaceId &&
      cached.replacementEpoch === workspace.replacementEpoch &&
      cached.configuration === configuration &&
      cached.configurationTarget === configurationTarget &&
      cached.promptPath === promptPath &&
      cached.attemptAdmission === attemptAdmission &&
      cached.configurationOverride === configurationOverride
    ) {
      return cached.context
    }
    const frame = Object.freeze({
      capability: (probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability => {
        if (!probe) return pendingGenerationCapability('prompt-path')
        const configurationResolution =
          configurationOverride ??
          (probe.kind === 'new-chat-send'
            ? configuration.resolve(generationConfigurationRequirement(probe))
            : undefined)
        const configurationCapability = configurationResolution
          ? generationConfigurationCapability(configurationResolution)
          : AVAILABLE_GENERATION_CAPABILITY
        if (configurationCapability.state !== 'ready') return configurationCapability
        return probe.kind === 'new-chat-send'
          ? AVAILABLE_GENERATION_CAPABILITY
          : existingGenerationCapability(workspace, attemptAdmission, probe)
      },
    }) satisfies GenerationCapabilityFrame
    const context = Object.freeze({
      workspace,
      configuration,
      configurationTarget,
      promptPath,
      attemptAdmission,
      frame,
    })
    this.cache = {
      workspaceId: workspace.workspaceId,
      replacementEpoch: workspace.replacementEpoch,
      configuration,
      configurationTarget,
      promptPath,
      attemptAdmission,
      configurationOverride,
      context,
    }
    return context
  }

  captureFrame(
    attemptAdmission: AttemptTargetAdmissionFrame | null = null,
  ): GenerationCapabilityFrame {
    return this.captureContext(attemptAdmission).frame
  }

  capability(probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability {
    return this.captureFrame().capability(probe)
  }
}

function existingGenerationCapability(
  workspace: WorkspaceFence,
  attemptAdmission: AttemptTargetAdmissionFrame | null,
  probe: Exclude<GenerationAdmissionCapabilityProbe, { readonly kind: 'new-chat-send' }>,
): GenerationCapability {
  if (
    probe.kind === 'continue' &&
    attemptAdmission?.workspaceId === workspace.workspaceId &&
    attemptAdmission.replacementEpoch === workspace.replacementEpoch &&
    attemptAdmission.chatId === probe.chatId &&
    attemptAdmission.admission(probe.targetAssistantId) === 'occupied'
  ) {
    return pendingGenerationCapability('attempt-target')
  }
  return AVAILABLE_GENERATION_CAPABILITY
}

export function generationConfigurationRequirement(
  probe: GenerationCapabilityRequirementProbe,
): ActiveGenerationConfigurationRequirement {
  if (probe.kind === 'new-chat-send') return NEW_CHAT_GENERATION_CONFIGURATION_REQUIREMENT
  return Object.freeze({
    kind: 'chat' as const,
    chatId: probe.chatId,
    ...(probe.kind === 'regenerate' && probe.settingsPatch
      ? { settingsPatch: probe.settingsPatch }
      : {}),
  })
}

export function generationConfigurationCapability(
  resolution: ActiveGenerationConfigurationResolution,
): GenerationCapability {
  switch (resolution.capability) {
    case 'ready':
      return AVAILABLE_GENERATION_CAPABILITY
    case 'pending':
      return pendingGenerationCapability('configuration')
    case 'connection-missing':
      return unavailableGenerationCapability('connection-missing')
    case 'configuration-missing':
      return unavailableGenerationCapability('configuration-missing')
    case 'failed':
      return failedGenerationCapability('configuration')
  }
}

export function captureActiveTargetGenerationConfiguration(
  chatId: ChatId,
  settingsPatch?: ChatSettingsPatch,
): ActiveTargetGenerationConfigurationCaptureState {
  const snapshot = configurationController.getSnapshot().frame
  const target = snapshot.target
  if (target.kind !== 'chat' || target.chatId !== chatId) {
    return Object.freeze({ kind: 'pending-active-target' as const, chatId })
  }
  const resolution = snapshot.generation.resolve({
    kind: 'chat',
    chatId,
    ...(settingsPatch ? { settingsPatch } : {}),
  })
  if (resolution.capability !== 'pending') {
    return Object.freeze({ kind: 'resolved-active-target' as const, chatId, resolution })
  }
  return Object.freeze({
    kind: 'selected-active-target' as const,
    chatId,
    claim: configurationController.claimSelectedGenerationConfiguration(chatId, settingsPatch),
  })
}

export function resolveActiveTargetGenerationConfiguration(
  capture: ActiveTargetGenerationConfigurationCaptureState,
): ActiveGenerationConfigurationResolution | undefined {
  switch (capture.kind) {
    case 'resolved-active-target':
      return capture.resolution
    case 'selected-active-target':
      return configurationController.resolveSelectedGenerationConfiguration(capture.claim)
    case 'pending-active-target':
      return undefined
  }
}

export function releaseActiveTargetGenerationConfiguration(
  capture: ActiveTargetGenerationConfigurationCaptureState,
): void {
  if (capture.kind === 'selected-active-target') {
    configurationController.cancelSelectedGenerationConfiguration(capture.claim)
  }
}

export const generationCapabilityController: GenerationCapabilityController =
  new TabGenerationCapabilityController()

const PENDING_WORKSPACE_CAPABILITY_FRAME: GenerationCapabilityFrame = Object.freeze({
  capability: () => pendingGenerationCapability('workspace'),
})

const FAILED_WORKSPACE_CAPABILITY_FRAME: GenerationCapabilityFrame = Object.freeze({
  capability: () => failedGenerationCapability('workspace'),
})

const PENDING_WORKSPACE_CAPABILITY_CONTEXT: GenerationCapabilityContext = Object.freeze({
  workspace: null,
  configuration: null,
  configurationTarget: null,
  promptPath: null,
  attemptAdmission: null,
  frame: PENDING_WORKSPACE_CAPABILITY_FRAME,
})

const FAILED_WORKSPACE_CAPABILITY_CONTEXT: GenerationCapabilityContext = Object.freeze({
  workspace: null,
  configuration: null,
  configurationTarget: null,
  promptPath: null,
  attemptAdmission: null,
  frame: FAILED_WORKSPACE_CAPABILITY_FRAME,
})
