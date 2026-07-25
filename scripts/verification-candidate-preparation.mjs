import { resolve } from 'node:path'
import { assertVerificationCandidateAdmissionReady } from './verification-candidate-admission.mjs'
import { materializeVerificationCandidate } from './verification-candidate-workspace.mjs'
import { prepareVerificationDependencyImage } from './verification-dependency-image.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export async function prepareVerificationCandidate(options = {}) {
  const root = resolve(options.root ?? ROOT)
  assertVerificationCandidateAdmissionReady(options.manifest)
  const dependencyImage = await prepareVerificationDependencyImage({
    sourceRoot: root,
    evidenceRoot: root,
    storeRoot: options.storeRoot,
  })
  const candidate = await materializeVerificationCandidate({
    sourceRoot: root,
    evidenceRoot: root,
    dependencyImage,
    manifest: options.manifest,
  })
  return Object.freeze({ candidate, dependencyImage })
}
