const role = (id, value) => Object.freeze({ id, role: value })
const excludeControl = (id, rationale) => Object.freeze({ id, rationale })
const family = (derivedId, rootId) => Object.freeze({ derivedId, rootId })
const composition = (id, rationale) => Object.freeze({ id, rationale })

export const UNION_INVENTORY_SCHEMA_VERSION = 2

export const PRODUCTION_DISCRIMINATED_UNION_SEMANTICS = Object.freeze({
  roleOverrides: Object.freeze([
    role(
      'src/store/semantic-operation-capability.ts#SemanticOperationExactPhysicalMutation|operation',
      'data',
    ),
    role('src/store/conversation-controller.ts#ConversationDestinationProjection|kind', 'state'),
    role('src/store/conversation-controller.ts#ConversationTranscriptProjection|kind', 'state'),
    role('src/store/conversation-controller.ts#ClaimedConversationDestination|kind', 'state'),
    role(
      'src/store/conversation-controller.ts#ClaimedSelectedConversationPromptPath|kind',
      'state',
    ),
    role('src/store/byte-owner-mutation.ts#ConfigurationOwnerLinkTransition|kind', 'command'),
    role('src/store/chat-row-transition.ts#ChatRowWriteTransition|kind', 'command'),
    role('src/store/chat-sidebar-projection.ts#ChatSidebarProjectionTransition|kind', 'command'),
    role('src/store/conversation-controller.ts#ConversationStructuralTransition|kind', 'data'),
    role('src/store/generation-engine.ts#PreparedNewChatGeneration|kind', 'result'),
    role('src/store/generation-admission-controller.ts#ResolvedSettlingAdmission|kind', 'result'),
    role('src/store/storage-retention-state.ts#StorageRetentionStateRowFor|phase', 'state'),
    role('src/store/workspace-protocol.ts#ConfigurationModelResolutionHead|kind', 'result'),
    role('src/core/types.ts#ReasoningDetail|type', 'data'),
    role('src/core/messages.ts#PasteImportSlot|kind', 'data'),
    role('src/store/repository.ts#StreamTargetCommit|attemptKind', 'data'),
  ]),
  controlExclusions: Object.freeze([
    excludeControl(
      'src/core/token-calibration.ts#SampleIngestOutcome|accepted',
      'A finite calibration accumulator result carries data but does not dispatch control.',
    ),
    excludeControl(
      'src/store/quota.ts#StorageProbeResult|status',
      'A browser quota observation is presentation data, not an application protocol.',
    ),
    excludeControl(
      'src/ui/chat/CitationLink.tsx#RenderableCitation|type',
      'A render-only citation narrowing cannot select application control flow.',
    ),
  ]),
  canonicalFamilies: Object.freeze([
    family(
      'src/store/conversation-controller.ts#ClaimedSelectedConversationPromptPath|kind',
      'src/store/conversation-controller.ts#ClaimedConversationDestination|kind',
    ),
    family(
      'src/store/chat-row-transition.ts#ChatRowWriteTransition|kind',
      'src/store/chat-row-transition.ts#ChatRowWriteTransitionInput|kind',
    ),
    family(
      'src/store/presentation-interaction-controller.ts#PresentationInteractionOutcomeShape|kind',
      'src/store/presentation-interaction-controller.ts#PresentationInteractionOutcome|kind',
    ),
  ]),
  constructionCompositionReviews: Object.freeze([
    composition(
      'src/store/repository.ts#StreamLeaseProgress|phase',
      'Private generic phase constituent is composed into StreamLeaseByAttempt and StreamLeaseRow; no standalone constructor is expected.',
    ),
  ]),
})
