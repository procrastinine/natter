import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_CONTRACT_STAGE } from './protocol-contract-descriptor.mjs'
import { persistVerificationPerformanceEvidence } from './verification-performance-evidence.mjs'
import {
  createVerificationRuntimeInvocation,
  executeFileBackedVerificationProcess,
  verificationChildEnvironment,
} from './verification-process-execution.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SUMMARY_PATH = resolve(ROOT, 'test-results/verification-summary.json')
const FIXED_CHILD_ENV = Object.freeze({
  E2E_DEV_PORT: '4175',
  E2E_FAKE_PROVIDER_PORT: '4174',
  E2E_PORT: '4173',
  E2E_REUSE_EXISTING_SERVER: '0',
  E2E_SERIALIZE_LARGE_WORKSPACE_CLOSURE: '1',
  TZ: 'UTC',
})

export const VERIFICATION_STAGES = Object.freeze([
  stage('environment', 'Validate pinned verification environment', 'blocking', [
    'internal',
    'validate-environment',
  ]),
  stage('application-typescript', 'Typecheck the application contract', 'blocking', [
    'pnpm',
    'exec',
    'tsc',
    '-p',
    'tsconfig.app.json',
    '--noEmit',
    '--pretty',
    'false',
  ]),
  stage('test-typescript', 'Typecheck the preserved test contract', 'blocking', [
    'pnpm',
    'exec',
    'tsc',
    '-p',
    'tsconfig.test.json',
    '--noEmit',
    '--pretty',
    'false',
  ]),
  stage('current-wave-ownership', 'Audit the frozen current-wave contract', 'blocking', [
    'node',
    'scripts/audit-current-wave.mjs',
  ]),
  stage('peer-dependencies', 'Check peer dependencies', 'advisory', ['pnpm', 'peers', 'check']),
  stage('formatting', 'Check formatting and Biome lint', 'blocking', [
    'pnpm',
    'exec',
    'biome',
    'check',
    '.',
  ]),
  stage('semantic-lint', 'Check semantic lint', 'blocking', [
    'pnpm',
    'exec',
    'eslint',
    'src/**/*.{ts,tsx}',
    'tests/**/*.{ts,tsx}',
    '*.config.ts',
  ]),
  stage('general-dead-code', 'Check repository-wide dead code', 'blocking', [
    'pnpm',
    'exec',
    'knip',
    '--no-progress',
  ]),
  stage('production-reachability', 'Audit production file reachability', 'blocking', [
    'pnpm',
    'exec',
    'knip',
    '--config',
    'knip.production.json',
    '--production',
    '--include',
    'files',
    '--no-progress',
  ]),
  stage('production-module-inventory', 'Audit production module ownership', 'blocking', [
    'node',
    'scripts/audit-production-modules.mjs',
  ]),
  stage('verification-assurance', 'Audit verification assurance reporting', 'blocking', [
    'node',
    'scripts/audit-verification-assurance.mjs',
  ]),
  stage('architecture-coverage', 'Audit architecture domain and dimension coverage', 'blocking', [
    'node',
    'scripts/audit-architecture-coverage.mjs',
    '--mode',
    'inventory',
  ]),
  stage(
    PROTOCOL_CONTRACT_STAGE.id,
    PROTOCOL_CONTRACT_STAGE.label,
    PROTOCOL_CONTRACT_STAGE.policy,
    PROTOCOL_CONTRACT_STAGE.argv,
  ),
  stage('production-export-classification', 'Classify production exports', 'blocking', [
    'node',
    'scripts/classify-production-exports.mjs',
  ]),
  stage('presentation-store-boundary', 'Audit presentation/store boundary', 'blocking', [
    'node',
    'scripts/audit-presentation-store-boundary.mjs',
  ]),
  stage('production-coordination', 'Audit production coordination', 'blocking', [
    'node',
    'scripts/audit-production-coordination.mjs',
  ]),
  stage('production-runtime-effects', 'Audit production runtime effect ownership', 'blocking', [
    'node',
    'scripts/audit-production-runtime-effects.mjs',
    '--mode',
    'inventory',
  ]),
  stage('production-async-ownership', 'Audit production async failure ownership', 'blocking', [
    'node',
    'scripts/audit-production-async-ownership.mjs',
    '--mode',
    'inventory',
  ]),
  stage('hidden-tab-visual-continuity', 'Audit hidden-tab painted-state continuity', 'blocking', [
    'node',
    'scripts/audit-hidden-tab-visual-continuity.mjs',
    '--mode',
    'inventory',
  ]),
  stage('scroll-continuity', 'Audit scroll geometry ownership and continuity', 'blocking', [
    'node',
    'scripts/audit-scroll-continuity.mjs',
    '--mode',
    'enforce',
  ]),
  stage('startup-readiness', 'Audit startup, reopen, and hidden-recycle readiness', 'blocking', [
    'node',
    'scripts/audit-startup-readiness.mjs',
    '--mode',
    'inventory',
  ]),
  stage(
    'storage-ownership-reclamation',
    'Audit physical table ownership, origin namespaces, and reclamation paths',
    'blocking',
    ['node', 'scripts/audit-storage-ownership-reclamation.mjs', '--mode', 'inventory'],
  ),
  stage('production-dependency-graph', 'Audit production dependency graph', 'blocking', [
    'pnpm',
    'exec',
    'depcruise',
    'src',
    '--config',
    '.dependency-cruiser.cjs',
  ]),
  stage('production-duplication', 'Audit production duplication budget', 'blocking', [
    'pnpm',
    'exec',
    'jscpd',
    '--config',
    'jscpd.production.json',
    'src',
  ]),
  stage('production-time', 'Audit production temporal coordination', 'blocking', [
    'node',
    'scripts/audit-production-time.mjs',
  ]),
  stage(
    'production-time-semantics',
    'Audit temporal correctness, ownership, cleanup, and readiness',
    'blocking',
    ['node', 'scripts/audit-production-time-semantics.mjs', '--mode', 'inventory'],
  ),
  stage('production-work-memory', 'Audit production work and memory ownership', 'blocking', [
    'node',
    'scripts/audit-production-work-memory.mjs',
    '--mode',
    'inventory',
  ]),
  stage(
    'e2e-browser-storage',
    'Audit raw browser storage access and cleanup ownership',
    'blocking',
    ['node', 'scripts/audit-e2e-browser-storage.mjs'],
  ),
  stage('test-evidence', 'Audit test evidence and local-CI parity', 'blocking', [
    'node',
    'scripts/audit-test-evidence.mjs',
    '--mode',
    'inventory',
  ]),
  stage('interaction-capabilities', 'Audit exact UI interaction capabilities', 'blocking', [
    'node',
    'scripts/audit-interaction-capabilities.mjs',
    '--mode',
    'inventory',
  ]),
  stage('architecture-inventory-closure', 'Audit architecture inventory closure', 'blocking', [
    'node',
    'scripts/audit-architecture-inventory-closure.mjs',
    '--mode',
    'inventory',
  ]),
  stage('production-build', 'Build and verify the production artifact', 'blocking', [
    'pnpm',
    'build',
  ]),
  stage('vitest', 'Run unit and integration tests', 'blocking', ['pnpm', 'exec', 'vitest', 'run'], {
    stderr: 'empty',
  }),
  stage('chromium-e2e', 'Test the built app against the loopback fake provider', 'blocking', [
    'pnpm',
    'exec',
    'playwright',
    'test',
    '--project=chromium-send-performance',
  ]),
  stage(
    'firefox-e2e',
    'Test the built app in Firefox against the loopback fake provider',
    'blocking',
    ['pnpm', 'exec', 'playwright', 'test', '--project=firefox-send-performance'],
  ),
  stage(
    'headed-hidden-tab-visual-continuity',
    'Prove native hidden-tab first-frame continuity in headed Chromium',
    'blocking',
    ['pnpm', 'run', 'e2e:headed-visibility'],
  ),
  stage(
    'dev-preview-parity',
    'Compare Vite dev and built preview through one public journey',
    'blocking',
    [
      'pnpm',
      'exec',
      'playwright',
      'test',
      '--project=chromium-preview-parity',
      '--project=chromium-dev-parity',
    ],
  ),
  stage('stream-profile-single', 'Profile one large real-shaped stream workload', 'blocking', [
    'node',
    'scripts/profile-fake-stream.mjs',
    '--serve-preview',
  ]),
  stage(
    'stream-profile-concurrent',
    'Profile concurrent multi-tab real-shaped stream workloads',
    'blocking',
    ['node', 'scripts/profile-concurrent-fake-stream.mjs', '--serve-preview'],
  ),
  stage('performance', 'Report performance ratchets and hard boundaries', 'blocking', [
    'node',
    'scripts/report-performance-baseline.mjs',
  ]),
])

