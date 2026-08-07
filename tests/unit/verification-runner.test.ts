import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECKPOINT_REQUIRED_STAGE_IDS,
  collectVerificationMetadata,
  executeVerificationStage,
  runVerification,
  serializeVerificationSummary,
  VERIFICATION_STAGES,
  type VerificationExecution,
  type VerificationMetadata,
  type VerificationStage,
  type VerificationSummary,
  verificationStageEnvironment,
} from '../../scripts/run-verification.mjs'
import {
  persistVerificationPerformanceEvidence,
  validateVerificationPerformanceEvidence,
} from '../../scripts/verification-performance-evidence.mjs'
import { createVerificationRuntimeInvocation } from '../../scripts/verification-process-execution.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe('verification runner', () => {
  it('keeps peer dependency drift advisory and makes repository hygiene blocking', () => {
    expect(
      VERIFICATION_STAGES.filter((stage) => stage.policy === 'advisory').map((stage) => stage.id),
    ).toEqual(['peer-dependencies'])
    expect(
      VERIFICATION_STAGES.filter((stage) => stage.policy === 'blocking').map((stage) => stage.id),
    ).toEqual([
      'environment',
      'application-typescript',
      'test-typescript',
      'current-wave-ownership',
      'formatting',
      'semantic-lint',
      'general-dead-code',
      'production-reachability',
      'production-module-inventory',
      'verification-assurance',
      'architecture-coverage',
      'protocol-contracts',
      'production-export-classification',
      'presentation-store-boundary',
      'production-coordination',
      'production-runtime-effects',
      'production-async-ownership',
      'hidden-tab-visual-continuity',
      'scroll-continuity',
      'startup-readiness',
      'storage-ownership-reclamation',
      'production-dependency-graph',
      'production-duplication',
      'production-time',
      'production-time-semantics',
      'production-work-memory',
      'e2e-browser-storage',
      'test-evidence',
      'interaction-capabilities',
      'architecture-inventory-closure',
      'production-build',
      'vitest',
      'chromium-e2e',
      'firefox-e2e',
      'headed-hidden-tab-visual-continuity',
      'dev-preview-parity',
      'stream-profile-single',
      'stream-profile-concurrent',
      'performance',
    ])
    expect(VERIFICATION_STAGES.every((stage) => Object.isFrozen(stage.argv))).toBe(true)
    expect(VERIFICATION_STAGES.find((stage) => stage.id === 'vitest')?.stderr).toBe('empty')
  })

  it('runs every independent stage after advisory and blocking failures', async () => {
    const stages = [
      verificationStage('advisory-failure', 'advisory'),
      verificationStage('blocking-failure', 'blocking'),
      verificationStage('later-success', 'blocking'),
    ]
    const calls: string[] = []
    const persisted: string[] = []
    const executions = new Map<string, VerificationExecution>([
      ['advisory-failure', failedExecution(2)],
      ['blocking-failure', failedExecution(3)],
      ['later-success', passedExecution()],
    ])

    const result = await runVerification({
      stages,
      metadata: verificationMetadata(),
      executeStage: async (stage) => {
        calls.push(stage.id)
        return executions.get(stage.id) ?? failedExecution(null)
      },
      persistSummary: async (summary) => {
        persisted.push(serializeVerificationSummary(summary))
      },
    })

    expect(calls).toEqual(['advisory-failure', 'blocking-failure', 'later-success'])
    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('failed')
    expect(result.summary.advisoryFailures).toEqual(['advisory-failure'])
    expect(result.summary.blockingFailures).toEqual(['blocking-failure'])
    expect(persisted).toHaveLength(stages.length + 2)
    const serialized = serializeVerificationSummary(result.summary)
    const parsed: unknown = JSON.parse(serialized)
    expect(parsed).toEqual(result.summary)
  })

  it('returns success when only advisory stages fail', async () => {
    const result = await runVerification({
      stages: [
        verificationStage('advisory-failure', 'advisory'),
        verificationStage('blocking-success', 'blocking'),
      ],
      metadata: verificationMetadata(),
      executeStage: async (stage) =>
        stage.policy === 'advisory' ? failedExecution(1) : passedExecution(),
      persistSummary: async () => undefined,
    })

    expect(result.exitCode).toBe(0)
    expect(result.summary.outcome).toBe('passed')
    expect(result.summary.advisoryFailures).toEqual(['advisory-failure'])
    expect(result.summary.blockingFailures).toEqual([])
  })

  it('records monotonic stage and aggregate verification cost', async () => {
    let now = 100
    const cpuSnapshots: Array<NodeJS.CpuUsage | undefined> = []
    const result = await runVerification({
      stages: [verificationStage('measured', 'blocking')],
      metadata: verificationMetadata(),
      executeStage: async () => {
        now += 17
        return passedExecution()
      },
      persistSummary: async () => undefined,
      monotonicNow: () => now,
      cpuUsage: (previous) => {
        cpuSnapshots.push(previous)
        return previous ? { user: 2_000, system: 1_000 } : { user: 0, system: 0 }
      },
    })

    expect(result.summary.schemaVersion).toBe(4)
    expect(result.summary.stages[0]?.timing).toEqual({
      wallMs: 17,
      runnerCpuUserMs: 2,
      runnerCpuSystemMs: 1,
    })
    expect(result.summary.timing).toEqual({
      wallMs: 17,
      runnerCpuUserMs: 2,
      runnerCpuSystemMs: 1,
    })
    expect(cpuSnapshots.filter((snapshot) => snapshot !== undefined)).toHaveLength(5)
    expect(cpuSnapshots.filter((snapshot) => snapshot === undefined)).toHaveLength(2)
  })

  it('keeps the Node 26 localStorage file scoped to the Vitest child', () => {
    const root = '/workspace'
    const runDirectory = '/evidence/current-run'
    const vitest = VERIFICATION_STAGES.find((stage) => stage.id === 'vitest')
    const browser = VERIFICATION_STAGES.find((stage) => stage.id === 'chromium-e2e')
    const firefox = VERIFICATION_STAGES.find((stage) => stage.id === 'firefox-e2e')
    const headed = VERIFICATION_STAGES.find(
      (stage) => stage.id === 'headed-hidden-tab-visual-continuity',
    )
    const parity = VERIFICATION_STAGES.find((stage) => stage.id === 'dev-preview-parity')
    if (!vitest || !browser || !firefox || !headed || !parity) {
      throw new Error('VerificationRuntimeStageMissing')
    }
    const vitestEnv = verificationStageEnvironment(vitest, {
      root,
      runDirectory,
      baseEnv: {
        E2E_FAKE_PROVIDER_PORT: '29001',
        E2E_PORT: '29000',
        NODE_OPTIONS: '--trace-warnings',
      },
    })
    const browserEnv = verificationStageEnvironment(browser, {
      root,
      runDirectory,
      baseEnv: { NODE_OPTIONS: '--trace-warnings' },
    })
    const firefoxEnv = verificationStageEnvironment(firefox, {
      root,
      runDirectory,
      baseEnv: { NODE_OPTIONS: '--trace-warnings' },
    })
    const headedEnv = verificationStageEnvironment(headed, {
      root,
      runDirectory,
      baseEnv: { NODE_OPTIONS: '--trace-warnings' },
    })
    const parityEnv = verificationStageEnvironment(parity, {
      root,
      runDirectory,
      baseEnv: {
        E2E_DEV_PORT: '29002',
        E2E_FAKE_PROVIDER_PORT: '29001',
        E2E_PORT: '29000',
        NODE_OPTIONS: '--trace-warnings',
      },
    })

    expect(vitestEnv.NODE_OPTIONS).toContain('--trace-warnings')
    expect(vitestEnv.NODE_OPTIONS).toContain('--localstorage-file=/workspace/test-results/')
    expect(browserEnv.NODE_OPTIONS).toBe('--trace-warnings')
    expect(vitestEnv.E2E_PORT).toBe('29000')
    expect(vitestEnv.E2E_FAKE_PROVIDER_PORT).toBe('29001')
    expect(browserEnv.E2E_REUSE_EXISTING_SERVER).toBe('0')
    expect(browserEnv.E2E_SERIALIZE_LARGE_WORKSPACE_CLOSURE).toBe('1')
    expect(browserEnv.E2E_SKIP_BUILD).toBe('1')
    expect(firefoxEnv.E2E_SKIP_BUILD).toBe('1')
    expect(headedEnv.E2E_SKIP_BUILD).toBe('1')
    expect(browserEnv.E2E_PLAYWRIGHT_OUTPUT_DIR).toBe(
      '/evidence/current-run/chromium-e2e.playwright',
    )
    expect(firefoxEnv.E2E_PLAYWRIGHT_OUTPUT_DIR).toBe(
      '/evidence/current-run/firefox-e2e.playwright',
    )
    expect(headedEnv.E2E_PLAYWRIGHT_OUTPUT_DIR).toBe(
      '/evidence/current-run/headed-hidden-tab-visual-continuity.playwright',
    )
    expect(parityEnv.E2E_PLAYWRIGHT_OUTPUT_DIR).toBe(
      '/evidence/current-run/dev-preview-parity.playwright',
    )
    expect(
      new Set([
        browserEnv.E2E_PLAYWRIGHT_OUTPUT_DIR,
        firefoxEnv.E2E_PLAYWRIGHT_OUTPUT_DIR,
        headedEnv.E2E_PLAYWRIGHT_OUTPUT_DIR,
        parityEnv.E2E_PLAYWRIGHT_OUTPUT_DIR,
      ]).size,
    ).toBe(4)
    expect(browserEnv.E2E_DEV_PREVIEW_PARITY).toBeUndefined()
    expect(parityEnv.E2E_SKIP_BUILD).toBe('1')
    expect(parityEnv.E2E_DEV_PREVIEW_PARITY).toBe('1')
    expect(parityEnv.E2E_DEV_PORT).toBe('29002')
    expect(vitestEnv.E2E_SKIP_BUILD).toBeUndefined()
    expect(vitestEnv.E2E_DEV_PREVIEW_PARITY).toBeUndefined()
    expect(vitestEnv.E2E_PLAYWRIGHT_OUTPUT_DIR).toBeUndefined()
    expect(browser.argv).toEqual([
      'pnpm',
      'exec',
      'playwright',
      'test',
      '--project=chromium',
      '--project=chromium-large-workspace',
    ])
    expect(firefox.argv).toEqual(['pnpm', 'exec', 'playwright', 'test', '--project=firefox'])
    expect(headed.argv).toEqual(['pnpm', 'run', 'e2e:headed-visibility'])
    expect(parity.argv).toEqual([
      'pnpm',
      'exec',
      'playwright',
      'test',
      '--project=chromium-preview-parity',
      '--project=chromium-dev-parity',
    ])
    expect(VERIFICATION_STAGES.find((stage) => stage.id === 'stream-profile-single')?.argv).toEqual(
      ['node', 'scripts/profile-fake-stream.mjs', '--serve-preview'],
    )
    expect(
      VERIFICATION_STAGES.find((stage) => stage.id === 'stream-profile-concurrent')?.argv,
    ).toEqual(['node', 'scripts/profile-concurrent-fake-stream.mjs', '--serve-preview'])
  })

  it('persists exact same-run performance inputs before the reporter executes', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-verification-performance-'))
    temporaryRoots.push(root)
    const runDirectory = resolve(root, 'run')
    const stages = [
      verificationStage('production-build', 'blocking'),
      verificationStage('vitest', 'blocking'),
      verificationStage('chromium-e2e', 'blocking'),
      verificationStage('firefox-e2e', 'blocking'),
      verificationStage('stream-profile-single', 'blocking'),
      verificationStage('stream-profile-concurrent', 'blocking'),
      verificationStage('performance', 'blocking'),
    ]

    await runVerification({
      artifactRoot: root,
      runDirectory,
      runId: 'candidate-proof',
      provenance: { candidateId: 'candidate-proof' },
      stages,
      metadata: verificationMetadata(),
      executeStage: async (stage) => ({
        ...passedExecution(),
        stdoutPath: stage.id.startsWith('stream-profile-') ? `run/${stage.id}.stdout.log` : null,
        stderrPath: null,
      }),
      persistSummary: async () => undefined,
    })

    const evidence = validateVerificationPerformanceEvidence(
      JSON.parse(await readFile(resolve(runDirectory, 'performance-input.json'), 'utf8')),
      'candidate-proof',
    )
    expect(evidence).toMatchObject({
      runId: 'candidate-proof',
      provenance: { candidateId: 'candidate-proof' },
      stages: [
        { id: 'production-build', status: 'passed' },
        { id: 'vitest', status: 'passed' },
        { id: 'chromium-e2e', status: 'passed' },
        { id: 'firefox-e2e', status: 'passed' },
        {
          id: 'stream-profile-single',
          status: 'passed',
          stdoutArtifact: 'stream-profile-single.stdout.log',
        },
        {
          id: 'stream-profile-concurrent',
          status: 'passed',
          stdoutArtifact: 'stream-profile-concurrent.stdout.log',
        },
      ],
    })
    expect(evidence.stages.every((stage: { timing: unknown }) => stage.timing !== null)).toBe(true)
  })

  it('rejects stale run provenance and profile artifacts outside the candidate run', async () => {
    expect(() =>
      validateVerificationPerformanceEvidence(
        {
          schemaVersion: 1,
          kind: 'verification-performance-evidence',
          runId: 'old-run',
          stages: [],
        },
        'current-run',
      ),
    ).toThrow('VerificationPerformanceEvidenceRunMismatch')

    const root = await mkdtemp(resolve(tmpdir(), 'natter-verification-performance-path-'))
    temporaryRoots.push(root)
    await expect(
      persistVerificationPerformanceEvidence({
        artifactRoot: root,
        runDirectory: resolve(root, 'run'),
        runId: 'candidate-proof',
        stages: [
          {
            id: 'stream-profile-single',
            label: 'single',
            policy: 'blocking',
            argv: [],
            assurance: 'runtime',
            status: 'passed',
            exitCode: 0,
            signal: null,
            diagnostics: [],
            timing: { wallMs: 1, runnerCpuUserMs: 0, runnerCpuSystemMs: 0 },
            stdoutPath: 'outside-profile.json',
            stderrPath: null,
          },
        ],
      }),
    ).rejects.toThrow('VerificationPerformanceArtifactOutsideRun')
  })

  it('reads environment metadata from the exact candidate execution environment', async () => {
    const metadata = await collectVerificationMetadata({
      root: resolve(__dirname, '../..'),
      nodeVersion: '26.1.0',
      pnpmVersion: '11.10.0',
      environment: {
        CI: '1',
        E2E_FAKE_PROVIDER_PORT: '31235',
        E2E_PORT: '31234',
        GITHUB_ACTIONS: 'true',
        RUNNER_OS: 'Linux',
        TZ: 'UTC',
      },
    })

    expect(metadata).toMatchObject({
      ci: true,
      e2ePort: 31234,
      fakeProviderPort: 31235,
      githubActions: true,
      nodeVersion: '26.1.0',
    })
  })

  it('binds Node and pnpm stages to the exact candidate runtime', () => {
    const runtime = {
      nodeExecutablePath: '/runtime/node',
      pnpmExecutablePath: '/runtime/pnpm.mjs',
    }
    expect(createVerificationRuntimeInvocation(['node', 'script.mjs'], runtime)).toEqual({
      command: '/runtime/node',
      args: ['script.mjs'],
    })
    expect(createVerificationRuntimeInvocation(['pnpm', 'exec', 'vitest', 'run'], runtime)).toEqual(
      {
        command: '/runtime/node',
        args: [
          '/runtime/pnpm.mjs',
          '--config.manage-package-manager-versions=false',
          'exec',
          'vitest',
          'run',
        ],
      },
    )
  })

  it('retains file-backed stage logs under the external evidence root', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-verification-runner-'))
    temporaryRoots.push(root)
    const stage = Object.freeze({
      id: 'file-backed',
      label: 'file-backed',
      policy: 'blocking' as const,
      argv: Object.freeze([
        'node',
        '-e',
        "process.stdout.write('stage-output');process.stderr.write('stage-error')",
      ]),
    })
    const execution = await executeVerificationStage(stage, verificationMetadata(), {
      root,
      artifactRoot: root,
      runId: 'external-evidence',
      forwardOutput: false,
    })
    if (!execution.stdoutPath || !execution.stderrPath) throw new Error('StageLogPathMissing')

    expect(await readFile(resolve(root, execution.stdoutPath), 'utf8')).toBe('stage-output')
    expect(await readFile(resolve(root, execution.stderrPath), 'utf8')).toBe('stage-error')
  })

  it('makes unexpected stderr red for a stage that requires a clean diagnostic channel', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-verification-stderr-'))
    temporaryRoots.push(root)
    const stage = Object.freeze({
      id: 'warning-clean',
      label: 'warning-clean',
      policy: 'blocking' as const,
      stderr: 'empty' as const,
      argv: Object.freeze(['node', '-e', "process.stderr.write('unexpected-warning')"]),
    })
    const execution = await executeVerificationStage(stage, verificationMetadata(), {
      root,
      artifactRoot: root,
      runId: 'warning-clean',
      forwardOutput: false,
    })

    expect(execution.exitCode).toBe(1)
    expect(execution.diagnostics).toEqual([
      `VerificationStageUnexpectedStderr:warning-clean:${'unexpected-warning'.length}`,
    ])
  })

  it('runs final validation after every stage and persists validation failure as canonical red', async () => {
    const phases: string[] = []
    const persisted: VerificationSummary[] = []
    const result = await runVerification({
      stages: [verificationStage('first', 'blocking'), verificationStage('second', 'blocking')],
      metadata: verificationMetadata(),
      executeStage: async (stage) => {
        phases.push(stage.id)
        return passedExecution()
      },
      finalValidator: () => {
        phases.push('final-validator')
        throw new Error('CandidateChanged')
      },
      persistSummary: async (summary) => {
        persisted.push(summary)
      },
    })

    expect(phases).toEqual(['first', 'second', 'final-validator'])
    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('failed')
    expect(result.summary.infrastructureDiagnostics).toEqual([
      'VerificationFinalValidationFailed:Error:CandidateChanged',
    ])
    expect(persisted.at(-1)?.outcome).toBe('failed')
  })

  it('continues independent stages after summary persistence fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    const result = await runVerification({
      stages: [verificationStage('first', 'blocking'), verificationStage('second', 'blocking')],
      metadata: verificationMetadata(),
      executeStage: async (stage) => {
        calls.push(stage.id)
        return passedExecution()
      },
      persistSummary: async () => {
        throw new DOMException('write failed', 'QuotaExceededError')
      },
    })

    expect(calls).toEqual(['first', 'second'])
    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('failed')
    expect(result.summary.infrastructureDiagnostics).toEqual([
      'VerificationSummaryPersistenceFailed:initial:QuotaExceededError',
      'VerificationSummaryPersistenceFailed:stage:first:QuotaExceededError',
      'VerificationSummaryPersistenceFailed:stage:second:QuotaExceededError',
      'VerificationSummaryPersistenceFailed:final:QuotaExceededError',
    ])
    expect(error.mock.calls.map(([message]) => String(message))).toEqual(
      result.summary.infrastructureDiagnostics.map((diagnostic) => `[verify] ${diagnostic}`),
    )
    error.mockRestore()
  })

  it('reports structural inventory completion without calling it a passed guarantee', async () => {
    const inventoryStage = Object.freeze({
      id: 'inventory-only',
      label: 'inventory-only',
      policy: 'blocking' as const,
      argv: Object.freeze(['node', 'inventory-only.mjs', '--mode', 'inventory']),
    })
    const result = await runVerification({
      stages: [inventoryStage],
      metadata: verificationMetadata(),
      executeStage: async () => passedExecution(),
      persistSummary: async () => undefined,
    })

    expect(result.exitCode).toBe(0)
    expect(result.summary.outcome).toBe('completed-with-open-inventories')
    expect(result.summary.stages[0]).toMatchObject({
      assurance: 'inventory',
      status: 'inventoried',
    })
    expect(result.summary.assurance).toEqual({
      hygiene: [],
      inventories: ['inventory-only'],
      guarantees: [],
      runtimeProofs: [],
    })
  })

  it('uses typed required stages for checkpoint completion without relabeling inventories', async () => {
    const inventoryStage = Object.freeze({
      id: 'inventory-only',
      label: 'inventory-only',
      policy: 'blocking' as const,
      argv: Object.freeze(['node', 'inventory-only.mjs', '--mode', 'inventory']),
    })
    const requiredStage = verificationStage('required-guarantee', 'blocking')
    const result = await runVerification({
      stages: [inventoryStage, requiredStage],
      requiredStageIds: ['required-guarantee'],
      metadata: verificationMetadata(),
      executeStage: async () => passedExecution(),
      persistSummary: async () => undefined,
    })

    expect(result.exitCode).toBe(0)
    expect(result.summary.outcome).toBe('passed')
    expect(result.summary.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'inventory-only', status: 'inventoried' }),
        expect.objectContaining({ id: 'required-guarantee', status: 'passed' }),
      ]),
    )
    expect(CHECKPOINT_REQUIRED_STAGE_IDS).toEqual(
      VERIFICATION_STAGES.filter(
        (stage) =>
          stage.policy === 'blocking' &&
          !stage.argv.some(
            (arg, index) => arg === '--mode' && stage.argv[index + 1] === 'inventory',
          ),
      ).map((stage) => stage.id),
    )
  })

  it('makes an omitted required checkpoint stage canonical red', async () => {
    const result = await runVerification({
      stages: [verificationStage('present', 'blocking')],
      requiredStageIds: ['present', 'missing'],
      metadata: verificationMetadata(),
      executeStage: async () => passedExecution(),
      persistSummary: async () => undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('failed')
    expect(result.summary.infrastructureDiagnostics).toContain(
      'VerificationRequiredStageMissing:missing',
    )
  })

  it('records pinned runtime mismatches as blocking without suppressing later stages', async () => {
    const environment = VERIFICATION_STAGES.find((stage) => stage.id === 'environment')
    if (!environment) throw new Error('EnvironmentVerificationStageMissing')
    const later = verificationStage('later-success', 'blocking')
    const result = await runVerification({
      stages: [environment, later],
      metadata: { ...verificationMetadata(), nodeVersion: '26.0.0' },
      executeStage: async (stage, metadata) =>
        stage.id === 'environment'
          ? {
              exitCode: metadata.nodeVersion === metadata.expectedNodeVersion ? 0 : 1,
              signal: null,
              diagnostics: ['NodeVersionMismatch'],
            }
          : passedExecution(),
      persistSummary: async () => undefined,
    })

    expect(result.summary.blockingFailures).toEqual(['environment'])
    expect(result.summary.stages.find((stage) => stage.id === 'later-success')?.status).toBe(
      'passed',
    )
  })
})

function verificationStage(id: string, policy: VerificationStage['policy']): VerificationStage {
  return Object.freeze({
    id,
    label: id,
    policy,
    argv: Object.freeze(['node', `${id}.mjs`]),
  })
}

function verificationMetadata(): VerificationMetadata {
  return {
    nodeVersion: '26.1.0',
    expectedNodeVersion: '26.1.0',
    pnpmVersion: '11.10.0',
    expectedPnpmVersion: '11.10.0',
    playwrightVersion: '1.61.1',
    platform: 'linux',
    architecture: 'x64',
    ci: true,
    githubActions: true,
    runnerOs: 'Linux',
    timezone: 'UTC',
    e2ePort: 4173,
    fakeProviderPort: 4174,
    metadataDiagnostics: [],
  }
}

function passedExecution(): VerificationExecution {
  return { exitCode: 0, signal: null, diagnostics: [] }
}

function failedExecution(exitCode: number | null): VerificationExecution {
  return { exitCode, signal: null, diagnostics: ['expected test failure'] }
}
