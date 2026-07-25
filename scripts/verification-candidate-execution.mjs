import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import process from 'node:process'
import {
  assertMaterializedVerificationCandidateExecutionReady,
  installMaterializedVerificationCandidateRuntime,
  resetMaterializedVerificationCandidateWritableState,
  resolveVerificationCandidateRuntime,
} from './verification-candidate-workspace.mjs'
import {
  acquireVerificationProcessLease,
  releaseVerificationProcessLease,
} from './verification-process-lease.mjs'

export async function executeMaterializedVerificationCandidate(options, operation) {
  const candidate = assertMaterializedVerificationCandidateExecutionReady(options.candidate)
  if (resolve(candidate.evidenceRoot) !== resolve(options.evidenceRoot)) {
    throw new Error('VerificationCandidateEvidenceRootMismatch')
  }
  if (resolve(candidate.runtimeRoot) !== resolve(options.residentRoot)) {
    throw new Error('VerificationCandidateResidentRootMismatch')
  }
  const runtime = await resolveVerificationCandidateRuntime(candidate)
  const lease = acquireVerificationProcessLease({
    path: `${candidate.directory}.execution-lease`,
    purpose: options.purpose,
  })
  try {
    resetMaterializedVerificationCandidateWritableState(candidate)
    installMaterializedVerificationCandidateRuntime(candidate, runtime)
    const environment = createVerificationCandidateEnvironment(
      candidate,
      options.runId,
      options.baseEnv ?? process.env,
      runtime,
    )
    return await operation(Object.freeze({ candidate, runtime, environment }))
  } finally {
    releaseVerificationProcessLease(lease)
  }
}

export function createVerificationCandidateEnvironment(
  candidate,
  runId,
  baseEnv = process.env,
  runtime = null,
) {
  const executionId = safeFilePart(runId)
  const home = resolve(candidate.runtimePaths.home, executionId)
  const tmp = resolve(candidate.runtimePaths.tmp, executionId)
  const cache = resolve(candidate.runtimePaths.cache, executionId)
  for (const path of [home, tmp, cache]) mkdirSync(path, { recursive: true, mode: 0o755 })
  const portBase = 20_000 + (Number.parseInt(sha256(runId).slice(0, 8), 16) % 20_000)
  const environment = {
    CI: '1',
    E2E_DEV_PORT: String(portBase + 2),
    E2E_FAKE_PROVIDER_PORT: String(portBase + 1),
    E2E_PORT: String(portBase),
    E2E_REUSE_EXISTING_SERVER: '0',
    FORCE_COLOR: '0',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    NPM_CONFIG_CACHE: resolve(cache, 'npm'),
    npm_config_manage_package_manager_versions: 'false',
    pnpm_config_verify_deps_before_run: 'false',
    PATH: `${candidate.runtimePaths.toolBin}${delimiter}${baseEnv.PATH ?? ''}`,
    PLAYWRIGHT_BROWSERS_PATH:
      baseEnv.PLAYWRIGHT_BROWSERS_PATH ?? resolve(homedir(), '.cache/ms-playwright'),
    TMP: tmp,
    TMPDIR: tmp,
    TZ: 'UTC',
    XDG_CACHE_HOME: resolve(cache, 'xdg'),
    XDG_CONFIG_HOME: resolve(home, '.config'),
    XDG_DATA_HOME: resolve(home, '.local/share'),
  }
  if (runtime) {
    environment.VERIFICATION_NODE_EXECUTABLE = runtime.nodeExecutablePath
    environment.VERIFICATION_PNPM_EXECUTABLE = runtime.pnpmExecutablePath
  }
  for (const name of ['COMSPEC', 'GITHUB_ACTIONS', 'RUNNER_OS', 'SYSTEMROOT', 'WINDIR']) {
    const value = baseEnv[name]
    if (value) environment[name] = value
  }
  return Object.freeze(environment)
}

function safeFilePart(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/gu, '-')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