export const CHECKPOINT_REQUIRED_STAGE_IDS = Object.freeze(
  VERIFICATION_STAGES.filter(
    (item) => item.policy === 'blocking' && assuranceKind(item) !== 'inventory',
  ).map((item) => item.id),
)

export async function collectVerificationMetadata(options = {}) {
  const root = options.root ?? ROOT
  const environment = options.environment ?? process.env
  const metadataDiagnostics = []
  const packageJson = await readJsonMetadata(
    resolve(root, 'package.json'),
    'PackageMetadataUnavailable',
    metadataDiagnostics,
  )
  const expectedNodeVersion = await readTextMetadata(
    resolve(root, '.node-version'),
    'NodeVersionPinUnavailable',
    metadataDiagnostics,
  )
  const expectedPnpmVersion = packageManagerVersion(packageJson.packageManager)
  const pnpmVersion = options.pnpmVersion ?? (await capturePnpmVersion(root))
  const playwrightPackage = await readJsonMetadata(
    resolve(root, 'node_modules/@playwright/test/package.json'),
    'PlaywrightMetadataUnavailable',
    metadataDiagnostics,
  )
  return Object.freeze({
    nodeVersion: options.nodeVersion ?? process.versions.node,
    expectedNodeVersion,
    pnpmVersion,
    expectedPnpmVersion,
    playwrightVersion:
      typeof playwrightPackage.version === 'string' ? playwrightPackage.version : 'unavailable',
    platform: process.platform,
    architecture: process.arch,
    ci: environmentFlag(environment.CI),
    githubActions: environmentFlag(environment.GITHUB_ACTIONS),
    runnerOs: environment.RUNNER_OS ?? null,
    timezone: environment.TZ ?? FIXED_CHILD_ENV.TZ,
    e2ePort: Number(environment.E2E_PORT ?? FIXED_CHILD_ENV.E2E_PORT),
    fakeProviderPort: Number(
      environment.E2E_FAKE_PROVIDER_PORT ?? FIXED_CHILD_ENV.E2E_FAKE_PROVIDER_PORT,
    ),
    metadataDiagnostics: Object.freeze([...metadataDiagnostics]),
  })
}

