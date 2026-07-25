import type { AssistantRouteContract } from '../core/api-choice'
import type { EffectiveCapability } from '../core/capabilities'
import { TOKEN_CALIBRATION_MODE_KEY } from '../core/global-settings'
import type { CalibrationMode } from '../core/token-calibration'
import { GLOBAL_TOKEN_CALIBRATION_KEY } from '../core/token-calibration'
import type { AttachmentId, Chat, GlobalTokenCalibration, MessageId } from '../core/types'
import type { MessageHeaderRow } from './message-storage'
import type { WorkspaceFence } from './repository'
import {
  loadPromptEstimateContextForBranch,
  type PromptEstimateContextSnapshot,
} from './send-context'
import {
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from './workspace-effect-hub'
import type { WorkspaceDependency } from './workspace-protocol'

export interface PromptEstimateContextTarget {
  readonly key: string
  readonly chat: Chat
  readonly branchHeaders: readonly MessageHeaderRow[]
  readonly excludedMessageIds: readonly MessageId[]
  readonly attachmentIds: readonly AttachmentId[]
  readonly capabilities: EffectiveCapability
  readonly routing: AssistantRouteContract
  readonly calibrationEvidence: {
    readonly global: GlobalTokenCalibration
    readonly mode: CalibrationMode
  }
}

type PromptEstimateContextStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export interface PromptEstimateContextControllerSnapshot extends WorkspaceFence {
  readonly revision: number
  readonly status: PromptEstimateContextStatus
  readonly targetKey: string
  readonly chatId: string
  readonly value: PromptEstimateContextSnapshot | null
  readonly error: unknown
}

export interface PromptEstimateContextController {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => PromptEstimateContextControllerSnapshot | null
  request(fence: WorkspaceFence, target: PromptEstimateContextTarget): () => void
  dispose(): void
}

interface ActivePromptEstimateRead {
  readonly controller: AbortController
  readonly fence: WorkspaceFence
  readonly target: PromptEstimateContextTarget
}

interface PromptEstimateTargetIndex {
  readonly chatId: string
  readonly messageIds: ReadonlySet<MessageId>
  readonly attachmentIds: ReadonlySet<AttachmentId>
}

export function createPromptEstimateContextController(): PromptEstimateContextController {
  return new MountedPromptEstimateContextController()
}

class MountedPromptEstimateContextController implements PromptEstimateContextController {
  private readonly listeners = new Set<() => void>()
  private snapshot: PromptEstimateContextControllerSnapshot | null = null
  private fence: WorkspaceFence | null = null
  private target: PromptEstimateContextTarget | null = null
  private targetIndex: PromptEstimateTargetIndex | null = null
  private value: PromptEstimateContextSnapshot | null = null
  private valueTargetKey: string | null = null
  private read: ActivePromptEstimateRead | null = null
  private stopEffects: (() => void) | null = null
  private demandCount = 0
  private revision = 0
  private disposed = false

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): PromptEstimateContextControllerSnapshot | null => this.snapshot

  request(fence: WorkspaceFence, target: PromptEstimateContextTarget): () => void {
    if (this.disposed) throw new Error('PromptEstimateContextControllerDisposed')
    const wasDemanded = this.demandCount > 0
    this.demandCount += 1
    const changedTarget = !sameFence(this.fence, fence) || this.target?.key !== target.key
    if (changedTarget) {
      this.cancelRead()
      this.fence = Object.freeze({ ...fence })
      this.target = target
      this.targetIndex = indexTarget(target)
      if (this.valueTargetKey !== target.key) {
        this.value = null
        this.valueTargetKey = null
      }
    }
    this.attachEffects()
    if (changedTarget || !wasDemanded) this.scheduleReload()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.demandCount -= 1
      if (this.demandCount > 0) return
      this.cancelRead()
      this.stopEffects?.()
      this.stopEffects = null
      this.fence = null
      this.target = null
      this.targetIndex = null
      this.value = null
      this.valueTargetKey = null
      this.snapshot = null
      for (const listener of [...this.listeners]) listener()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.demandCount = 0
    this.cancelRead()
    this.stopEffects?.()
    this.stopEffects = null
    this.listeners.clear()
    this.fence = null
    this.target = null
    this.targetIndex = null
    this.value = null
    this.valueTargetKey = null
    this.snapshot = null
  }

  private attachEffects(): void {
    if (this.stopEffects) return
    this.stopEffects = subscribeWorkspaceEffects({
      owner: 'prompt-estimate-context-controller',
      impactKinds: ['workspace', 'chat', 'message-header', 'message-body', 'attachment', 'setting'],
      replacements: true,
      apply: (effect) => {
        if (this.effectMatters(effect)) this.scheduleReload()
      },
      recover: (_error, effect) => {
        if (this.matchesEffect(effect)) this.scheduleReload()
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
  }

  private effectMatters(effect: WorkspaceEffect): boolean {
    if (!this.matchesEffect(effect) || !this.targetIndex) return false
    if (effect.kind === 'replace' || effect.impact === 'all') return true
    return effect.impact.some((dependency) =>
      promptEstimateDependencyMatters(dependency, this.targetIndex as PromptEstimateTargetIndex),
    )
  }

  private matchesEffect(effect: WorkspaceEffect): boolean {
    return (
      this.fence?.workspaceId === effect.workspaceId &&
      this.fence.replacementEpoch === effect.replacementEpoch
    )
  }

  private scheduleReload(): void {
    if (this.demandCount === 0 || !this.target || !this.fence) return
    this.cancelRead()
    this.publish(this.value ? 'refreshing' : 'loading', null)
    const controller = new AbortController()
    const read: ActivePromptEstimateRead = {
      controller,
      fence: this.fence,
      target: this.target,
    }
    this.read = read
    void loadPromptEstimateContextForBranch({
      chat: read.target.chat,
      branchHeaders: read.target.branchHeaders,
      excludedMessageIds: read.target.excludedMessageIds,
      capabilities: read.target.capabilities,
      routing: read.target.routing,
      calibrationEvidence: read.target.calibrationEvidence,
      signal: controller.signal,
    }).then(
      (value) => {
        if (
          this.read !== read ||
          controller.signal.aborted ||
          !sameFence(this.fence, read.fence) ||
          this.target?.key !== read.target.key
        ) {
          return
        }
        this.read = null
        this.value = value
        this.valueTargetKey = read.target.key
        this.publish('ready', null)
      },
      (error: unknown) => {
        if (this.read !== read || controller.signal.aborted) return
        this.read = null
        this.publish('error', error)
      },
    )
  }

  private cancelRead(): void {
    this.read?.controller.abort()
    this.read = null
  }

  private publish(status: PromptEstimateContextStatus, error: unknown): void {
    const fence = this.fence
    const target = this.target
    if (!fence || !target) return
    this.snapshot = Object.freeze({
      ...fence,
      revision: ++this.revision,
      status,
      targetKey: target.key,
      chatId: target.chat.id,
      value: this.value,
      error,
    })
    for (const listener of [...this.listeners]) listener()
  }
}

function indexTarget(target: PromptEstimateContextTarget): PromptEstimateTargetIndex {
  const excluded = new Set(target.excludedMessageIds)
  return Object.freeze({
    chatId: target.chat.id,
    messageIds: new Set(
      target.branchHeaders.flatMap((header) => (excluded.has(header.id) ? [] : [header.id])),
    ),
    attachmentIds: new Set(target.attachmentIds),
  })
}

function promptEstimateDependencyMatters(
  dependency: WorkspaceDependency,
  target: PromptEstimateTargetIndex,
): boolean {
  if (dependency.kind === 'workspace') return true
  if (dependency.kind === 'chat') {
    return !dependency.chatIds || dependency.chatIds.includes(target.chatId)
  }
  if (dependency.kind === 'message-header' || dependency.kind === 'message-body') {
    if (dependency.chatId && dependency.chatId !== target.chatId) return false
    return !dependency.messageIds || dependency.messageIds.some((id) => target.messageIds.has(id))
  }
  if (dependency.kind === 'attachment') {
    return (
      !dependency.attachmentIds ||
      dependency.attachmentIds.some((id) => target.attachmentIds.has(id))
    )
  }
  if (dependency.kind === 'setting') {
    return (
      !dependency.keys ||
      dependency.keys.includes(GLOBAL_TOKEN_CALIBRATION_KEY) ||
      dependency.keys.includes(TOKEN_CALIBRATION_MODE_KEY)
    )
  }
  return false
}

function sameFence(left: WorkspaceFence | null, right: WorkspaceFence): boolean {
  return left?.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}
