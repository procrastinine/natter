import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwrightProjects } from './playwright-projects.mjs'
import {
  browserSuiteFiles,
  fullBrowserTasks,
  readBrowserProof,
  reconcileBrowserPhaseProofs,
} from './playwright-proof-reporter.mjs'
import {
  browserExecutionPhases,
  browserGroupProjects,
  browserTaskGroups,
} from './playwright-selection.mjs'
import { PROTOCOL_CONTRACT_STAGE } from './protocol-contract-descriptor.mjs'
import {
  TEST_COMPILER_COHORT_DESCRIPTOR,
  TEST_COMPILER_DIAGNOSTIC_ARGV,
} from './test-compiler-cohort.mjs'
import {
  persistVerificationPerformanceEvidence,
  VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS,
} from './verification-performance-evidence.mjs'
import {
  createVerificationRuntimeInvocation,
  executeFileBackedVerificationProcess,
  verificationChildEnvironment,
} from './verification-process-execution.mjs'
import {
  verificationStageAssurance as assuranceKind,
  resolveVerificationStagePrerequisites,
  verificationStage as stage,
  verificationPrerequisiteDiagnostics,
  verificationStageBlocks,
  verificationStageStatus,
} from './verification-stage-contract.mjs'
import { isVitestSuitePath, vitestSuiteFiles } from './vitest-projects.mjs'
import { readVitestProof } from './vitest-proof-reporter.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SUMMARY_PATH = resolve(ROOT, 'test-results/verification-summary.json')
const FIXED_CHILD_ENV = Object.freeze({
  E2E_DEV_PORT: '4175',
  E2E_FAKE_PROVIDER_PORT: '4174',
  E2E_PORT: '4173',
  E2E_REUSE_EXISTING_SERVER: '0',
  TZ: 'UTC',
})

export const VERIFICATION_STAGES = Object.freeze([
  stage('environment', 'Validate pinned verification environment', 'blocking', [
    'internal',
    'validate-environment',
  ]),
  stage(
    'application-typescript',
    'Typecheck the application contract',
    'blocking',
    ['pnpm', 'exec', 'tsc', '-p', 'tsconfig.app.json', '--noEmit', '--pretty', 'false'],
    { inputPaths: ['tsconfig.app.json'] },
  ),
  stage(
    'test-typescript',
    'Typecheck the preserved test contract',
    'blocking',
    TEST_COMPILER_DIAGNOSTIC_ARGV,
    {
      compilerProof: true,
      environment: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.environment,
      inputPaths: ['tsconfig.test.json'],
    },
  ),
  stage('current-wave-ownership', 'Audit the frozen current-wave contract', 'blocking', [
    'node',
    'scripts/audit-current-wave.mjs',
  ]),
  stage('peer-dependencies', 'Check peer dependencies', 'advisory', ['pnpm', 'peers', 'check']),
  stage(
    'formatting',
    'Check formatting and Biome lint',
    'blocking',
    ['pnpm', 'exec', 'biome', 'check', '.'],
    { assurance: 'hygiene', inputPaths: ['biome.json'] },
  ),
  stage(
    'semantic-lint',
    'Check semantic lint',
    'blocking',
    ['pnpm', 'exec', 'eslint', 'src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}', '*.config.ts'],
    { assurance: 'hygiene', inputPaths: ['eslint.config.js'] },
  ),
  stage(
    'general-dead-code',
    'Check repository-wide dead code',
    'blocking',
    ['pnpm', 'exec', 'knip', '--no-progress'],
    { assurance: 'hygiene', inputPaths: ['knip.json'] },
  ),
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
  stage('test-runtime-isolation', 'Audit test runtime isolation', 'blocking', [
    'node',
    'scripts/audit-test-runtime-isolation.mjs',
  ]),
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
  stage(
    'production-build',
    'Build and verify the production artifact',
    'blocking',
    ['pnpm', 'build'],
    {
      assurance: 'runtime',
      inputPaths: [
        'vite.config.ts',
        'index.html',
        'tsconfig.json',
        'tsconfig.app.json',
        'tsconfig.node.json',
        'scripts/verify-dist.mjs',
      ],
      inputPrefixes: ['src/styles/', 'tools/'],
    },
  ),
  stage('vitest', 'Run unit and integration tests', 'blocking', ['pnpm', 'exec', 'vitest', 'run'], {
    kind: 'vitest',
    stderr: 'empty',
    nodeOptions: ['--trace-warnings'],
    inputPaths: ['vitest.config.ts', 'tsconfig.test.json'],
    prerequisites: [
      { id: PROTOCOL_CONTRACT_STAGE.id, consumerModules: PROTOCOL_CONTRACT_STAGE.consumerModules },
    ],
  }),
  stage(
    'chromium-e2e',
    'Test the built app against the loopback fake provider',
    'blocking',
    ['node', 'scripts/run-verification.mjs', '--browser', 'chromium'],
    browserStageOptions(browserGroupProjects('chromium')),
  ),
  stage(
    'firefox-e2e',
    'Test the built app in Firefox against the loopback fake provider',
    'blocking',
    ['node', 'scripts/run-verification.mjs', '--browser', 'firefox'],
    browserStageOptions(browserGroupProjects('firefox')),
  ),
  stage(
    'headed-hidden-tab-visual-continuity',
    'Prove native hidden-tab first-frame continuity in headed Chromium',
    'blocking',
    ['pnpm', 'run', 'e2e:headed-visibility'],
    browserStageOptions(['chromium-headed-visibility']),
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
    browserStageOptions(['chromium-preview-parity', 'chromium-dev-parity']),
  ),
  stage(
    'stream-profile-single',
    'Profile one large real-shaped stream workload',
    'blocking',
    ['node', 'scripts/profile-fake-stream.mjs', '--serve-preview'],
    { assurance: 'runtime', prerequisites: [{ id: 'production-build' }] },
  ),
  stage(
    'stream-profile-concurrent',
    'Profile concurrent multi-tab real-shaped stream workloads',
    'blocking',
    ['node', 'scripts/profile-concurrent-fake-stream.mjs', '--serve-preview'],
    { assurance: 'runtime', prerequisites: [{ id: 'production-build' }] },
  ),
  stage(
    'performance',
    'Report performance ratchets and hard boundaries',
    'blocking',
    ['node', 'scripts/report-performance-baseline.mjs'],
    {
      assurance: 'runtime',
      preparation: 'performance-evidence',
      prerequisites: VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS.map((id) => ({
        id,
        propagateImpact: false,
      })),
    },
  ),
])