export async function runVerification(options = {}) {
  const root = options.root ?? ROOT
  const baseEnv = options.baseEnv ?? process.env
  const executionRuntime = options.executionRuntime ?? null
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const cpuUsage = options.cpuUsage ?? ((previous) => process.cpuUsage(previous))
  const runStartedAt = monotonicNow()
  const runStartedCpu = cpuUsage()
  const stages = options.stages ?? VERIFICATION_STAGES
  const metadata =
    options.metadata ?? (await collectVerificationMetadata({ root, environment: baseEnv }))
  const runId = options.runId ?? verificationRunId(options.now?.() ?? new Date())
  const artifactRoot = options.artifactRoot ?? root
  const runDirectory =
    options.runDirectory ?? resolve(artifactRoot, 'test-results/verification-stages', runId)
  let performanceEvidencePath = null
  const executeStage =
    options.executeStage ??
    ((item, metadata) =>
      executeVerificationStage(item, metadata, {
        root,
        baseEnv,
        executionRuntime,
        artifactRoot,
        runDirectory,
        runId,
        performanceEvidencePath,
        forwardOutput: options.forwardOutput !== false,
        outputDestinations: options.outputDestinations,
      }))
  const persistSummary = options.persistSummary ?? persistVerificationSummary
  const dryRun = options.dryRun === true
  const infrastructureDiagnostics = []
  const currentRunTiming = () => elapsedTiming(monotonicNow, cpuUsage, runStartedAt, runStartedCpu)
  const results = stages.map((item) => plannedStageResult(item))
  let summary = createVerificationSummary(
    metadata,
    results,
    dryRun ? 'planned' : 'running',
    currentRunTiming(),
    infrastructureDiagnostics,
    options.provenance ?? null,
  )
  await persistVerificationEvidence(persistSummary, summary, 'initial', infrastructureDiagnostics)

  if (dryRun) {
    summary = createVerificationSummary(
      metadata,
      results,
      infrastructureDiagnostics.length === 0 ? 'planned' : 'failed',
      currentRunTiming(),
      infrastructureDiagnostics,
      options.provenance ?? null,
    )
    return { summary, exitCode: infrastructureDiagnostics.length === 0 ? 0 : 1 }
  }

  for (let index = 0; index < stages.length; index += 1) {
    const item = stages[index]
    if (!item) continue
    if (item.id === 'performance') {
      try {
        performanceEvidencePath = (
          await persistVerificationPerformanceEvidence({
            artifactRoot,
            runDirectory,
            runId,
            provenance: options.provenance ?? null,
            stages: results,
          })
        ).path
      } catch (error) {
        infrastructureDiagnostics.push(
          `VerificationPerformanceEvidenceFailed:${errorName(error)}:${errorMessage(error)}`,
        )
      }
    }
    printStageHeader(index, stages.length, item)
    const stageStartedAt = monotonicNow()
    const stageStartedCpu = cpuUsage()
    let execution
    try {
      execution = await executeStage(item, metadata)
    } catch (error) {
      execution = {
        exitCode: null,
        signal: null,
        diagnostics: [error instanceof Error ? error.message : String(error)],
        stdoutPath: null,
        stderrPath: null,
      }
    }
    results[index] = completedStageResult(
      item,
      execution,
      elapsedTiming(monotonicNow, cpuUsage, stageStartedAt, stageStartedCpu),
    )
    printStageResult(results[index])
    summary = createVerificationSummary(
      metadata,
      results,
      'running',
      currentRunTiming(),
      infrastructureDiagnostics,
      options.provenance ?? null,
    )
    await persistVerificationEvidence(
      persistSummary,
      summary,
      `stage:${item.id}`,
      infrastructureDiagnostics,
    )
  }

  const blockingFailures = results.filter(
    (result) => result.policy === 'blocking' && result.status === 'failed',
  )
  const hasInventoryOnlyResults = results.some((result) => result.status === 'inventoried')
  const requiredStageResults = resolveRequiredStageResults(
    options.requiredStageIds,
    results,
    infrastructureDiagnostics,
  )
  if (options.finalValidator) {
    try {
      await options.finalValidator()
    } catch (error) {
      infrastructureDiagnostics.push(
        `VerificationFinalValidationFailed:${errorName(error)}:${errorMessage(error)}`,
      )
    }
  }
  const stageOutcome =
    blockingFailures.length === 0
      ? requiredStageResults === null
        ? hasInventoryOnlyResults
          ? 'completed-with-open-inventories'
          : 'passed'
        : requiredStageResults.every((result) => result.status === 'passed')
          ? 'passed'
          : 'failed'
      : 'failed'
  const finalOutcome = infrastructureDiagnostics.length === 0 ? stageOutcome : 'failed'
  summary = createVerificationSummary(
    metadata,
    results,
    finalOutcome,
    currentRunTiming(),
    infrastructureDiagnostics,
    options.provenance ?? null,
  )
  await persistVerificationEvidence(persistSummary, summary, 'final', infrastructureDiagnostics)
  summary = createVerificationSummary(
    metadata,
    results,
    finalOutcome,
    currentRunTiming(),
    infrastructureDiagnostics,
    options.provenance ?? null,
  )
  printFinalSummary(summary)
  return {
    summary,
    exitCode: finalOutcome === 'failed' ? 1 : 0,
  }
}

