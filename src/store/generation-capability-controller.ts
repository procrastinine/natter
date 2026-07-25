import type { ChatSettingsPatch } from '../core/chat-metadata'
import {
  AVAILABLE_GENERATION_CAPABILITY,
  failedGenerationCapability,
  type GenerationCapability,
  type GenerationCapabilityTarget,
  pendingGenerationCapability,
  unavailableGenerationCapability,
} from '../core/interaction-capability'
import type { ChatId, MessageId } from '../core/types'
import { type AttemptTargetAdmissionFrame, attemptController } from './attempt-controller'
import {
  type ActiveGenerationConfigurationFrame,
  type ActiveGenerationConfigurationRequirement,
  type ActiveGenerationConfigurationResolution,
  configurationController,
  type SelectedGenerationConfigurationClaim,
} from './configuration-controller'
import {
  type ConversationPromptPathFrame,
  conversationController,
  type SelectedConversationDestinationClaim,
} from './conversation-controller'
import type { WorkspaceFence } from './repository'
import { getWorkspaceRuntimeFence, getWorkspaceRuntimeState } from './workspace-runtime'

export type GenerationAdmissionCapabilityProbe = GenerationCapabilityTarget

type GenerationCapabilityRequirementProbe = GenerationAdmissionCapabilityProbe & {
  readonly settingsPatch?: ChatSettingsPatch
}

