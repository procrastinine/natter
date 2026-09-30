import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertSliceVerificationExecutionReady,
  createSliceTaskBatches,
  executePreparedSliceVerification,
  type SliceBatchExecution,
  type SliceTaskBatch,
} from '../../scripts/run-slice-verification.mjs'
import {
  compileSliceVerificationStages,
  runVerification,
  VERIFICATION_STAGES,
  type VerificationMetadata,
  type VerificationStage,
} from '../../scripts/run-verification.mjs'
import { createVerificationCandidateEnvironment } from '../../scripts/verification-candidate-execution.mjs'
import type { MaterializedVerificationCandidate } from '../../scripts/verification-candidate-workspace.mjs'
import type {
  SliceVerificationPlan,
  VerificationSnapshot,
} from '../../scripts/verification-impact-plan.mjs'
import {
  readVerificationPerformanceEvidence,
  VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS,
} from '../../scripts/verification-performance-evidence.mjs'
import { verificationChildEnvironment } from '../../scripts/verification-process-execution.mjs'
import { verificationStage } from '../../scripts/verification-stage-contract.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe('verification slice runner', () => {
  it('prepares the same exact performance input receipt before the slice report runs', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-slice-performance-proof-'))
    temporaryRoots.push(root)
    const inputs = VERIFICATION_PERFORMANCE_REQUIRED_STAGE_IDS
    const report = verificationStage(
      'performance',
      'report',
      'blocking',
      ['node', 'scripts/report-performance-baseline.mjs'],
      {
        preparation: 'performance-evidence',
        prerequisites: inputs.map((id) => ({ id, propagateImpact: false })),
      },
    )
    const stages = [
      ...inputs.map((id) => verificationStage(id, id, 'blocking', ['node', `scripts/${id}.mjs`])),
      { ...report, prerequisiteIds: inputs },
    ]
    const current = verificationSnapshot('current')
    const calls: string[] = []
    const result = await executePreparedSliceVerification({
      baselineId: 'same-performance-contract',
      evidenceRoot: root,
      runtimeRoot: root,
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: { ...verificationPlan({}), stages },
      },
      executeBatch: async (batch, options) => {
        calls.push(batch.stage.id)
        if (batch.stage.id === 'performance') {
          const path = options.environment.VERIFICATION_PERFORMANCE_INPUT
          if (!path) throw new Error('PerformanceInputMissing')
          const { evidence } = await readVerificationPerformanceEvidence(
            path,
            options.environment.VERIFICATION_RUN_ID,
          )
          expect(evidence.stages.map(({ id }) => id)).toEqual(inputs)
          expect(evidence.stages.every(({ status }) => status === 'passed')).toBe(true)
          expect(evidence.stages.map(({ executionStageId }) => executionStageId)).toEqual(inputs)
          expect(
            evidence.stages.every(
              ({ timing }) => typeof timing?.wallMs === 'number' && timing.runnerCpuUserMs === null,
            ),
          ).toBe(true)
        }
        return {
          ...batchExecution(0),
          stdoutPath: batch.stage.id.startsWith('stream-profile-')
            ? relative(root, resolve(options.runDirectory, `${batch.id}.stdout.log`))
            : null,
        }
      },
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
    })
    expect(calls).toEqual([...inputs, 'performance'])
    expect(result.exitCode).toBe(0)
  })

  it('keeps the workspace entry fail-closed without coupling the injected plan executor to it', () => {
    expect(() =>
      assertSliceVerificationExecutionReady({
        id: 'wave-test',
        mode: 'breaking-migration',
        sourceObligations: ['adapt-preserved-tests'],
        costObligations: [],
      }),
    ).toThrow('VerificationCandidateBeforeSourceFreeze:breaking-migration:adapt-preserved-tests')
    expect(() =>
      assertSliceVerificationExecutionReady({
        id: 'wave-test',
        mode: 'coherence/gate',
        sourceObligations: ['adapt-preserved-tests'],
        costObligations: [],
      }),
    ).toThrow('VerificationCandidateBeforeSourceFreeze:coherence/gate:adapt-preserved-tests')
    expect(() =>
      assertSliceVerificationExecutionReady({
        id: 'wave-test',
        mode: 'coherence/gate',
        sourceObligations: [],
        costObligations: ['github-suite', 'browser-stress'],
      }),
    ).not.toThrow()
  })

  it('keeps the prepared executor behind the guarded production entry point', async () => {
    const scriptsRoot = resolve(__dirname, '../../scripts')
    const importers: string[] = []
    for (const name of await readdir(scriptsRoot)) {
      if (!name.endsWith('.mjs') || name === 'run-slice-verification.mjs') continue
      const source = await readFile(resolve(scriptsRoot, name), 'utf8')
      if (source.includes('executePreparedSliceVerification')) importers.push(name)
    }
    expect(importers).toEqual([])
  })

  it('builds once and batches compatible browser projects with exact selection', () => {
    const batches = createSliceTaskBatches(
      verificationPlan({
        node: [
          { id: 'first', argv: ['scripts/first.mjs'] },
          { id: 'second', argv: ['scripts/second.mjs'] },
        ],
        vitest: ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'],
        playwright: [
          { project: 'chromium', files: ['tests/e2e/a.spec.ts', 'tests/e2e/b.spec.ts'] },
          {
            project: 'large-workspace-setup',
            files: ['tests/e2e/large-workspace.setup.ts'],
          },
          { project: 'chromium-large-workspace', files: ['tests/e2e/large.spec.ts'] },
        ],
      }),
    )

    expect(batches.map((batch) => batch.id)).toEqual([
      'production-build',
      'vitest',
      'playwright-chromium',
      'node-first',
      'node-second',
    ])
    expect(batches.find((batch) => batch.id === 'vitest')?.args).toEqual([
      '--config.manage-package-manager-versions=false',
      'exec',
      'vitest',
      'run',
      'tests/unit/a.test.ts',
      'tests/unit/b.test.ts',
    ])
    expect(batches.find((batch) => batch.id === 'playwright-chromium')?.args).toEqual([
      'scripts/run-verification.mjs',
      '--browser',
      'chromium',
    ])
  })

  it('constructs every catalog batch with its bound runtime, including in-process validation', () => {
    const batches = createSliceTaskBatches(
      { ...verificationPlan(), stages: VERIFICATION_STAGES },
      { nodeExecutablePath: '/runtime/node', pnpmExecutablePath: '/runtime/pnpm.mjs' },
    )
    expect(batches).toHaveLength(VERIFICATION_STAGES.length)
    expect(batches.filter((batch) => batch.command === 'internal')).toEqual([
      expect.objectContaining({
        id: 'environment',
        args: ['validate-environment'],
      }),
    ])
    expect(
      batches.filter((batch) => batch.command !== 'internal').map((batch) => batch.command),
    ).toEqual(
      VERIFICATION_STAGES.filter((stage) => stage.argv[0] !== 'internal').map(
        () => '/runtime/node',
      ),
    )
  })

  it.each([true, false])(
    'preserves checkpoint environment validation in slices: matching=%s',
    async (matching) => {
      const root = await mkdtemp(resolve(tmpdir(), 'natter-slice-environment-stage-'))
      temporaryRoots.push(root)
      const stage = VERIFICATION_STAGES.find((entry) => entry.id === 'environment')
      if (!stage) throw new Error('EnvironmentStageMissing')
      const metadata: VerificationMetadata = {
        nodeVersion: matching ? '26.3.0' : '25.0.0',
        expectedNodeVersion: '26.3.0',
        pnpmVersion: '10.0.0',
        expectedPnpmVersion: '10.0.0',
        playwrightVersion: 'fixture',
        platform: process.platform,
        architecture: process.arch,
        ci: true,
        githubActions: false,
        runnerOs: null,
        timezone: 'UTC',
        e2ePort: 4173,
        fakeProviderPort: 4174,
        metadataDiagnostics: [],
      }
      const checkpoint = await runVerification({
        root,
        stages: [stage],
        metadata,
        persistSummary: async () => undefined,
      })
      const executeBatch = vi.fn(async () => {
        throw new Error('InternalStageMustNotSpawn')
      })
      const slice = await executePreparedSliceVerification({
        baselineId: 'environment-contract',
        evidenceRoot: root,
        runtimeRoot: root,
        runtime: { nodeExecutablePath: '/runtime/node', pnpmExecutablePath: '/runtime/pnpm.mjs' },
        executeBatch,
        metadata,
        planBundle: {
          baseline: verificationSnapshot('base'),
          current: verificationSnapshot('current'),
          plan: { ...verificationPlan(), stages: [stage] },
        },
        buildCurrentSnapshot: () => verificationSnapshot('current'),
        persistSummary: async () => undefined,
      })
      expect(slice.exitCode).toBe(matching ? 0 : 1)
      expect(executeBatch).not.toHaveBeenCalled()
      expect(slice.exitCode).toBe(checkpoint.exitCode)
      expect(slice.summary.batches[0]?.diagnostics).toEqual(
        checkpoint.summary.stages[0]?.diagnostics,
      )
    },
  )

  it.each(['checkpoint', 'slice'] as const)(
    '%s applies the same unit environment, stderr policy and diagnostic verdict',
    async (runner) => {
      const root = await mkdtemp(resolve(tmpdir(), 'natter-stage-policy-'))
      temporaryRoots.push(root)
      const warningPath = resolve(root, 'warning.log')
      await writeFile(warningPath, 'unexpected warning')
      const plan = verificationPlan({ vitest: ['tests/unit/a.test.ts'] })
      const unit = plan.stages.find((stage) => stage.kind === 'vitest')
      if (!unit) throw new Error('UnitStageMissing')
      const stages: VerificationStage[] = [{ ...unit, prerequisites: [] }]
      const execution = { ...batchExecution(0), stderrPath: 'warning.log' }
      const result =
        runner === 'checkpoint'
          ? await runVerification({
              root,
              artifactRoot: root,
              stages,
              metadata: {} as VerificationMetadata,
              executeStage: async (_stage, _metadata, context) => {
                expect(context.environment.NODE_OPTIONS).toContain('--trace-warnings')
                await writePassingUnitProof(context.environment)
                return execution
              },
              persistSummary: async () => undefined,
            })
          : await executePreparedSliceVerification({
              baselineId: 'same-contract',
              evidenceRoot: root,
              runtimeRoot: root,
              planBundle: {
                baseline: verificationSnapshot('base'),
                current: verificationSnapshot('current'),
                plan: { ...plan, stages },
              },
              executeBatch: async (_batch, options) => {
                expect(options.environment.NODE_OPTIONS).toContain('--trace-warnings')
                await writePassingUnitProof(options.environment)
                return execution
              },
              buildCurrentSnapshot: () => verificationSnapshot('current'),
              persistSummary: async () => undefined,
            })
      expect(result.exitCode).toBe(1)
      expect(result.summary.outcome).toBe('failed')
      const entries = 'stages' in result.summary ? result.summary.stages : result.summary.batches
      expect(entries.flatMap((entry) => entry.diagnostics).join('\n')).toContain(
        'VerificationStageUnexpectedStderr:vitest',
      )
    },
  )

  it('keeps advisory execution failure separate from a blocking verdict', async () => {
    const current = verificationSnapshot('current')
    const plan = verificationPlan({ node: [{ id: 'advisory', argv: ['scripts/advisory.mjs'] }] })
    const result = await executePreparedSliceVerification({
      baselineId: 'advisory',
      runtimeRoot: '/candidate',
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: {
          ...plan,
          stages: plan.stages.map((stage) => ({ ...stage, policy: 'advisory' as const })),
        },
      },
      executeBatch: async () => batchExecution(1),
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
    })
    expect(result.summary.batches[0]).toMatchObject({
      status: 'failed',
      policy: 'advisory' as const,
    })
    expect(result.exitCode).toBe(0)
  })

  it('does not execute a consumer after its prerequisite fails while independent work still runs', async () => {
    const current = verificationSnapshot('current')
    const plan = verificationPlan({
      playwright: [{ project: 'chromium', files: ['tests/e2e/a.spec.ts'] }],
    })
    const independent = compileSliceVerificationStages({
      node: [{ id: 'independent', argv: ['scripts/independent.mjs'] }],
      vitest: [],
      playwright: [],
    })
    const calls: string[] = []
    const result = await executePreparedSliceVerification({
      baselineId: 'prerequisite-failure',
      runtimeRoot: '/candidate',
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: { ...plan, stages: [...plan.stages, ...independent] },
      },
      executeBatch: async (batch) => {
        calls.push(batch.id)
        return batchExecution(batch.id === 'production-build' ? 1 : 0)
      },
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
    })
    expect(calls).toEqual(['production-build', 'node-independent'])
    expect(
      result.summary.batches.find((batch) => batch.id === 'playwright-chromium')?.diagnostics,
    ).toEqual([
      'VerificationStagePrerequisiteUnfulfilled:playwright-chromium:production-build:failed',
    ])
    expect(result.exitCode).toBe(1)
  })

  it('binds every batch to the one resolved Node and pnpm capability', () => {
    const batches = createSliceTaskBatches(
      verificationPlan({
        node: [{ id: 'audit', argv: ['scripts/audit.mjs'] }],
        vitest: ['tests/unit/a.test.ts'],
        playwright: [{ project: 'chromium', files: ['tests/e2e/a.spec.ts'] }],
      }),
      { nodeExecutablePath: '/runtime/node', pnpmExecutablePath: '/runtime/pnpm.mjs' },
    )

    expect(batches.map(({ command }) => command)).toEqual([
      '/runtime/node',
      '/runtime/node',
      '/runtime/node',
      '/runtime/node',
    ])
    expect(batches.find((batch) => batch.id === 'vitest')?.args.slice(0, 5)).toEqual([
      '/runtime/pnpm.mjs',
      '--config.manage-package-manager-versions=false',
      'exec',
      'vitest',
      'run',
    ])
    expect(batches.find((batch) => batch.id === 'playwright-chromium')?.args).toEqual([
      'scripts/run-verification.mjs',
      '--browser',
      'chromium',
    ])
  })

  it('isolates candidate execution state and does not inherit credentials or caller Node flags', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-slice-environment-'))
    temporaryRoots.push(root)
    const candidate = {
      runtimeRoot: root,
      runtimePaths: {
        cache: resolve(root, '.verification-runtime/cache'),
        home: resolve(root, '.verification-runtime/home'),
        tmp: resolve(root, '.verification-runtime/tmp'),
        toolBin: resolve(root, '.verification-runtime/tool-bin'),
      },
    } as unknown as MaterializedVerificationCandidate
    const environment = createVerificationCandidateEnvironment(candidate, 'run-one', {
      NODE_OPTIONS: '--inspect',
      OPENROUTER_API_KEY: 'secret',
      PATH: '/bin',
      PLAYWRIGHT_BROWSERS_PATH: '/browser-cache',
    })

    expect(environment).not.toHaveProperty('OPENROUTER_API_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment.HOME).toContain('.verification-runtime/home/run-one')
    expect(environment.TMPDIR).toContain('.verification-runtime/tmp/run-one')
    expect(environment.XDG_CACHE_HOME).toContain('.verification-runtime/cache/run-one')
    expect(environment.npm_config_manage_package_manager_versions).toBe('false')
    expect(environment.pnpm_config_verify_deps_before_run).toBe('false')
    expect(environment.PLAYWRIGHT_BROWSERS_PATH).toBe('/browser-cache')
    expect(Number(environment.E2E_FAKE_PROVIDER_PORT)).toBe(Number(environment.E2E_PORT) + 1)
    expect(Number(environment.E2E_DEV_PORT)).toBe(Number(environment.E2E_PORT) + 2)

    const vitestEnvironment = verificationChildEnvironment({
      kind: 'vitest',
      root,
      runId: 'run-one',
      baseEnv: environment,
    })
    const playwrightEnvironment = verificationChildEnvironment({
      kind: 'playwright',
      root,
      runId: 'run-one',
      baseEnv: environment,
    })
    expect(vitestEnvironment.NODE_OPTIONS).toContain('--localstorage-file=')
    expect(playwrightEnvironment).not.toHaveProperty('NODE_OPTIONS')

    const exactEnvironment = createVerificationCandidateEnvironment(
      candidate,
      'run-two',
      { PATH: '/bin' },
      { nodeExecutablePath: '/runtime/node', pnpmExecutablePath: '/runtime/pnpm.mjs' },
    )
    expect(exactEnvironment.VERIFICATION_NODE_EXECUTABLE).toBe('/runtime/node')
    expect(exactEnvironment.VERIFICATION_PNPM_EXECUTABLE).toBe('/runtime/pnpm.mjs')
  })

  it('continues every independent batch and fails the slice after one batch fails', async () => {
    const current = verificationSnapshot('current')
    const plan = verificationPlan({
      node: [
        { id: 'first', argv: ['scripts/first.mjs'] },
        { id: 'second', argv: ['scripts/second.mjs'] },
      ],
      vitest: ['tests/unit/a.test.ts'],
      playwright: [{ project: 'chromium', files: ['tests/e2e/a.spec.ts'] }],
    })
    const calls: string[] = []
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      runtimeRoot: '/candidate',
      planBundle: { baseline: verificationSnapshot('base'), current, plan },
      executeBatch: async (batch, options) => {
        await writePassingProof(batch, options.environment)
        calls.push(batch.id)
        return batchExecution(batch.id === 'node-first' ? 1 : 0)
      },
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    })

    expect(calls).toEqual([
      'production-build',
      'vitest',
      'playwright-chromium',
      'node-first',
      'node-second',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('failed')
    expect(result.summary.batches.map((batch) => batch.status)).toEqual([
      'passed',
      'passed',
      'passed',
      'failed',
      'passed',
    ])
  })

  it('gives every Playwright batch a distinct run-owned artifact directory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-slice-playwright-artifacts-'))
    temporaryRoots.push(root)
    const current = verificationSnapshot('current')
    const outputDirectories: string[] = []
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      evidenceRoot: root,
      runtimeRoot: root,
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: verificationPlan({
          playwright: [
            { project: 'chromium', files: ['tests/e2e/first.spec.ts'] },
            { project: 'firefox', files: ['tests/e2e/second.spec.ts'] },
          ],
        }),
      },
      executeBatch: async (batch, options) => {
        if (batch.kind !== 'playwright') return batchExecution(0)
        await writePassingProof(batch, options.environment)
        expect(options.environment.E2E_SKIP_BUILD).toBe('1')
        const outputDirectory = options.environment.E2E_PLAYWRIGHT_OUTPUT_DIR
        if (!outputDirectory) throw new Error('SlicePlaywrightOutputDirectoryMissing')
        outputDirectories.push(outputDirectory)
        await mkdir(outputDirectory, { recursive: true })
        await writeFile(resolve(outputDirectory, 'retained.txt'), outputDirectory)
        return batchExecution(0)
      },
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    })

    expect(result.exitCode).toBe(0)
    expect(outputDirectories).toHaveLength(2)
    expect(new Set(outputDirectories).size).toBe(2)
    const firstDirectory = outputDirectories[0]
    const secondDirectory = outputDirectories[1]
    if (!firstDirectory || !secondDirectory) throw new Error('SlicePlaywrightOutputMissing')
    await expect(readFile(resolve(firstDirectory, 'retained.txt'), 'utf8')).resolves.toBe(
      firstDirectory,
    )
    await expect(readFile(resolve(secondDirectory, 'retained.txt'), 'utf8')).resolves.toBe(
      secondDirectory,
    )
  })

  it('rejects a zero-exit browser batch without its collection and completion receipt', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-missing-browser-proof-'))
    temporaryRoots.push(root)
    const current = verificationSnapshot('current')
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      evidenceRoot: root,
      runtimeRoot: root,
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: verificationPlan({
          playwright: [{ project: 'firefox', files: ['tests/e2e/a.spec.ts'] }],
        }),
      },
      executeBatch: async () => batchExecution(0),
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
    })
    expect(result.exitCode).toBe(1)
    expect(result.summary.batches.find((batch) => batch.kind === 'playwright')?.status).toBe(
      'failed',
    )
  })

  it('runs executable evidence but cannot close open guarantees', async () => {
    const current = verificationSnapshot('current')
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      runtimeRoot: '/candidate',
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: verificationPlan({ closable: false, openGuarantees: [{ id: 'gap', status: 'gap' }] }),
      },
      executeBatch: async () => batchExecution(0),
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('passed-with-open-guarantees')
  })

  it('invalidates an otherwise passing run when relevant inputs change during execution', async () => {
    const current = verificationSnapshot('current')
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      runtimeRoot: '/candidate',
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: verificationPlan({ node: [{ id: 'one', argv: ['scripts/one.mjs'] }] }),
      },
      executeBatch: async () => batchExecution(0),
      buildCurrentSnapshot: () => verificationSnapshot('changed-after-plan'),
      persistSummary: async () => undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('failed')
    expect(result.summary.inputsChangedDuringRun).toBe(true)
  })

  it('does not execute a structurally blocked plan', async () => {
    const executeBatch = async (_batch: SliceTaskBatch): Promise<SliceBatchExecution> => {
      throw new Error('BlockedPlanExecuted')
    }
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      runtimeRoot: '/candidate',
      planBundle: {
        baseline: verificationSnapshot('base'),
        current: verificationSnapshot('current'),
        plan: verificationPlan({
          executable: false,
          closable: false,
          structuralBlockers: ['blocked'],
          node: [{ id: 'never', argv: ['scripts/never.mjs'] }],
        }),
      },
      executeBatch,
      buildCurrentSnapshot: () => {
        throw new Error('BlockedPlanSnapshotRead')
      },
      persistSummary: async () => undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('blocked')
    expect(result.summary.batches[0]?.status).toBe('planned')
  })

  it('captures and forwards exact child output with bounded memory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-slice-runner-'))
    temporaryRoots.push(root)
    const current = verificationSnapshot('current')
    const stdout = 'o'.repeat(96 * 1024)
    const stderr = 'e'.repeat(96 * 1024)
    const forwardedStdout: Buffer[] = []
    const forwardedStderr: Buffer[] = []
    const stdoutDestination = collectingWritable(forwardedStdout)
    const stderrDestination = collectingWritable(forwardedStderr)
    const plan = verificationPlan({
      node: [
        {
          id: 'large-output',
          argv: [
            '-e',
            "process.stdout.write('o'.repeat(96*1024));process.stderr.write('e'.repeat(96*1024));process.exitCode=3",
          ],
        },
      ],
    })
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      evidenceRoot: root,
      runtimeRoot: root,
      planBundle: { baseline: verificationSnapshot('base'), current, plan },
      buildCurrentSnapshot: () => current,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
      forwardOutput: true,
      outputDestinations: { stdout: stdoutDestination, stderr: stderrDestination },
    })
    const batch = result.summary.batches[0]
    if (!batch?.stdoutPath || !batch.stderrPath) throw new Error('SliceLogPathMissing')

    expect(batch.exitCode).toBe(3)
    expect(await readFile(resolve(root, batch.stdoutPath), 'utf8')).toBe(stdout)
    expect(await readFile(resolve(root, batch.stderrPath), 'utf8')).toBe(stderr)
    expect(Buffer.concat(forwardedStdout).toString('utf8')).toBe(stdout)
    expect(Buffer.concat(forwardedStderr).toString('utf8')).toBe(stderr)
    expect(stdoutDestination.writableEnded).toBe(false)
    expect(stderrDestination.writableEnded).toBe(false)
  })

  it('retains exact artifacts and fails when an output destination rejects', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-slice-runner-'))
    temporaryRoots.push(root)
    const current = verificationSnapshot('current')
    const stdoutDestination = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('InjectedDestinationFailure'))
      },
    })
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      evidenceRoot: root,
      runtimeRoot: root,
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: verificationPlan({
          node: [{ id: 'forward-failure', argv: ['-e', "process.stdout.write('exact-output')"] }],
        }),
      },
      buildCurrentSnapshot: () => current,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
      outputDestinations: { stdout: stdoutDestination, stderr: collectingWritable([]) },
    })
    const batch = result.summary.batches[0]
    if (!batch?.stdoutPath) throw new Error('SliceStdoutLogPathMissing')

    expect(result.exitCode).toBe(1)
    expect(batch.status).toBe('failed')
    expect(await readFile(resolve(root, batch.stdoutPath), 'utf8')).toBe('exact-output')
    expect(batch.diagnostics).toContain('VerificationSliceLogForwardFailed:stdout:Error')
  })

  it('closes a partial artifact open and reports only paths that exist', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'natter-slice-runner-'))
    temporaryRoots.push(root)
    const current = verificationSnapshot('current')
    const runDirectory = resolve(
      root,
      'test-results/verification-slice/runs/2026-07-17T00-00-00-000Z-plan-digest',
    )
    await mkdir(resolve(runDirectory, 'node-open-failure.stderr.log'), { recursive: true })
    const result = await executePreparedSliceVerification({
      baselineId: 'slice-test',
      evidenceRoot: root,
      runtimeRoot: root,
      planBundle: {
        baseline: verificationSnapshot('base'),
        current,
        plan: verificationPlan({
          node: [{ id: 'open-failure', argv: ['-e', "process.stdout.write('not-run')"] }],
        }),
      },
      buildCurrentSnapshot: () => current,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
      forwardOutput: false,
    })
    const batch = result.summary.batches[0]
    if (!batch?.stdoutPath) throw new Error('SliceStdoutLogPathMissing')

    expect(batch.status).toBe('failed')
    expect(await readFile(resolve(root, batch.stdoutPath), 'utf8')).toBe('')
    expect(batch.stderrPath).toBeNull()
    expect(
      batch.diagnostics.some((diagnostic) =>
        diagnostic.startsWith('VerificationSliceLogOpenFailed:stderr:'),
      ),
    ).toBe(true)
  })
})

