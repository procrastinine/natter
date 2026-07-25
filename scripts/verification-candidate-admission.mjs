import { currentWaveManifest } from './current-wave-manifest.mjs'

export function verificationCandidateAdmission(manifest = currentWaveManifest) {
  const sourceObligations = [...manifest.sourceObligations]
  const heartbeatObligations = [...(manifest.heartbeatObligations ?? [])]
  return Object.freeze({
    ready: manifest.mode === 'coherence/gate' && sourceObligations.length === 0,
    waveId: manifest.id,
    mode: manifest.mode,
    sourceObligations: Object.freeze(sourceObligations),
    heartbeatObligations: Object.freeze(heartbeatObligations),
  })
}

export function assertVerificationCandidateAdmissionReady(manifest = currentWaveManifest) {
  const admission = verificationCandidateAdmission(manifest)
  if (!admission.ready) {
    throw new Error(
      `VerificationCandidateBeforeSourceFreeze:${admission.mode}:${admission.sourceObligations.join(',')}`,
    )
  }
  return admission
}
