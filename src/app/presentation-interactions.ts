import type { ChatId, MessageId, ProviderOutputMemberRef, ReasoningMemberRef } from '../core/types'
import type {
  PresentationInteractionCapability,
  PresentationInteractionFailure,
  PresentationInteractionPresenter,
  PresentationInteractionStart,
  TotalPresentationInteractionPromise,
  WorkspaceFence,
} from '../store/presentation-contracts'
import {
  definePresentationInteraction,
  PresentationInteractionController,
} from '../store/presentation-interaction-controller'
import {
  getWorkspaceTabSessionSnapshot,
  registerWorkspaceTabSessionParticipant,
} from '../store/workspace-tab-session'
import { useToastStore } from '../store/zustand/toastStore'

const presentationInteractionController = new PresentationInteractionController(
  {
    describe(capability, error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { message: `${capability.label} failed: ${message}`, tone: 'danger' }
    },
    present(failure) {
      useToastStore.getState().push({
        level: failure.tone,
        text: failure.message,
      })
    },
  },
  {
    currentFence: () => getWorkspaceTabSessionSnapshot().fence,
  },
)

registerWorkspaceTabSessionParticipant({
  resetWorkspace: () => {
    presentationInteractionController.reconcileWorkspace(getWorkspaceTabSessionSnapshot().fence)
  },
})

export { definePresentationInteraction }

export class ConversationActionUnavailableError extends Error {}

export const attachmentMutationInteraction = definePresentationInteraction<string>({
  id: 'attachment-reference.mutate',
  label: 'Attachment update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
  describeFailure: (error) => {
    const cause = error instanceof Error ? error : new Error('Unknown error')
    return cause instanceof ConversationActionUnavailableError
      ? presentationFailure(cause.message, 'info')
      : presentationFailure(`Attachment update failed: ${cause.message}`)
  },
})

export const generationSubmitInteraction = definePresentationInteraction<'composer'>({
  id: 'generation.submit',
  label: 'Send',
  concurrency: 'replace',
  lifetime: 'workspace-tab',
  workspaceStart: 'settle-current',
})

export const configurationWriteInteraction = definePresentationInteraction<string>({
  id: 'configuration.write',
  label: 'Configuration update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

export const workspaceConfigurationWriteInteraction = definePresentationInteraction<string>({
  id: 'workspace-configuration.write',
  label: 'Workspace setting update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

export type ConversationMutationIntent =
  | Readonly<{ kind: 'edit'; chatId: ChatId; messageId: MessageId }>
  | Readonly<{ kind: 'context'; chatId: ChatId; messageId: MessageId }>
  | Readonly<{
      kind: 'reasoning'
      chatId: ChatId
      messageId: MessageId
      member: ReasoningMemberRef
    }>
  | Readonly<{
      kind: 'provider-output'
      chatId: ChatId
      messageId: MessageId
      member: ProviderOutputMemberRef
    }>
  | Readonly<{ kind: 'generation-notice'; chatId: ChatId; messageId: MessageId }>
  | Readonly<{ kind: 'delete'; chatId: ChatId }>
  | Readonly<{ kind: 'fork'; chatId: ChatId; messageId: MessageId }>

export type ConversationMutationSettlement = TotalPresentationInteractionPromise<void>

export const conversationMutationInteraction = definePresentationInteraction<string>({
  id: 'conversation.mutate',
  label: 'Conversation update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
  describeFailure: (error) => {
    const cause = error instanceof Error ? error : new Error('Unknown error')
    return cause instanceof ConversationActionUnavailableError
      ? presentationFailure(cause.message, 'info')
      : presentationFailure(cause.message)
  },
})

export function configurationWriteTarget(chatId: string, target: string): string {
  return `chat:${chatId}:settings:${target}`
}

export function connectionConfigurationWriteTarget(profileId: string, target: string): string {
  return `profile:${profileId}:settings:${target}`
}

export function conversationMutationTarget(intent: ConversationMutationIntent): string {
  const message = `chat:${intent.chatId}:message:${'messageId' in intent ? intent.messageId : '*'}`
  switch (intent.kind) {
    case 'edit':
      return `${message}:content`
    case 'context':
      return `${message}:context`
    case 'reasoning':
      return `${message}:reasoning:${attemptOwnerKey(intent.member.owner)}:${intent.member.kind}:${intent.member.id}`
    case 'provider-output':
      return `${message}:provider-output:${attemptOwnerKey(intent.member.owner)}:${intent.member.itemIndex}`
    case 'generation-notice':
      return `${message}:generation-notice`
    case 'delete':
      return `chat:${intent.chatId}:structure`
    case 'fork':
      return `${message}:fork`
  }
}

function attemptOwnerKey(owner: ReasoningMemberRef['owner']): string {
  return owner.kind === 'generation' ? 'generation' : `continuation:${owner.streamId}`
}

export function createPresentationInteractionPresenter(
  workspaceFence: WorkspaceFence | null,
): PresentationInteractionPresenter {
  return presentationInteractionController.createPresenter(workspaceFence)
}

export function releasePresentationInteractionPresenter(
  presenter: PresentationInteractionPresenter,
): void {
  presentationInteractionController.releasePresenter(presenter)
}

export function attachmentMutationTarget(input: {
  readonly refId: string
  readonly messageId?: string
  readonly draftChatId?: string
}): string {
  return input.messageId
    ? `message:${input.messageId}:${input.refId}`
    : `draft:${input.draftChatId}:${input.refId}`
}

export function startPresentationInteraction<Target extends PropertyKey, Value>(
  input: PresentationInteractionStart<Target, Value>,
) {
  return presentationInteractionController.start(input)
}

export function subscribePresentationInteraction<Target extends PropertyKey>(
  capability: PresentationInteractionCapability<Target>,
  listener: () => void,
): () => void {
  return presentationInteractionController.subscribe(capability, listener)
}

export function presentationInteractionRevision<Target extends PropertyKey>(
  capability: PresentationInteractionCapability<Target>,
): number {
  return presentationInteractionController.getRevision(capability)
}

export function presentationInteractionPending<Target extends PropertyKey>(
  capability: PresentationInteractionCapability<Target>,
  target: Target,
): boolean {
  return presentationInteractionController.isPending(capability, target)
}

export function presentationFailure(
  message: string,
  tone: PresentationInteractionFailure['tone'] = 'danger',
): PresentationInteractionFailure {
  return Object.freeze({ message, tone })
}