function resolveRequiredStageResults(requiredStageIds, results, infrastructureDiagnostics) {
  if (requiredStageIds === undefined) return null
  const resultById = new Map(results.map((result) => [result.id, result]))
  const seen = new Set()
  const requiredResults = []
  for (const id of requiredStageIds) {
    if (seen.has(id)) {
      infrastructureDiagnostics.push(`VerificationRequiredStageDuplicate:${id}`)
      continue
    }
    seen.add(id)
    const result = resultById.get(id)
    if (!result) {
      infrastructureDiagnostics.push(`VerificationRequiredStageMissing:${id}`)
      continue
    }
    if (result.policy !== 'blocking') {
      infrastructureDiagnostics.push(`VerificationRequiredStageNotBlocking:${id}`)
      continue
    }
    if (result.assurance === 'inventory') {
      infrastructureDiagnostics.push(`VerificationRequiredStageCannotBeInventory:${id}`)
      continue
    }
    requiredResults.push(result)
  }
  return requiredResults
}

export function createVerificationSummary(
  metadata,
  stages,
  outcome,
  timing = emptyTiming(),
  infrastructureDiagnostics = [],
  provenance = null,
) {
  const blockingFailures = stages
    .filter((result) => result.policy === 'blocking' && result.status === 'failed')
    .map((result) => result.id)
  const advisoryFailures = stages
    .filter((result) => result.policy === 'advisory' && result.status === 'failed')
    .map((result) => result.id)
  return Object.freeze({
    schemaVersion: 4,
    provenance,
    metadata,
    timing: Object.freeze({ ...timing }),
    policy: Object.freeze({
      execution: 'sequential-non-fail-fast',
      blockingFailureExitCode: 1,
      advisoryFailureExitCode: 0,
    }),
    stages: stages.map((result) => Object.freeze({ ...result })),
    assurance: Object.freeze({
      hygiene: stages.filter((result) => result.assurance === 'hygiene').map((result) => result.id),
      inventories: stages
        .filter((result) => result.assurance === 'inventory')
        .map((result) => result.id),
      guarantees: stages
        .filter((result) => result.assurance === 'guarantee')
        .map((result) => result.id),
      runtimeProofs: stages
        .filter((result) => result.assurance === 'runtime')
        .map((result) => result.id),
    }),
    blockingFailures,
    advisoryFailures,
    infrastructureDiagnostics: Object.freeze([...infrastructureDiagnostics]),
    outcome,
  })
}

