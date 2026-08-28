import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSliceVerificationExecutionReady,
  createSliceTaskBatches,
  executePreparedSliceVerification,
  type SliceBatchExecution,
  type SliceTaskBatch,
} from '../../scripts/run-slice-verification.mjs'
import { createVerificationCandidateEnvironment } from '../../scripts/verification-candidate-execution.mjs'
import type { MaterializedVerificationCandidate } from '../../scripts/verification-candidate-workspace.mjs'
import type {
  SliceVerificationPlan,
  VerificationSnapshot,
} from '../../scripts/verification-impact-plan.mjs'
import { verificationChildEnvironment } from '../../scripts/verification-process-execution.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  )
})

describe('verification slice runner', () => {
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

  it('creates one Vitest batch and one Playwright batch per declared project', () => {
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
      'node-first',
      'node-second',
      'vitest',
      'playwright-chromium',
      'playwright-large-workspace-setup',
      'playwright-chromium-large-workspace',
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
      '--config.manage-package-manager-versions=false',
      'exec',
      'playwright',
      'test',
      '--project=chromium',
      '--no-deps',
      'tests/e2e/a.spec.ts',
      'tests/e2e/b.spec.ts',
    ])
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
    ])
    expect(batches[1]?.args.slice(0, 5)).toEqual([
      '/runtime/pnpm.mjs',
      '--config.manage-package-manager-versions=false',
      'exec',
      'vitest',
      'run',
    ])
    expect(batches[2]?.args.slice(0, 5)).toEqual([
      '/runtime/pnpm.mjs',
      '--config.manage-package-manager-versions=false',
      'exec',
      'playwright',
      'test',
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
      executeBatch: async (batch) => {
        calls.push(batch.id)
        return batchExecution(batch.id === 'node-first' ? 1 : 0)
      },
      buildCurrentSnapshot: () => current,
      persistSummary: async () => undefined,
      now: () => new Date('2026-07-17T00:00:00.000Z'),
    })

    expect(calls).toEqual(['node-first', 'node-second', 'vitest', 'playwright-chromium'])
    expect(result.exitCode).toBe(1)
    expect(result.summary.outcome).toBe('failed')
    expect(result.summary.batches.map((batch) => batch.status)).toEqual([
      'failed',
      'passed',
      'passed',
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
            { project: 'chromium-send-performance', files: ['tests/e2e/second.spec.ts'] },
          ],
        }),
      },
      executeBatch: async (_batch, options) => {
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
    schemaVersion: 1,
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
    structuralBlockers: options.structuralBlockers ?? [],
    executable,
    closable,
    planDigest: 'plan-digest',
  }
}

function verificationSnapshot(digest: string): VerificationSnapshot {
  return {
    schemaVersion: 2,
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
