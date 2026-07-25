import type { VerificationCandidateAdmissionManifest } from './verification-candidate-admission.mjs'
import type { MaterializedVerificationCandidate } from './verification-candidate-workspace.mjs'
import type { VerificationDependencyImage } from './verification-dependency-image.mjs'

export function prepareVerificationCandidate(options?: {
  readonly root?: string
  readonly storeRoot?: string
  readonly manifest?: VerificationCandidateAdmissionManifest
}): Promise<{
  readonly candidate: MaterializedVerificationCandidate
  readonly dependencyImage: VerificationDependencyImage
}>