export function serializeVerificationSummary(summary) {
  return `${JSON.stringify(summary, null, 2)}\n`
}

export async function executeVerificationStage(item, metadata, options = {}) {
  if (item.argv[0] === 'internal') {
    return { ...validateEnvironment(metadata), stdoutPath: null, stderrPath: null }
  }
  const root = options.root ?? ROOT
  const baseEnv = options.baseEnv ?? process.env
  const invocation = createVerificationRuntimeInvocation(item.argv, options.executionRuntime)
  const artifactRoot = options.artifactRoot ?? root
  const runId = options.runId ?? 'verification'
  const runDirectory =
    options.runDirectory ?? resolve(artifactRoot, 'test-results/verification-stages', runId)
  const execution = await executeFileBackedVerificationProcess({
    id: item.id,
    command: invocation.command,
    args: invocation.args,
    cwd: root,
    environment: verificationStageEnvironment(item, {
      root,
      baseEnv,
      runId,
      runDirectory,
      performanceEvidencePath: options.performanceEvidencePath,
    }),
    artifactRoot,
    runDirectory,
    diagnosticPrefix: 'VerificationStage',
    forwardOutput: options.forwardOutput !== false,
    outputDestinations: options.outputDestinations,
  })
  if (item.stderr !== 'empty' || execution.stderrPath === null) return execution
  const stderr = await readFile(resolve(artifactRoot, execution.stderrPath), 'utf8')
  if (stderr.length === 0) return execution
  return Object.freeze({
    ...execution,
    exitCode: execution.exitCode === 0 ? 1 : execution.exitCode,
    diagnostics: Object.freeze([
      ...execution.diagnostics,
      `VerificationStageUnexpectedStderr:${item.id}:${Buffer.byteLength(stderr)}`,
    ]),
  })
}