function collectingWritable(chunks: Buffer[]): Writable {
  return new Writable({
    highWaterMark: 1,
    write(chunk: string | Uint8Array, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      queueMicrotask(callback)
    },
  })
}

function verificationPlan(
  options: {
    executable?: boolean
    closable?: boolean
    structuralBlockers?: string[]
    openGuarantees?: Array<{ id: string; status: string }>
    node?: Array<{ id: string; argv: string[] }>
    vitest?: string[]
    playwright?: Array<{ project: string; files: string[] }>
  } = {},
): SliceVerificationPlan {
  const executable = options.executable ?? true
  const closable = options.closable ?? executable
  return {
    schemaVersion: 2,
    baseDigest: 'base',
    currentDigest: 'current',
    impact: {
      addedPaths: [],
      modifiedPaths: [],
      deletedPaths: [],
      changedPaths: [],
      changedSymbols: [],
    },
    affectedPaths: [],
    impactedDomains: [],
    impactedObligations: [],
    impactedGuarantees: [],
    openGuarantees: options.openGuarantees ?? [],
    unregisteredAffectedTests: [],
    tasks: {
      node: options.node ?? [],
      vitest: options.vitest ?? [],
      playwright: options.playwright ?? [],
    },
    stages: compileSliceVerificationStages({
      node: options.node ?? [],
      vitest: options.vitest ?? [],
      playwright: options.playwright ?? [],
    }),
    impactedStageIds: [],
    structuralBlockers: options.structuralBlockers ?? [],
    executable,
    closable,
    planDigest: 'plan-digest',
  }
}

