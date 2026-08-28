import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import {
  browserConversationNavigationPort,
  chatHref,
  navigate,
  newChatHref,
  parseRoute,
} from '../../src/app/router'
import type { ChatSettings, ConnectionProfile, KeyId, MessageId } from '../../src/core/types'
import {
  type AttemptStopRequest,
  requestAttemptStop,
} from '../../src/store/attempt-control-application'
import { attemptController, attemptStopCapability } from '../../src/store/attempt-controller'
import { configurationController } from '../../src/store/configuration-controller'
import { conversationController } from '../../src/store/conversation-controller'
import { createConversationRouteOwnerController } from '../../src/store/conversation-route-owner'
import { generationAdmissionController } from '../../src/store/generation-admission-controller'
import {
  captureActiveTargetGenerationConfiguration,
  type GenerationAdmissionCapabilityProbe,
  generationConfigurationRequirement,
} from '../../src/store/generation-capability-controller'
import {
  type CompletedGeneration,
  createGenerationEngine,
  type GenerationEngine,
  type GenerationHandle,
  type GenerationIntent,
  type GenerationStartRequest,
  type GenerationStartResult,
  type GenerationTransportInput,
  type PreparedGenerationForIntent,
} from '../../src/store/generation-engine'
import { createKey, getKey } from '../../src/store/keys'
import { createConfigurationProfile, getConfigurationProfile } from './configuration'

export interface ControlledGenerationOptions {
  readonly profile: ConnectionProfile
  readonly newChatSettings?: ChatSettings
  readonly keyMaterial?: Readonly<Record<KeyId, string>>
  readonly openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
  readonly now?: () => number
  readonly configurationAuthority?: 'active-target' | 'transaction-current'
}

export function requireStartedGeneration<Intent extends GenerationIntent>(
  result: GenerationStartResult<Intent>,
): GenerationHandle<PreparedGenerationForIntent<Intent>> {
  if (result.kind === 'started') return result.handle
  const capability = result.capability
  const detail = capability.state === 'unavailable' ? capability.reason : capability.owner
  throw new Error(`GenerationTestNotStarted:${capability.state}:${detail}`)
}

export async function startControlledGeneration<Intent extends GenerationIntent>(
  intent: Intent,
  options: ControlledGenerationOptions,
): Promise<GenerationHandle<PreparedGenerationForIntent<Intent>>> {
  await installGenerationProfile(options.profile, options.keyMaterial)
  const releaseSurface = await prepareControlledGenerationSurface(intent, options)
  const engine = createGenerationEngine({
    openStream: options.openStream,
    ...(options.now ? { now: options.now } : {}),
  })
  try {
    return requireStartedGeneration(
      startGenerationForIntent(engine, intent, options.configurationAuthority),
    )
  } finally {
    releaseSurface()
  }
}

export function startGenerationForIntent<Intent extends GenerationIntent>(
  engine: GenerationEngine,
  intent: Intent,
  configurationAuthority: 'active-target' | 'transaction-current' = 'transaction-current',
): GenerationStartResult<Intent> {
  if (intent.kind === 'new-chat-send') {
    const request = {
      intent,
      routeOwner: createConversationRouteOwnerController().owner,
    } satisfies GenerationStartRequest
    return engine.start(request)
  }
  const request = {
    intent,
    configurationAuthority:
      configurationAuthority === 'active-target'
        ? captureActiveTargetGenerationConfiguration(
            intent.chatId,
            intent.kind === 'regenerate' ? intent.settingsPatch : undefined,
          )
        : configurationAuthority,
  } satisfies GenerationStartRequest
  return engine.start(request) as GenerationStartResult<Intent>
}

export async function prepareControlledGenerationSurface(
  intent: GenerationIntent,
  options: Pick<
    ControlledGenerationOptions,
    'profile' | 'newChatSettings' | 'configurationAuthority'
  >,
): Promise<() => void> {
  conversationController.setNavigationPort(browserConversationNavigationPort)
  if (intent.kind === 'new-chat-send') {
    const settings = options.newChatSettings
    if (!settings) throw new Error('ControlledGenerationNewChatSettingsMissing')
    if (parseRoute(window.location.hash).kind !== 'new') navigate(newChatHref())
    configurationController.rememberSeed({
      profileId: options.profile.id,
      presetId: null,
      settings,
    })
    await waitForControlledGenerationAvailability({ kind: 'new-chat-send' })
    return () => undefined
  }

  const current = conversationController.getSnapshot()
  if (current.activeChatId !== intent.chatId) {
    navigate(chatHref(intent.chatId, initialSurfaceTargetId(intent)))
  }
  return waitForControlledGenerationAvailability(
    intent,
    options.configurationAuthority === 'active-target',
  )
}

function initialSurfaceTargetId(
  intent: Exclude<GenerationIntent, { readonly kind: 'new-chat-send' }>,
): MessageId | undefined {
  switch (intent.kind) {
    case 'send':
      if (intent.target.kind === 'fixed') return intent.target.messageId ?? undefined
      switch (intent.target.selection.kind) {
        case 'default':
          return undefined
        case 'tip':
          return intent.target.selection.messageId
        case 'message':
          return intent.target.selection.observedTipId ?? intent.target.selection.messageId
        case 'sibling-position':
          return intent.target.selection.observedTipId
      }
      return undefined
    case 'reply':
      return intent.parentUserId
    case 'regenerate':
      return intent.targetAssistantId
    case 'edit-resend':
      return intent.targetUserId
    case 'continue':
      return intent.targetAssistantId
  }
}