export function verificationStageEnvironment(item, options = {}) {
  const root = options.root ?? ROOT
  const baseEnv = options.baseEnv ?? process.env
  const environment = verificationChildEnvironment({
    kind: item.id,
    root,
    runId: options.runId ?? String(process.pid),
    baseEnv: { ...FIXED_CHILD_ENV, ...baseEnv },
  })
  if (
    item.id === 'vitest' &&
    !/(?:^|\s)--trace-warnings(?:\s|$)/u.test(environment.NODE_OPTIONS ?? '')
  ) {
    environment.NODE_OPTIONS = [environment.NODE_OPTIONS, '--trace-warnings']
      .filter(Boolean)
      .join(' ')
  }
  environment.VERIFICATION_RUN_ID = options.runId ?? String(process.pid)
  if (
    [
      'chromium-e2e',
      'firefox-e2e',
      'headed-hidden-tab-visual-continuity',
      'dev-preview-parity',
    ].includes(item.id)
  ) {
    environment.E2E_SKIP_BUILD = '1'
    environment.E2E_PLAYWRIGHT_OUTPUT_DIR = resolve(
      options.runDirectory ??
        resolve(root, 'test-results/verification-stages', options.runId ?? String(process.pid)),
      `${item.id}.playwright`,
    )
  }
  if (item.id === 'dev-preview-parity') environment.E2E_DEV_PREVIEW_PARITY = '1'
  if (item.id === 'performance' && options.performanceEvidencePath) {
    environment.VERIFICATION_PERFORMANCE_INPUT = options.performanceEvidencePath
  }
  return environment
}

function validateEnvironment(metadata) {
  const diagnostics = [...metadata.metadataDiagnostics]
  if (metadata.nodeVersion !== metadata.expectedNodeVersion) {
    diagnostics.push(
      `NodeVersionMismatch: expected ${metadata.expectedNodeVersion}, found ${metadata.nodeVersion}`,
    )
  }
  if (metadata.pnpmVersion !== metadata.expectedPnpmVersion) {
    diagnostics.push(
      `PnpmVersionMismatch: expected ${metadata.expectedPnpmVersion}, found ${metadata.pnpmVersion}`,
    )
  }
  return {
    exitCode: diagnostics.length === 0 ? 0 : 1,
    signal: null,
    diagnostics,
  }
}

async function readJsonMetadata(path, code, diagnostics) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    diagnostics.push(`${code}:${error instanceof Error ? error.name : 'UnknownError'}`)
    return {}
  }
}

async function readTextMetadata(path, code, diagnostics) {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (error) {
    diagnostics.push(`${code}:${error instanceof Error ? error.name : 'UnknownError'}`)
    return 'unavailable'
  }
}