function verificationSnapshot(digest: string): VerificationSnapshot {
  return {
    schemaVersion: 4,
    unitExecution: { status: 'owned', providerInputs: {}, projects: [] },
    obligationSchemaVersion: 2,
    files: {},
    dependencies: {},
    graphDiagnostics: [],
    digest,
  }
}

function batchExecution(exitCode: number): SliceBatchExecution {
  return {
    exitCode,
    signal: null,
    diagnostics: [],
    stdoutPath: null,
    stderrPath: null,
  }
}

async function writePassingProof(batch: SliceTaskBatch, environment: NodeJS.ProcessEnv) {
  await writePassingUnitProof(environment)
  if (!batch.browserTasks) return
  const path = environment.E2E_BROWSER_PROOF_PATH
  if (!path) throw new Error('MissingBrowserProofPath')
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      status: 'passed',
      expected: batch.browserTasks,
      cases: batch.browserTasks.flatMap((task) =>
        task.files.map((file) => ({
          id: `${task.project}:${file}`,
          project: task.project,
          file,
          outcome: 'expected',
          annotations: [],
          results: [{ status: 'passed', retry: 0, duration: 1 }],
        })),
      ),
    }),
  )
}

async function writePassingUnitProof(environment: NodeJS.ProcessEnv) {
  const path = environment.VERIFICATION_VITEST_PROOF_PATH
  const selection = environment.VERIFICATION_VITEST_SELECTION
  if (!path || !selection) return
  const files = (JSON.parse(selection) as string[]).map((file) => ({ project: 'app', file }))
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      invocation: environment.VERIFICATION_VITEST_INVOCATION,
      status: 'passed',
      reason: 'passed',
      timedOut: false,
      expected: files,
      scheduled: files,
      finalModules: files,
      collected: files.map((file) => ({
        ...file,
        cases: [{ id: file.file, name: 'proof', mode: 'run' }],
      })),
      completed: files.map((file) => ({ ...file, state: 'passed' })),
      results: files.map((file) => ({
        ...file,
        id: file.file,
        state: 'passed',
        errors: [],
        diagnostic: { retryCount: 0, repeatCount: 0, flaky: false, duration: 1 },
      })),
      unhandledErrors: [],
      selectionProblems: [],
    }),
  )
}
