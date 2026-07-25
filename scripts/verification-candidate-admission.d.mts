export interface VerificationCandidateAdmissionManifest {
  readonly id: string
  readonly mode: string
  readonly sourceObligations: readonly string[]
  readonly heartbeatObligations?: readonly string[]
  readonly costObligations: readonly string[]
}

export function verificationCandidateAdmission(
  manifest?: VerificationCandidateAdmissionManifest,
): {
  readonly ready: boolean
  readonly waveId: string
  readonly mode: string
  readonly sourceObligations: readonly string[]
  readonly heartbeatObligations: readonly string[]
}

export function assertVerificationCandidateAdmissionReady(
  manifest?: VerificationCandidateAdmissionManifest,
): ReturnType<typeof verificationCandidateAdmission>