function waitForControlledGenerationAvailability(
  probe: GenerationAdmissionCapabilityProbe,
  requireActiveConfigurationTarget = false,
): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    let settled = false
    let unsubscribeConfiguration: () => void = () => undefined
    let unsubscribeConversation: () => void = () => undefined
    let releaseAttemptDemand: () => void = () => undefined
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      unsubscribeConfiguration()
      unsubscribeConversation()
      if (error === undefined) resolve(releaseAttemptDemand)
      else {
        releaseAttemptDemand()
        reject(error)
      }
    }
    const inspect = () => {
      const capability = generationAdmissionController.capability(probe)
      if (capability.state === 'ready') {
        if (requireActiveConfigurationTarget && probe.kind !== 'new-chat-send') {
          const configuration = configurationController.getSnapshot().frame
          const target = configuration.target
          if (target.kind !== 'chat' || target.chatId !== probe.chatId) return
          const resolution = configuration.generation.resolve(
            generationConfigurationRequirement(probe),
          )
          if (resolution.capability === 'pending') return
          if (resolution.capability !== 'ready') {
            finish(
              new Error(`ControlledGenerationConfigurationUnavailable:${resolution.capability}`),
            )
            return
          }
        }
        finish()
        return
      }
      if (capability.state === 'unavailable') {
        finish(new Error(`ControlledGenerationSurfaceUnavailable:${capability.reason}`))
        return
      }
      if (capability.state === 'failed') {
        finish(new Error(`ControlledGenerationSurfaceFailed:${capability.owner}`))
        return
      }
      const configuration = configurationController.getSnapshot().frame
      if (configuration.selection.status === 'error') {
        finish(
          new Error(`ControlledGenerationConfigurationFailed:${configuration.selection.error}`),
        )
        return
      }
      if (probe.kind === 'send') {
        const conversation = conversationController.getSnapshot()
        if (conversation.activeChatId !== probe.chatId || !conversation.active) return
        const destination = conversation.active.destination
        if (destination.kind === 'failed') {
          finish(new Error(`ControlledGenerationConversationFailed:${destination.failure.message}`))
        } else if (destination.kind === 'missing') {
          finish(new Error(`ControlledGenerationConversationMissing:${probe.chatId}`))
        }
      }
    }
    unsubscribeConfiguration = configurationController.subscribe(inspect)
    unsubscribeConversation = conversationController.subscribe(inspect)
    if (probe.kind !== 'new-chat-send') {
      releaseAttemptDemand = attemptController.subscribeChat(probe.chatId, inspect)
    }
    inspect()
  })
}

export async function requestGenerationStop(
  handle: GenerationHandle,
  requestedAt = Date.now(),
): Promise<AttemptStopRequest> {
  await handle.prepared
  const capability = attemptStopCapability(attemptController.getExecution(handle.streamId))
  if (capability?.kind !== 'requestable') {
    throw new Error(
      `GenerationTestStopUnavailable:${handle.streamId}:${capability?.kind ?? 'missing'}`,
    )
  }
  const request = requestAttemptStop(capability, requestedAt)
  if (!request.claimed) throw new Error(`GenerationTestStopClaimRejected:${handle.streamId}`)
  return request
}

export async function runControlledGeneration(
  intent: GenerationIntent,
  options: ControlledGenerationOptions,
): Promise<CompletedGeneration> {
  const handle = await startControlledGeneration(intent, options)
  void handle.prepared.catch(() => {})
  return handle.completed
}

export async function installGenerationProfile(
  profile: ConnectionProfile,
  keyMaterial: Readonly<Record<KeyId, string>> = {},
): Promise<void> {
  for (const keyId of [profile.apiKeyRef, ...(profile.apiKeyFallbackRefs ?? [])]) {
    if (!keyId || (await getKey(keyId))) continue
    const plaintextKey = keyMaterial[keyId]
    if (plaintextKey === undefined) {
      throw new Error(`GenerationTestKeyMaterialMissing:${keyId}`)
    }
    await createKey({ id: keyId, name: keyId, plaintextKey, now: profile.createdAt })
  }
  if (await getConfigurationProfile(profile.id)) return
  await createConfigurationProfile({
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    baseUrl: profile.baseUrl,
    ...(profile.apiKeyRef ? { apiKeyRef: profile.apiKeyRef } : {}),
    ...(profile.apiKeyFallbackRefs ? { apiKeyFallbackRefs: [...profile.apiKeyFallbackRefs] } : {}),
    ...(profile.managementApiKeyRef ? { managementApiKeyRef: profile.managementApiKeyRef } : {}),
    defaultHeaders: { ...profile.defaultHeaders },
    ...(profile.appTitle ? { appTitle: profile.appTitle } : {}),
    ...(profile.appUrl ? { appUrl: profile.appUrl } : {}),
    ...(profile.appCategories ? { appCategories: [...profile.appCategories] } : {}),
    supportsEndpointsApi: profile.supportsEndpointsApi,
    supportsGenerationApi: profile.supportsGenerationApi,
    supportsPrivacyScrape: profile.supportsPrivacyScrape,
    ...(profile.capabilityOverrides
      ? { capabilityOverrides: structuredClone(profile.capabilityOverrides) }
      : {}),
    ...(profile.debugRequests === undefined ? {} : { debugRequests: profile.debugRequests }),
    now: profile.createdAt,
  })
}
