import {
  type ConfigurationProjectionSource,
  configurationController,
} from './configuration-controller'
import { conversationController } from './conversation-controller'
import { observeKeyMaterialWorkspaceEffect, resetKeyMaterialWorkspaceCache } from './keys'
import type { WorkspaceFence } from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type { WorkspaceRepository } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

let adapter: ConfigurationRepositoryAdapter | null = null

class ConfigurationRepositoryAdapter {
  private readonly repository: WorkspaceRepository
  private readonly projectionSource: ConfigurationProjectionSource
  private unsubscribeConversation: (() => void) | null = null
  private unsubscribeConfiguration: (() => void) | null = null
  private unsubscribeEffects: (() => void) | null = null

  constructor(repository: WorkspaceRepository) {
    this.repository = repository
    this.projectionSource = {
      loadShell: (signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository
              .query(permit, { kind: 'configuration.shell' }, { signal: permit.signal })
              .then((envelope) => envelope.value),
          { signal },
        ),
      loadGlobalTokenCalibration: (signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository
              .query(
                permit,
                { kind: 'configuration.global-token-calibration' },
                { signal: permit.signal },
              )
              .then((envelope) => envelope.value),
          { signal },
        ),
      loadTextTemplateCatalog: (signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository
              .query(
                permit,
                { kind: 'configuration.text-template-catalog' },
                { signal: permit.signal },
              )
              .then((envelope) => envelope.value),
          { signal },
        ),
      loadActiveSelection: (target, signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository
              .query(
                permit,
                { kind: 'configuration.active-selection', target },
                { signal: permit.signal },
              )
              .then((envelope) => envelope.value),
          { signal },
        ),
      loadActiveModel: (target, knownPayloads, includeModels, signal) =>
        runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository
              .query(
                permit,
                {
                  kind: 'configuration.active-model',
                  profileId: target.profileId,
                  modelId: target.modelId,
                  revision: target.requestRevision,
                  includeModels,
                  knownPayloads,
                },
                { signal: permit.signal },
              )
              .then((envelope) => envelope.value),
          { signal },
        ),
    }
  }

  attach(fence: WorkspaceFence): void {
    if (this.unsubscribeConversation || this.unsubscribeConfiguration || this.unsubscribeEffects) {
      return
    }
    resetKeyMaterialWorkspaceCache()
    this.unsubscribeConversation = conversationController.subscribe(() => {
      configurationController.observeConversation(conversationController.getSnapshot())
    })
    this.unsubscribeConfiguration = configurationController.subscribe(() => {
      this.publishTranscriptWorkScale()
    })
    this.unsubscribeEffects = subscribeWorkspaceEffects({
      owner: 'configuration-repository-adapter',
      impactKinds: [
        'workspace',
        'profile',
        'preset',
        'prompt-preset',
        'text-template',
        'key',
        'setting',
        'discovery-cache',
      ],
      replacements: false,
      apply: (effect) => this.receiveEffect(effect),
      recover: (_error, effect) => {
        this.recoverEffect(effect)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
    configurationController.reconcileWorkspace(fence)
    configurationController.observeConversation(conversationController.getSnapshot())
    void configurationController.setProjectionSource(this.projectionSource).catch(() => undefined)
    this.publishTranscriptWorkScale()
  }

  dispose(): void {
    this.unsubscribeConversation?.()
    this.unsubscribeConversation = null
    this.unsubscribeConfiguration?.()
    this.unsubscribeConfiguration = null
    this.unsubscribeEffects?.()
    this.unsubscribeEffects = null
    resetKeyMaterialWorkspaceCache()
    void configurationController.setProjectionSource(null)
  }

  private publishTranscriptWorkScale(): void {
    const preferences = configurationController.getSnapshot().frame.shell?.preferences
    if (!preferences) return
    conversationController.setSettledTranscriptWorkScale(
      preferences.global.messageInitialRenderWork,
    )
  }

  private receiveEffect(effect: WorkspaceEffect): void {
    observeKeyMaterialWorkspaceEffect(effect)
    if (effect.kind === 'replace') return
    configurationController.observeWorkspaceEffect(effect)
  }

  private recoverEffect(effect: WorkspaceEffect): void {
    resetKeyMaterialWorkspaceCache()
    configurationController.recoverWorkspaceEffect(effect)
  }
}

export function attachConfigurationWorkspace(fence: WorkspaceFence): void {
  if (adapter) return
  const current = new ConfigurationRepositoryAdapter(getWorkspaceRepository())
  adapter = current
  try {
    current.attach(fence)
  } catch (error) {
    if (adapter === current) adapter = null
    current.dispose()
    throw error
  }
}

export function disposeConfigurationWorkspace(): void {
  const current = adapter
  adapter = null
  current?.dispose()
}

export function assertConfigurationWorkspaceClosed(): void {
  if (adapter) throw new Error('ConfigurationWorkspaceNotClosed')
}