export interface GenerationCapabilityFrame {
  capability(probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability
}

export interface GenerationCapabilityContext {
  readonly workspace: WorkspaceFence | null
  readonly configuration: ActiveGenerationConfigurationFrame | null
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
  claimSelectedSend(chatId: ChatId): SelectedSendAdmissionClaim
  cancelSelectedSend(claim: SelectedSendAdmissionClaim): void
}

const SELECTED_SEND_ADMISSION_CLAIM = Symbol('selected-send-admission-claim')

export interface SelectedSendAdmissionClaim {
  readonly [SELECTED_SEND_ADMISSION_CLAIM]: true
  readonly destination: SelectedConversationDestinationClaim
  readonly configuration: SelectedGenerationConfigurationClaim
}

const NEW_CHAT_GENERATION_CONFIGURATION_REQUIREMENT: ActiveGenerationConfigurationRequirement =
  Object.freeze({ kind: 'new-chat' })

class TabGenerationCapabilityController implements GenerationCapabilityController {
  private cache: {
    readonly workspaceId: string
    readonly replacementEpoch: number
    readonly configuration: ActiveGenerationConfigurationFrame
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
    const configuration = configurationController.getSnapshot().frame.generation
    if (
      configuration.workspaceId !== workspace.workspaceId ||
      configuration.replacementEpoch !== workspace.replacementEpoch
    ) {
      return Object.freeze({
        workspace,
        configuration: null,
        promptPath: null,
        attemptAdmission,
        frame: PENDING_CONFIGURATION_CAPABILITY_FRAME,
      })
    }
    const promptPath =
      promptPathOverride &&
      promptPathOverride.workspaceId === workspace.workspaceId &&
      promptPathOverride.replacementEpoch === workspace.replacementEpoch
        ? promptPathOverride
        : conversationController.capturePromptPathFrame(workspace)
    const cached = this.cache
    if (
      cached?.workspaceId === workspace.workspaceId &&
      cached.replacementEpoch === workspace.replacementEpoch &&
      cached.configuration === configuration &&
      cached.promptPath === promptPath &&
      cached.attemptAdmission === attemptAdmission &&
      cached.configurationOverride === configurationOverride
    ) {
      return cached.context
    }
    const frame = Object.freeze({
      capability: (probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability => {
        if (!probe) return pendingGenerationCapability('prompt-path')
        const configurationCapability = generationConfigurationCapability(
          configurationOverride ?? configuration.resolve(generationConfigurationRequirement(probe)),
        )
        if (configurationCapability.state !== 'ready') return configurationCapability
        if (probe.kind === 'new-chat-send') return AVAILABLE_GENERATION_CAPABILITY
        const promptPathCapability = promptPath.capability(probe)
        switch (promptPathCapability) {
          case 'available':
            return generationAttemptTargetCapability(probe, workspace, attemptAdmission)
          case 'unavailable':
            return unavailableGenerationCapability('target-unavailable')
          case 'error':
            return failedGenerationCapability('prompt-path')
          case 'pending':
            return pendingGenerationCapability('prompt-path')
        }
      },
    }) satisfies GenerationCapabilityFrame
    const context = Object.freeze({
      workspace,
      configuration,
      promptPath,
      attemptAdmission,
      frame,
    })
    this.cache = {
      workspaceId: workspace.workspaceId,
      replacementEpoch: workspace.replacementEpoch,
      configuration,
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
    return this.captureFrame(attemptAdmissionFrameForProbe(probe)).capability(probe)
  }

  claimSelectedSend(chatId: ChatId): SelectedSendAdmissionClaim {
    const destination = conversationController.claimSelectedDestination({ chatId })
    try {
      const configuration = configurationController.claimSelectedGenerationConfiguration(chatId)
      return Object.freeze({
        [SELECTED_SEND_ADMISSION_CLAIM]: true as const,
        destination,
        configuration,
      })
    } catch (error) {
      conversationController.cancelSelectedDestination(destination)
      throw error
    }
  }

  cancelSelectedSend(claim: SelectedSendAdmissionClaim): void {
    conversationController.cancelSelectedDestination(claim.destination)
    configurationController.cancelSelectedGenerationConfiguration(claim.configuration)
  }
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

export function generationAttemptTargetCapability(
  probe: GenerationAdmissionCapabilityProbe,
  workspace: WorkspaceFence,
  frame: AttemptTargetAdmissionFrame | null,
): GenerationCapability {
  const target = generationAttemptTarget(probe)
  if (!target) return AVAILABLE_GENERATION_CAPABILITY
  if (
    !frame ||
    frame.workspaceId !== workspace.workspaceId ||
    frame.replacementEpoch !== workspace.replacementEpoch ||
    frame.chatId !== target.chatId ||
    frame.admission(target.messageId) !== 'available'
  ) {
    return pendingGenerationCapability('attempt-target')
  }
  return AVAILABLE_GENERATION_CAPABILITY
}

export function attemptAdmissionFrameForProbe(
  probe: GenerationAdmissionCapabilityProbe | null,
): AttemptTargetAdmissionFrame | null {
  if (!probe || probe.kind === 'new-chat-send') return null
  return attemptController.getTargetAdmissionFrame(probe.chatId)
}

function generationAttemptTarget(
  probe: GenerationAdmissionCapabilityProbe,
): { readonly chatId: ChatId; readonly messageId: MessageId } | null {
  switch (probe.kind) {
    case 'continue':
    case 'regenerate':
      return { chatId: probe.chatId, messageId: probe.targetAssistantId }
    case 'send':
      return probe.expectedLeafId === null
        ? null
        : { chatId: probe.chatId, messageId: probe.expectedLeafId }
    case 'new-chat-send':
    case 'reply':
    case 'edit-resend':
      return null
  }
}

export const generationCapabilityController: GenerationCapabilityController =
  new TabGenerationCapabilityController()

const PENDING_WORKSPACE_CAPABILITY_FRAME: GenerationCapabilityFrame = Object.freeze({
  capability: () => pendingGenerationCapability('workspace'),
})

const PENDING_CONFIGURATION_CAPABILITY_FRAME: GenerationCapabilityFrame = Object.freeze({
  capability: () => pendingGenerationCapability('configuration'),
})

const FAILED_WORKSPACE_CAPABILITY_FRAME: GenerationCapabilityFrame = Object.freeze({
  capability: () => failedGenerationCapability('workspace'),
})

const PENDING_WORKSPACE_CAPABILITY_CONTEXT: GenerationCapabilityContext = Object.freeze({
  workspace: null,
  configuration: null,
  promptPath: null,
  attemptAdmission: null,
  frame: PENDING_WORKSPACE_CAPABILITY_FRAME,
})

const FAILED_WORKSPACE_CAPABILITY_CONTEXT: GenerationCapabilityContext = Object.freeze({
  workspace: null,
  configuration: null,
  promptPath: null,
  attemptAdmission: null,
  frame: FAILED_WORKSPACE_CAPABILITY_FRAME,
})