function browserStageOptions(browserProjects) {
  return {
    kind: 'playwright',
    browserProjects,
    prerequisites: [{ id: 'production-build' }],
    inputPaths: [
      'playwright.config.ts',
      'scripts/playwright-projects.mjs',
      'scripts/playwright-proof-reporter.mjs',
      'scripts/fake-stream-server.mjs',
      ...playwrightProjects()
        .filter((project) => browserProjects.includes(project.name) && project.headed)
        .map(() => 'scripts/run-headed-visibility.mjs'),
    ],
  }
}

export function verificationStageInputPaths(item, allPaths = []) {
  return [
    ...new Set([
      ...(item.inputPaths ?? []),
      ...(item.argv[0] === 'node' && /^scripts\/[^:]+\.[cm]?js$/u.test(item.argv[1] ?? '')
        ? [item.argv[1]]
        : []),
      ...item.argv.filter((arg) =>
        /^(?:[^/]+\.config\.|(?:knip|jscpd|tsconfig)[^/]*\.json$|\.dependency-cruiser\.)/u.test(
          arg,
        ),
      ),
      ...[...allPaths].filter((path) =>
        item.inputPrefixes?.some((prefix) => path.startsWith(prefix)),
      ),
    ]),
  ]
}

export function compileSliceVerificationStages(tasks, options = {}) {
  const catalog = options.catalog ?? VERIFICATION_STAGES
  const selected = tasks.node.map((task) => {
    const argv = ['node', ...task.argv]
    return (
      catalog.find((item) => JSON.stringify(item.argv) === JSON.stringify(argv)) ??
      stage(task.id, task.id, 'blocking', argv)
    )
  })
  for (const id of options.stageIds ?? []) {
    const item = catalog.find((candidate) => candidate.id === id)
    if (!item) throw new Error(`VerificationStageUnknown:${id}`)
    if (item.kind !== 'vitest' && item.kind !== 'playwright') selected.push(item)
  }
  if (tasks.vitest.length > 0) {
    const template = catalog.find((item) => item.kind === 'vitest')
    if (!template) throw new Error('VerificationVitestStageMissing')
    selected.push(
      Object.freeze({
        ...template,
        unitFiles: Object.freeze([...tasks.vitest]),
        argv: Object.freeze([...template.argv, ...tasks.vitest]),
      }),
    )
  }
  for (const group of browserTaskGroups(tasks.playwright)) selected.push(sliceBrowserStage(group))
  const inputs = options.inputPaths ?? new Set()
  let resolved = resolveVerificationStagePrerequisites(selected, catalog, inputs)
  const reportRequiresAllUnits = resolved.some(
    (item) => item.preparation === 'performance-evidence',
  )
  const fullUnit = resolved.find(
    (item) => item.kind === 'vitest' && (!item.unitFiles || reportRequiresAllUnits),
  )
  if (fullUnit) {
    if (!options.sourceFiles) throw new Error('VerificationStageUnitPopulationRequired')
    const files = options.sourceFiles.filter(isVitestSuitePath).sort()
    if (!files.length) throw new Error('VerificationStageUnitPopulationEmpty')
    resolved = resolveVerificationStagePrerequisites(
      resolved.map((item) =>
        item === fullUnit
          ? stage(
              item.id,
              item.label,
              item.policy,
              [...catalog.find((candidate) => candidate.id === item.id).argv, ...files],
              { ...item, unitFiles: files },
            )
          : item,
      ),
      catalog,
      new Set(options.sourceFiles),
    )
  }
  const browserStages = resolved.filter((item) => item.kind === 'playwright')
  if (!browserStages.some((item) => !item.browserTasks)) return resolved
  if (!options.sourceFiles) throw new Error('VerificationStageBrowserPopulationRequired')
  const tasksByProject = new Map()
  for (const item of browserStages) {
    const tasks = item.browserTasks ?? fullBrowserTasks(item.browserProjects, options.sourceFiles)
    for (const task of tasks) {
      if (!task.files.length)
        throw new Error(`VerificationStageBrowserPopulationEmpty:${task.project}`)
      const files = tasksByProject.get(task.project) ?? new Set()
      for (const file of task.files) files.add(file)
      tasksByProject.set(task.project, files)
    }
  }
  const groups = browserTaskGroups(
    [...tasksByProject].map(([project, files]) => ({ project, files: [...files].sort() })),
  )
  const groupedStages = groups.map((group) => sliceBrowserStage(group))
  const projectGroups = new Map(
    groups.flatMap((group) =>
      group.tasks.map((task) => [task.project, `playwright-${group.name}`]),
    ),
  )
  const aliases = new Map(
    browserStages.map((item) => {
      const owners = new Set(
        (item.browserTasks?.map((task) => task.project) ?? item.browserProjects).map((project) =>
          projectGroups.get(project),
        ),
      )
      if (owners.size !== 1) throw new Error(`VerificationStageBrowserGroupAmbiguous:${item.id}`)
      return [item.id, [...owners][0]]
    }),
  )
  const emitted = new Set()
  const normalized = resolved.flatMap((item) => {
    const alias = aliases.get(item.id)
    if (alias) {
      if (emitted.has(alias)) return []
      emitted.add(alias)
      return [groupedStages.find((group) => group.id === alias)]
    }
    return [
      stage(item.id, item.label, item.policy, item.argv, {
        ...item,
        prerequisites: (item.prerequisites ?? []).map((dependency) => ({
          ...dependency,
          id: aliases.get(dependency.id) ?? dependency.id,
        })),
        ...(item.preparation === 'performance-evidence'
          ? {
              performanceStageAliases: Object.fromEntries(
                VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS.map((id) => [
                  id,
                  aliases.get(id) ?? id,
                ]),
              ),
            }
          : {}),
      }),
    ]
  })
  return resolveVerificationStagePrerequisites(
    normalized,
    [...catalog, ...groupedStages],
    fullUnit ? new Set(options.sourceFiles) : inputs,
  )
}

