import type { CorsProxyConfig } from './cors-proxy'
import type { CalibrationMode } from './token-calibration'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  DataPolicy,
  EndpointsDescriptor,
  GlobalTokenCalibration,
  ModelListEntry,
  ModelsQuery,
  TextTemplateConfig,
  TextTemplateId,
} from './types'

export interface AssistantPlanningAttachmentBundle {
  readonly attachment: Attachment
  readonly blobs: readonly AttachmentBlob[]
  readonly artifacts: readonly AttachmentArtifact[]
  readonly jobs: readonly AttachmentJob[]
}

export interface AssistantPlanningResources {
  globalCalibration(): GlobalTokenCalibration
  calibrationMode(): CalibrationMode
  proxy(): CorsProxyConfig
  readModels(query: ModelsQuery): Promise<readonly ModelListEntry[] | undefined>
  resolveEndpoints(
    modelId: string,
    options?: { refresh?: boolean; signal?: AbortSignal },
  ): Promise<EndpointsDescriptor | null>
  resolvePrivacy(
    modelId: string,
    options: { refresh: boolean; signal?: AbortSignal },
  ): Promise<{ policies: Readonly<Record<string, DataPolicy>>; offlineFallback: boolean }>
  getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined>
  getAttachmentBundle(
    attachmentId: AttachmentId,
  ): Promise<AssistantPlanningAttachmentBundle | undefined>
  resolveTextTemplate(
    id: TextTemplateId,
    customFallback?: TextTemplateConfig,
  ): Promise<TextTemplateConfig | null>
}
