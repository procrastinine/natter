import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { normalizeEndpointsResponse } from '../api/providers'
import type { AssistantPlanningResources } from '../core/assistant-planning-resources'
import { modelsCacheKey } from '../core/cache-keys'
import type { CorsProxyConfig } from '../core/cors-proxy'
import { isStaticTextTemplateId, resolveStaticTextTemplate } from '../core/text-templates'
import type { CalibrationMode } from '../core/token-calibration'
import type {
  Attachment,
  AttachmentId,
  ConfigurationRequestRevision,
  DataPolicy,
  EndpointsDescriptor,
  GlobalTokenCalibration,
  ModelListEntry,
  ModelsQuery,
  TextTemplateConfig,
  TextTemplateId,
} from '../core/types'
import type { CachedEndpointsRow, CachedPrivacyPolicyRow } from './db-rows'
import {
  resolveEndpointsDiscovery,
  resolvePrivacyDiscovery,
  staleDiscoveryRow,
} from './discovery-service'
import { capturedEndpointsRowIsFresh, capturedPrivacyRowIsFresh } from './generation-admission'
import type {
  AttachmentBundle,
  AttachmentDispatchBundle,
  GenerationAttachmentReadProof,
  GenerationAttachmentTokenEvidence,
} from './repository'
import type { GenerationPlanningSnapshot, WorkspaceWriteAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'

export class GenerationPlanningReader implements AssistantPlanningResources {
  private readonly endpointReads = new Map<string, Promise<EndpointsDescriptor | null>>()
  private readonly privacyReads = new Map<
    string,
    Promise<{ policies: Readonly<Record<string, DataPolicy>>; offlineFallback: boolean }>
  >()
  private readonly attachmentReads = new Map<
    AttachmentId,
    Promise<AttachmentDispatchBundle | undefined>
  >()
  private readonly attachmentEvidenceReads = new Map<
    AttachmentId,
    Promise<GenerationAttachmentTokenEvidence | undefined>
  >()
  private readonly attachmentVersions = new Map<AttachmentId, number | null>()
  private readonly discoveryRevision: ConfigurationRequestRevision
  private readonly authority: WorkspaceWriteAuthority
  private readonly snapshot: GenerationPlanningSnapshot
  private readonly capturedApiKey: string

  constructor(
    authority: WorkspaceWriteAuthority,
    snapshot: GenerationPlanningSnapshot,
    capturedApiKey: string,
  ) {
    this.authority = authority
    this.snapshot = snapshot
    this.capturedApiKey = capturedApiKey
    this.discoveryRevision = snapshot.discovery.revision
  }

  globalCalibration(): GlobalTokenCalibration {
    return this.snapshot.calibration.global
  }

  calibrationMode(): CalibrationMode {
    return this.snapshot.calibration.mode
  }

  proxy(): CorsProxyConfig {
    return this.snapshot.proxy
  }

  readModels(query: ModelsQuery): Promise<readonly ModelListEntry[] | undefined> {
    const row = this.snapshot.discovery.models
    if (!row || row.queryKey !== modelsCacheKey(query)) return Promise.resolve(undefined)
    return Promise.resolve(row.rows)
  }

  async resolveEndpoints(
    modelId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<EndpointsDescriptor | null> {
    let pending = this.endpointReads.get(modelId)
    if (!pending) {
      pending = this.resolveEndpointsOnce(modelId, options)
      this.endpointReads.set(modelId, pending)
    }
    return pending
  }

  private async resolveEndpointsOnce(
    modelId: string,
    options: { signal?: AbortSignal },
  ): Promise<EndpointsDescriptor | null> {
    const captured = this.snapshot.discovery.endpoints
    if (capturedEndpointsRowIsFresh(captured)) {
      return normalizeEndpointsResponse(captured.payload)
    }
    try {
      const row = await resolveEndpointsDiscovery(this.snapshot.profile, modelId, {
        authority: this.authority,
        apiKey: this.capturedApiKey,
        expectedRevision: this.discoveryRevision,
        baseline: captured,
        timeoutMs: 15_000,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      return normalizeEndpointsResponse(row.payload)
    } catch (error) {
      const stale = staleDiscoveryRow<CachedEndpointsRow>(error)
      if (stale) return normalizeEndpointsResponse(stale.payload)
      throw error
    }
  }

  async resolvePrivacy(
    modelId: string,
    options: { refresh: boolean; signal?: AbortSignal },
  ): Promise<{
    policies: Readonly<Record<string, DataPolicy>>
    offlineFallback: boolean
  }> {
    const key = `${modelId}\u0000${options.refresh ? 'refresh' : 'cached'}`
    let pending = this.privacyReads.get(key)
    if (!pending) {
      pending = this.resolvePrivacyOnce(modelId, options)
      this.privacyReads.set(key, pending)
    }
    return pending
  }

  private async resolvePrivacyOnce(
    modelId: string,
    options: { refresh: boolean; signal?: AbortSignal },
  ): Promise<{
    policies: Readonly<Record<string, DataPolicy>>
    offlineFallback: boolean
  }> {
    const captured = this.snapshot.discovery.privacy
    if (!options.refresh) {
      return {
        policies: captured ? (readCachedPrivacyPayload(captured.payload)?.policies ?? {}) : {},
        offlineFallback: false,
      }
    }
    if (capturedPrivacyRowIsFresh(captured)) {
      return {
        policies: readCachedPrivacyPayload(captured.payload)?.policies ?? {},
        offlineFallback: false,
      }
    }
    try {
      const resolved = await resolvePrivacyDiscovery(this.snapshot.profile, modelId, {
        authority: this.authority,
        apiKey: this.capturedApiKey,
        expectedRevision: this.discoveryRevision,
        baseline: captured,
        proxy: this.snapshot.proxy,
        timeoutMs: 15_000,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      return {
        policies: readCachedPrivacyPayload(resolved.payload)?.policies ?? {},
        offlineFallback: false,
      }
    } catch (error) {
      const stale = staleDiscoveryRow<CachedPrivacyPolicyRow>(error)
      const parsed = stale ? readCachedPrivacyPayload(stale.payload) : null
      const policies = parsed?.policies ?? {}
      return { policies, offlineFallback: Object.keys(policies).length === 0 }
    }
  }

  async getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined> {
    let pending = this.attachmentEvidenceReads.get(attachmentId)
    if (!pending) {
      pending = getWorkspaceRepository()
        .query(this.authority, {
          kind: 'attachment.generation-token-evidence',
          attachmentId,
        })
        .then((envelope) => {
          this.recordAttachmentVersion(attachmentId, envelope.value?.wireVersion ?? null)
          return envelope.value
        })
      this.attachmentEvidenceReads.set(attachmentId, pending)
    }
    return (await pending)?.attachment
  }

  async getAttachmentBundle(attachmentId: AttachmentId): Promise<AttachmentBundle | undefined> {
    return (await this.getAttachmentDispatchBundle(attachmentId))?.bundle
  }

  resolveTextTemplate(
    id: TextTemplateId,
    customFallback?: TextTemplateConfig,
  ): Promise<TextTemplateConfig | null> {
    if (isStaticTextTemplateId(id)) {
      return Promise.resolve(resolveStaticTextTemplate(id, customFallback))
    }
    if (this.snapshot.savedTextTemplate?.templateId === id) {
      return Promise.resolve(
        this.snapshot.savedTextTemplate.config
          ? structuredClone(this.snapshot.savedTextTemplate.config)
          : null,
      )
    }
    return Promise.reject(new Error(`GenerationPlanningTemplateNotCaptured:${id}`))
  }

  attachmentProofs(): readonly GenerationAttachmentReadProof[] {
    return Object.freeze(
      [...this.attachmentVersions]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([attachmentId, wireVersion]) => Object.freeze({ attachmentId, wireVersion })),
    )
  }

  private getAttachmentDispatchBundle(
    attachmentId: AttachmentId,
  ): Promise<AttachmentDispatchBundle | undefined> {
    let pending = this.attachmentReads.get(attachmentId)
    if (pending) return pending
    pending = getWorkspaceRepository()
      .query(this.authority, {
        kind: 'attachment.dispatch-bundle',
        attachmentId,
      })
      .then((envelope) => {
        this.recordAttachmentVersion(attachmentId, envelope.value?.wireVersion ?? null)
        return envelope.value
      })
    this.attachmentReads.set(attachmentId, pending)
    return pending
  }

  private recordAttachmentVersion(attachmentId: AttachmentId, wireVersion: number | null): void {
    if (
      this.attachmentVersions.has(attachmentId) &&
      this.attachmentVersions.get(attachmentId) !== wireVersion
    ) {
      throw new Error(`GenerationAttachmentChangedDuringPlanning:${attachmentId}`)
    }
    this.attachmentVersions.set(attachmentId, wireVersion)
  }
}