async function capturePnpmVersion(root) {
  return new Promise((resolveVersion) => {
    let stdout = ''
    let settled = false
    let child
    try {
      child = spawn(pnpmCommand(), ['--version'], {
        cwd: root,
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolveVersion('unavailable')
      return
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.once('error', () => {
      if (settled) return
      settled = true
      resolveVersion('unavailable')
    })
    child.once('exit', (exitCode) => {
      if (settled) return
      settled = true
      resolveVersion(exitCode === 0 ? stdout.trim() : 'unavailable')
    })
  })
}

async function persistVerificationSummary(summary) {
  await mkdir(dirname(SUMMARY_PATH), { recursive: true })
  const temporaryPath = `${SUMMARY_PATH}.${process.pid}.tmp`
  await writeFile(temporaryPath, serializeVerificationSummary(summary), 'utf8')
  await rename(temporaryPath, SUMMARY_PATH)
}

async function persistVerificationEvidence(
  persistSummary,
  summary,
  phase,
  infrastructureDiagnostics,
) {
  try {
    await persistSummary(summary)
  } catch (error) {
    const diagnostic = `VerificationSummaryPersistenceFailed:${phase}:${errorName(error)}`
    if (!infrastructureDiagnostics.includes(diagnostic)) {
      infrastructureDiagnostics.push(diagnostic)
    }
    console.error(`[verify] ${diagnostic}`)
  }
}

function errorName(error) {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name
  }
  return 'UnknownError'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function stage(id, label, policy, argv, options = {}) {
  return Object.freeze({ id, label, policy, argv: Object.freeze(argv), ...options })
}

function plannedStageResult(item) {
  return {
    id: item.id,
    label: item.label,
    policy: item.policy,
    argv: [...item.argv],
    assurance: assuranceKind(item),
    status: 'planned',
    exitCode: null,
    signal: null,
    diagnostics: [],
    timing: null,
    stdoutPath: null,
    stderrPath: null,
  }
}

function completedStageResult(item, execution, timing) {
  const passed = execution.exitCode === 0 && execution.signal === null
  const assurance = assuranceKind(item)
  return {
    id: item.id,
    label: item.label,
    policy: item.policy,
    argv: [...item.argv],
    assurance,
    status: passed ? (assurance === 'inventory' ? 'inventoried' : 'passed') : 'failed',
    exitCode: execution.exitCode,
    signal: execution.signal,
    diagnostics: [...execution.diagnostics],
    timing: Object.freeze({ ...timing }),
    stdoutPath: execution.stdoutPath ?? null,
    stderrPath: execution.stderrPath ?? null,
  }
}

function elapsedTiming(monotonicNow, cpuUsage, startedAt, startedCpu) {
  const cpu = cpuUsage(startedCpu)
  return Object.freeze({
    wallMs: Math.max(0, monotonicNow() - startedAt),
    runnerCpuUserMs: Math.max(0, cpu.user / 1_000),
    runnerCpuSystemMs: Math.max(0, cpu.system / 1_000),
  })
}

function emptyTiming() {
  return Object.freeze({ wallMs: 0, runnerCpuUserMs: 0, runnerCpuSystemMs: 0 })
}

function assuranceKind(item) {
  if (
    item.policy === 'advisory' ||
    ['formatting', 'semantic-lint', 'general-dead-code'].includes(item.id)
  ) {
    return 'hygiene'
  }
  if (item.argv.some((arg, index) => arg === '--mode' && item.argv[index + 1] === 'inventory')) {
    return 'inventory'
  }
  if (
    [
      'production-build',
      'vitest',
      'chromium-e2e',
      'firefox-e2e',
      'headed-hidden-tab-visual-continuity',
      'dev-preview-parity',
      'stream-profile-single',
      'stream-profile-concurrent',
      'performance',
    ].includes(item.id)
  ) {
    return 'runtime'
  }
  return 'guarantee'
}

function packageManagerVersion(packageManager) {
  if (typeof packageManager !== 'string') return 'missing'
  const match = /^pnpm@(.+)$/u.exec(packageManager)
  return match?.[1] ?? 'missing'
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function environmentFlag(value) {
  return typeof value === 'string' && value !== '' && value !== '0' && value !== 'false'
}

function verificationRunId(now) {
  return `verification-${now.toISOString().replaceAll(/[:.]/gu, '-')}`
}

function printStageHeader(index, count, item) {
  console.log(`\n[verify ${index + 1}/${count}] ${item.label} (${item.policy})`)
  console.log(`$ ${item.argv.join(' ')}`)
}

function printStageResult(result) {
  const detail =
    result.exitCode === null ? (result.signal ?? 'no exit code') : `exit ${result.exitCode}`
  const duration = result.timing ? `, ${result.timing.wallMs.toFixed(1)} ms` : ''
  console.log(`[verify] ${result.status} (${detail}${duration})`)
  for (const diagnostic of result.diagnostics) console.log(`[verify] ${diagnostic}`)
}

function printFinalSummary(summary) {
  console.log('\nVerification complete')
  console.log(`- outcome: ${summary.outcome}`)
  console.log(`- blocking failures: ${summary.blockingFailures.join(', ') || 'none'}`)
  console.log(`- advisory findings: ${summary.advisoryFailures.join(', ') || 'none'}`)
  console.log(
    `- evidence infrastructure findings: ${summary.infrastructureDiagnostics.join(', ') || 'none'}`,
  )
  console.log(`- wall time: ${summary.timing.wallMs.toFixed(1)} ms`)
  console.log('- summary: test-results/verification-summary.json')
  if (summary.advisoryFailures.length > 0) {
    console.log(
      `::warning title=Advisory verification findings::${summary.advisoryFailures.join(', ')}`,
    )
  }
}

function parseCliArgs(argv) {
  if (argv.length === 0) return { dryRun: false }
  if (argv.length === 1 && argv[0] === '--dry-run') return { dryRun: true }
  throw new Error(`Unknown verification runner arguments: ${argv.join(' ')}`)
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2))
  const result = await runVerification(cli)
  process.exitCode = result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