function sliceBrowserStage(group) {
  return stage(
    `playwright-${group.name}`,
    `Run ${group.name} browser proofs`,
    'blocking',
    ['node', 'scripts/run-verification.mjs', '--browser', group.name],
    {
      ...browserStageOptions(group.tasks.map((task) => task.project)),
      browserTasks: group.tasks,
      browserPhases: browserExecutionPhases(group.tasks),
    },
  )
}

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
  const stages = resolveVerificationStagePrerequisites(
    options.stages ?? VERIFICATION_STAGES,
    VERIFICATION_STAGES,
  ).map((item) => materializeBrowserStage(item, root))
  const metadata =
    options.metadata ?? (await collectVerificationMetadata({ root, environment: baseEnv }))
  const runId = options.runId ?? verificationRunId(options.now?.() ?? new Date())
  const artifactRoot = options.artifactRoot ?? root
  const runDirectory =
    options.runDirectory ?? resolve(artifactRoot, 'test-results/verification-stages', runId)
  let performanceEvidencePath = null
  const executeStage = (item, metadata) =>
    executeVerificationStage(item, metadata, {
      root,
      baseEnv,
      executionRuntime,
      testCompilerProof: options.testCompilerProof,
      artifactRoot,
      runDirectory,
      runId,
      performanceEvidencePath,
      ...(options.executeStage
        ? {
            executeProcess: (stage, _metadata, context) =>
              options.executeStage(stage, metadata, context),
          }
        : {}),
      forwardOutput: options.forwardOutput !== false,
      outputDestinations: options.outputDestinations,
    })
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
    printStageHeader(index, stages.length, item)
    const stageStartedAt = monotonicNow()
    const stageStartedCpu = cpuUsage()
    let execution
    try {
      const diagnostics = verificationPrerequisiteDiagnostics(item, results.slice(0, index))
      performanceEvidencePath = diagnostics.length
        ? null
        : await prepareVerificationStageExecution(item, {
            artifactRoot,
            runDirectory,
            runId,
            provenance: options.provenance ?? null,
            stages: results,
          })
      if (diagnostics.length > 0) {
        execution = {
          exitCode: null,
          signal: null,
          diagnostics,
          stdoutPath: null,
          stderrPath: null,
        }
      } else {
        execution = await executeStage(item, metadata)
      }
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

  const blockingFailures = results.filter(verificationStageBlocks)
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
  const blockingFailures = stages.filter(verificationStageBlocks).map((result) => result.id)
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

function materializeBrowserStage(item, root) {
  if (item.kind !== 'playwright') return item
  const tasks = item.browserTasks ?? fullBrowserTasks(item.browserProjects, browserSuiteFiles(root))
  const phases = browserExecutionPhases(tasks)
  if (item.browserPhases && JSON.stringify(item.browserPhases) !== JSON.stringify(phases))
    throw new Error(`VerificationBrowserPhasePlanMismatch:${item.id}`)
  return Object.freeze({ ...item, browserTasks: tasks, browserPhases: phases })
}

async function executeBrowserPhases(item, metadata, options) {
  const root = options.root ?? ROOT
  const artifactRoot = options.artifactRoot ?? root
  const runId = options.runId ?? 'verification'
  const runDirectory =
    options.runDirectory ?? resolve(artifactRoot, 'test-results/verification-stages', runId)
  const environment = verificationStageEnvironment(item, { ...options, root, runId, runDirectory })
  const receipts = []
  const diagnostics = []
  const stdoutPath = resolve(runDirectory, `${item.id}.stdout.log`)
  const stderrPath = resolve(runDirectory, `${item.id}.stderr.log`)
  await mkdir(runDirectory, { recursive: true })
  await writeFile(stdoutPath, '')
  await writeFile(stderrPath, '')
  for (const phase of item.browserPhases) {
    const child = {
      ...item,
      id: `${item.id}-${phase.name}`,
      argv: phase.argv,
      browserTasks: phase.tasks,
    }
    const childEnvironment = verificationStageEnvironment(child, {
      ...options,
      root,
      runId,
      runDirectory,
    })
    await rm(childEnvironment.E2E_BROWSER_PROOF_PATH, { force: true })
    const startedAt = performance.now()
    let execution
    try {
      execution = await executeVerificationStage(child, metadata, {
        ...options,
        root,
        artifactRoot,
        runDirectory,
        runId,
        executionId: child.id,
        browserPhase: true,
      })
    } catch (error) {
      execution = {
        exitCode: null,
        signal: null,
        diagnostics: [String(error)],
        stdoutPath: null,
        stderrPath: null,
      }
    }
    diagnostics.push(...execution.diagnostics)
    let proof = null
    try {
      proof = JSON.parse(await readFile(childEnvironment.E2E_BROWSER_PROOF_PATH, 'utf8'))
    } catch (error) {
      diagnostics.push(`VerificationBrowserPhaseReceipt:${child.id}:${String(error)}`)
    }
    receipts.push({
      name: phase.name,
      tasks: phase.tasks,
      argv: phase.argv,
      ...execution,
      wallMs: performance.now() - startedAt,
      proof,
    })
    for (const [key, target] of [
      ['stdoutPath', stdoutPath],
      ['stderrPath', stderrPath],
    ]) {
      if (execution[key]) {
        try {
          await appendFile(target, await readFile(resolve(artifactRoot, execution[key])))
        } catch (error) {
          diagnostics.push(`VerificationBrowserPhaseLog:${child.id}:${String(error)}`)
        }
      }
    }
    if (execution.signal !== null) break
  }
  const report = reconcileBrowserPhaseProofs(item.browserTasks, receipts)
  diagnostics.push(...report.problems)
  await writeFile(
    environment.E2E_BROWSER_PROOF_PATH,
    `${JSON.stringify({ ...report, status: diagnostics.length ? 'failed' : report.status, problems: diagnostics, phases: receipts }, null, 2)}\n`,
  )
  return {
    exitCode: report.status === 'passed' && diagnostics.length === 0 ? 0 : 1,
    signal: receipts.find((phase) => phase.signal !== null)?.signal ?? null,
    diagnostics,
    stdoutPath: relative(artifactRoot, stdoutPath),
    stderrPath: relative(artifactRoot, stderrPath),
  }
}

export async function executeVerificationStage(item, metadata, options = {}) {
  if (item.kind === 'playwright' && !options.browserPhase)
    return executeBrowserPhases(
      materializeBrowserStage(item, options.root ?? ROOT),
      metadata,
      options,
    )
  if (item.compilerProof && options.testCompilerProof) return options.testCompilerProof(item)
  if (item.argv[0] === 'internal') {
    if (!metadata) throw new Error('VerificationEnvironmentMetadataRequired')
    return { ...validateEnvironment(metadata), stdoutPath: null, stderrPath: null }
  }
  const root = options.root ?? ROOT
  const baseEnv = options.baseEnv ?? process.env
  const invocation = createVerificationRuntimeInvocation(item.argv, options.executionRuntime)
  const artifactRoot = options.artifactRoot ?? root
  const runId = options.runId ?? 'verification'
  const runDirectory =
    options.runDirectory ?? resolve(artifactRoot, 'test-results/verification-stages', runId)
  const environment = verificationStageEnvironment(item, {
    root,
    baseEnv,
    runId,
    runDirectory,
    performanceEvidencePath: options.performanceEvidencePath,
  })
  const context = { root, artifactRoot, runId, runDirectory, environment }
  const execution = options.executeProcess
    ? await options.executeProcess(item, metadata, context)
    : await executeFileBackedVerificationProcess({
        id: options.executionId ?? item.id,
        command: invocation.command,
        args: invocation.args,
        cwd: root,
        environment,
        artifactRoot,
        runDirectory,
        diagnosticPrefix: options.diagnosticPrefix ?? 'VerificationStage',
        forwardOutput: options.forwardOutput !== false,
        outputDestinations: options.outputDestinations,
      })
  return verifyVerificationStageExecution(item, execution, {
    root,
    artifactRoot,
    environment,
  })
}

export async function prepareVerificationStageExecution(item, options) {
  if (item.preparation !== 'performance-evidence') return null
  return (
    await persistVerificationPerformanceEvidence({
      ...options,
      stageAliases: item.performanceStageAliases,
    })
  ).path
}

export async function verifyVerificationStageExecution(item, execution, options) {
  const environment = options.environment
  if (item.kind === 'vitest' && execution.exitCode === 0) {
    try {
      readVitestProof(
        environment.VERIFICATION_VITEST_PROOF_PATH,
        item.unitFiles ?? vitestSuiteFiles({ root: options.root }),
        environment.VERIFICATION_VITEST_INVOCATION,
      )
    } catch (error) {
      return { ...execution, exitCode: 1, diagnostics: [...execution.diagnostics, String(error)] }
    }
  }
  if (item.kind === 'playwright' && execution.exitCode === 0) {
    try {
      readBrowserProof(
        environment.E2E_BROWSER_PROOF_PATH,
        item.browserTasks ??
          fullBrowserTasks(item.browserProjects, browserSuiteFiles(options.root)),
      )
    } catch (error) {
      return { ...execution, exitCode: 1, diagnostics: [...execution.diagnostics, String(error)] }
    }
  }
  if (item.stderr !== 'empty' || execution.stderrPath == null) return execution
  const stderr = await readFile(resolve(options.artifactRoot, execution.stderrPath), 'utf8')
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
  if (item.environment) return { ...item.environment }
  const root = options.root ?? ROOT
  const baseEnv = options.baseEnv ?? process.env
  const environment = verificationChildEnvironment({
    kind: item.kind ?? item.id,
    root,
    runId: options.runId ?? String(process.pid),
    baseEnv: { ...FIXED_CHILD_ENV, ...baseEnv },
  })
  for (const flag of item.nodeOptions ?? []) {
    const flags = environment.NODE_OPTIONS?.split(/\s+/u) ?? []
    if (!flags.includes(flag)) environment.NODE_OPTIONS = [...flags, flag].filter(Boolean).join(' ')
  }
  environment.VERIFICATION_RUN_ID = options.runId ?? String(process.pid)
  if (item.kind === 'vitest') {
    environment.VERIFICATION_VITEST_INVOCATION = randomUUID()
    environment.VERIFICATION_VITEST_PROOF_PATH = resolve(
      options.runDirectory ??
        resolve(root, 'test-results/verification-stages', options.runId ?? String(process.pid)),
      `${item.id}.proof.json`,
    )
    delete environment.VERIFICATION_VITEST_SELECTION
    if (item.unitFiles) environment.VERIFICATION_VITEST_SELECTION = JSON.stringify(item.unitFiles)
  }
  if (item.kind === 'playwright') {
    environment.E2E_SKIP_BUILD = '1'
    environment.E2E_PLAYWRIGHT_OUTPUT_DIR = resolve(
      options.runDirectory ??
        resolve(root, 'test-results/verification-stages', options.runId ?? String(process.pid)),
      `${item.id}.playwright`,
    )
    environment.E2E_BROWSER_PROOF_PATH = `${environment.E2E_PLAYWRIGHT_OUTPUT_DIR}.proof.json`
    const projects = item.browserTasks?.map((task) => task.project) ?? item.browserProjects
    delete environment.E2E_BROWSER_SELECTION
    delete environment.E2E_BROWSER_PROJECTS
    if (item.browserTasks) environment.E2E_BROWSER_SELECTION = JSON.stringify(item.browserTasks)
    else environment.E2E_BROWSER_PROJECTS = JSON.stringify(projects)
    for (const project of playwrightProjects()) {
      if (projects.includes(project.name) && project.activation)
        environment[project.activation] = '1'
    }
  }
  if (item.preparation === 'performance-evidence' && options.performanceEvidencePath) {
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
  const assurance = assuranceKind(item)
  return {
    id: item.id,
    label: item.label,
    policy: item.policy,
    argv: [...item.argv],
    assurance,
    status: verificationStageStatus(item, execution),
    exitCode: execution.exitCode,
    signal: execution.signal,
    diagnostics: [...execution.diagnostics],
    timing: Object.freeze({ ...timing }),
    stdoutPath: execution.stdoutPath ?? null,
    stderrPath: execution.stderrPath ?? null,
    evidence: execution.evidence ?? null,
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
  if (result.evidence)
    console.log(
      `[verify] reused ${result.evidence.kind} proof ${result.evidence.compilerCohortDigest}`,
    )
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

export function directBrowserVerificationStages(selection, files) {
  const group = browserGroupProjects(selection)
  const names = group.length ? group : [selection]
  const tasks = fullBrowserTasks(names, files)
  return browserTaskGroups(tasks).map(sliceBrowserStage)
}

function parseCliArgs(argv) {
  if (argv.length === 0) return { dryRun: false }
  if (argv.length === 2 && argv[0] === '--browser') return { browser: argv[1] }
  if (argv.length === 1 && argv[0] === '--dry-run') return { dryRun: true }
  throw new Error(`Unknown verification runner arguments: ${argv.join(' ')}`)
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2))
  const stages = cli.browser
    ? directBrowserVerificationStages(cli.browser, browserSuiteFiles(ROOT))
    : undefined
  const result = await runVerification({ ...cli, ...(stages ? { stages } : {}) })
  process.exitCode = result.exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
