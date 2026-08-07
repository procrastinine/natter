import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

export const VERIFICATION_PERFORMANCE_EVIDENCE_SCHEMA_VERSION = 1
export const VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS = Object.freeze([
  'production-build',
  'vitest',
  'chromium-e2e',
  'firefox-e2e',
  'stream-profile-single',
  'stream-profile-concurrent',
])

const PROFILE_STAGE_IDS = new Set(['stream-profile-single', 'stream-profile-concurrent'])
const STAGE_STATUSES = new Set(['failed', 'inventoried', 'passed', 'planned'])

export async function persistVerificationPerformanceEvidence(options) {
  const artifactRoot = resolve(options.artifactRoot)
  const runDirectory = resolve(options.runDirectory)
  assertDescendant(artifactRoot, runDirectory, 'VerificationPerformanceRunDirectoryOutsideRoot')
  await mkdir(runDirectory, { recursive: true })
  const byId = new Map(options.stages.map((stage) => [stage.id, stage]))
  const stages = VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS.map((id) => {
    const stage = byId.get(id)
    const stdoutArtifact = PROFILE_STAGE_IDS.has(id)
      ? boundedSiblingArtifact(artifactRoot, runDirectory, stage?.stdoutPath ?? null)
      : null
    return Object.freeze({
      id,
      status: stage?.status ?? 'planned',
      exitCode: stage?.exitCode ?? null,
      timing: stage?.timing ? Object.freeze({ ...stage.timing }) : null,
      stdoutArtifact,
    })
  })
  const evidence = Object.freeze({
    schemaVersion: VERIFICATION_PERFORMANCE_EVIDENCE_SCHEMA_VERSION,
    kind: 'verification-performance-evidence',
    runId: options.runId,
    provenance: options.provenance ?? null,
    stages: Object.freeze(stages),
  })
  validateVerificationPerformanceEvidence(evidence, options.runId)
  const path = resolve(runDirectory, 'performance-input.json')
  const temporaryPath = resolve(runDirectory, `.performance-input-${process.pid}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
  return Object.freeze({ evidence, path })
}

export async function readVerificationPerformanceEvidence(path, expectedRunId) {
  const absolutePath = resolve(path)
  const value = JSON.parse(await readFile(absolutePath, 'utf8'))
  return Object.freeze({
    evidence: validateVerificationPerformanceEvidence(value, expectedRunId),
    path: absolutePath,
  })
}

export function validateVerificationPerformanceEvidence(value, expectedRunId) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== VERIFICATION_PERFORMANCE_EVIDENCE_SCHEMA_VERSION ||
    value.kind !== 'verification-performance-evidence' ||
    typeof value.runId !== 'string' ||
    value.runId.length === 0 ||
    !Array.isArray(value.stages)
  ) {
    throw new Error('VerificationPerformanceEvidenceInvalid')
  }
  if (expectedRunId !== undefined && value.runId !== expectedRunId) {
    throw new Error('VerificationPerformanceEvidenceRunMismatch')
  }
  if (value.stages.length !== VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS.length) {
    throw new Error('VerificationPerformanceEvidenceStageSetInvalid')
  }
  for (let index = 0; index < value.stages.length; index += 1) {
    const stage = value.stages[index]
    const expectedId = VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS[index]
    if (
      !isRecord(stage) ||
      stage.id !== expectedId ||
      !STAGE_STATUSES.has(stage.status) ||
      !(stage.exitCode === null || Number.isSafeInteger(stage.exitCode)) ||
      !validTiming(stage.timing)
    ) {
      throw new Error('VerificationPerformanceEvidenceStageInvalid')
    }
    if (PROFILE_STAGE_IDS.has(expectedId)) {
      if (!(stage.stdoutArtifact === null || safeSiblingName(stage.stdoutArtifact))) {
        throw new Error('VerificationPerformanceEvidenceArtifactInvalid')
      }
    } else if (stage.stdoutArtifact !== null) {
      throw new Error('VerificationPerformanceEvidenceUnexpectedArtifact')
    }
  }
  return value
}

export function verificationPerformanceArtifactPath(inputPath, stage) {
  if (!PROFILE_STAGE_IDS.has(stage.id) || !safeSiblingName(stage.stdoutArtifact)) {
    throw new Error(`VerificationPerformanceArtifactUnavailable:${stage.id}`)
  }
  return resolve(dirname(resolve(inputPath)), stage.stdoutArtifact)
}

function boundedSiblingArtifact(artifactRoot, runDirectory, path) {
  if (path === null) return null
  const absolute = resolve(artifactRoot, path)
  if (dirname(absolute) !== runDirectory) {
    throw new Error('VerificationPerformanceArtifactOutsideRun')
  }
  return basename(absolute)
}

function assertDescendant(parent, child, code) {
  const path = relative(parent, child)
  if (path === '..' || path.startsWith('../') || resolve(parent, path) !== child) {
    throw new Error(code)
  }
}

function safeSiblingName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === basename(value) &&
    value !== '.' &&
    value !== '..'
  )
}

function validTiming(value) {
  if (value === null) return true
  return (
    isRecord(value) &&
    finiteNonNegative(value.wallMs) &&
    finiteNonNegative(value.runnerCpuUserMs) &&
    finiteNonNegative(value.runnerCpuSystemMs)
  )
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
