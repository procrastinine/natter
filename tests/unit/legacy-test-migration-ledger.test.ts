import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildTestCompilerCohort,
  TEST_COMPILER_COHORT_DESCRIPTOR,
  TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST,
  type TestCompilerCapture,
  type TestCompilerEncodedOutput,
  type TestCompilerExecutionCapture,
  validateTestCompilerCohort,
} from '../../scripts/test-compiler-cohort.mjs'
import type { VerificationSnapshot } from '../../scripts/verification-impact-plan.mjs'

describe('legacy test architecture migration ledger', () => {
  it('derives the complete current cohort from candidate-qualified compiler evidence', () => {
    const snapshot = verificationSnapshot({
      'tests/helpers/setup.ts': 'helper-hash',
      'tests/unit/current.test.ts': 'suite-hash',
    })
    const cohort = buildTestCompilerCohort({
      snapshot,
      capture: compilerCapture(snapshot, {
        roots: ['./tests/unit/current.test.ts', './tests/helpers/setup.ts'],
      }),
    })

    expect(cohort).toMatchObject({
      schemaVersion: 1,
      assignment: {
        waveId: 'wave-a-cut-6-runnable-snapshot',
        sourceObligation: 'adapt-preserved-tests-to-current-contract',
      },
      candidateId: 'candidate-test',
      snapshotDigest: snapshot.digest,
      descriptorDigest: TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST,
      compiler: {
        packageSpecifier: '@typescript/native',
        packageName: 'typescript',
        packageVersion: '7.0.2',
        nodeVersion: 'v26.1.0',
        platform: 'linux',
        arch: 'arm64',
      },
      status: 'resolved',
      configuredRootOrder: ['tests/unit/current.test.ts', 'tests/helpers/setup.ts'],
      roots: [
        { path: 'tests/helpers/setup.ts', sha256: 'helper-hash' },
        { path: 'tests/unit/current.test.ts', sha256: 'suite-hash' },
      ],
      diagnostics: [],
      unparsedOutput: [],
      exitCode: 0,
      signal: null,
      error: null,
      problems: [],
      historicalCohort: { status: 'evidence-lost', expectedFileCount: 76 },
    })
    expect(cohort.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(Object.isFrozen(cohort.capture.roots.stdout)).toBe(true)
    expect(validateTestCompilerCohort(cohort, snapshot)).toEqual([])
  })

  it('preserves exact diagnostic bytes and rejects unowned output instead of laundering it', () => {
    const snapshot = verificationSnapshot({ 'tests/unit/current (copy).test.ts': 'suite-hash' })
    const diagnosticOutput =
      "tests/unit/current (copy).test.ts(4,7): error TS2304: Cannot find name 'missing'.\r\n  related detail\r\nerror TS5058: The specified path does not exist."
    const pending = buildTestCompilerCohort({
      snapshot,
      capture: compilerCapture(snapshot, {
        roots: ['./tests/unit/current (copy).test.ts'],
        diagnosticExecution: execution(
          TEST_COMPILER_COHORT_DESCRIPTOR.compiler.diagnosticArgs,
          diagnosticOutput,
          '',
          2,
        ),
      }),
    })

    expect(pending.status).toBe('pending')
    expect(pending.problems).toEqual([])
    expect(pending.diagnostics).toEqual([
      {
        ordinal: 0,
        channel: 'stdout',
        path: 'tests/unit/current (copy).test.ts',
        line: 4,
        column: 7,
        category: 'error',
        code: 2304,
        raw: "tests/unit/current (copy).test.ts(4,7): error TS2304: Cannot find name 'missing'.\r\n  related detail\r\n",
      },
      {
        ordinal: 1,
        channel: 'stdout',
        path: null,
        line: null,
        column: null,
        category: 'error',
        code: 5058,
        raw: 'error TS5058: The specified path does not exist.',
      },
    ])

    const noise = buildTestCompilerCohort({
      snapshot,
      capture: compilerCapture(snapshot, {
        roots: ['./tests/unit/current (copy).test.ts'],
        diagnosticExecution: execution(
          TEST_COMPILER_COHORT_DESCRIPTOR.compiler.diagnosticArgs,
          `${diagnosticOutput}\nUNPARSED TOOL NOISE\n`,
          '',
          2,
        ),
      }),
    })
    expect(noise.status).toBe('invalid')
    expect(noise.problems).toContain('TestCompilerCohortDiagnosticOutputUnparsed:stdout')
    expect(noise.unparsedOutput).toEqual([{ channel: 'stdout', raw: 'UNPARSED TOOL NOISE\n' }])
  })

  it('fails closed on empty, duplicate, outside, missing-root, and mixed-snapshot evidence', () => {
    const snapshot = verificationSnapshot({ 'tests/unit/current.test.ts': 'suite-hash' })
    const invalid = buildTestCompilerCohort({
      snapshot,
      capture: compilerCapture(snapshot, {
        roots: [
          './tests/unit/current.test.ts',
          './tests/unit/current.test.ts',
          '../outside.test.ts',
          'C:\\outside.test.ts',
          './tests/unit/missing.test.ts',
        ],
      }),
    })
    expect(invalid.status).toBe('invalid')
    expect(invalid.problems).toEqual(
      expect.arrayContaining([
        'TestCompilerCohortRootDuplicate',
        'TestCompilerCohortRootHashMissing:tests/unit/missing.test.ts',
        'TestCompilerCohortRootPathInvalid:../outside.test.ts',
        'TestCompilerCohortRootPathInvalid:C:\\outside.test.ts',
      ]),
    )
    expect(validateTestCompilerCohort(invalid, snapshot)).toEqual([])

    const empty = buildTestCompilerCohort({
      snapshot,
      capture: compilerCapture(snapshot, { roots: [] }),
    })
    expect(empty.problems).toContain('TestCompilerCohortShowConfigFilesEmpty')

    const otherSnapshot = verificationSnapshot({ 'tests/unit/current.test.ts': 'other-hash' })
    expect(otherSnapshot.digest).not.toBe(snapshot.digest)
    const mixed = buildTestCompilerCohort({
      snapshot: otherSnapshot,
      capture: compilerCapture(snapshot),
    })
    expect(mixed.problems).toContain('TestCompilerCohortSnapshotMismatch')
  })

  it('rederives status and every persisted field instead of trusting a recomputed outer digest', () => {
    const snapshot = verificationSnapshot({ 'tests/unit/current.test.ts': 'suite-hash' })
    const resolved = buildTestCompilerCohort({ snapshot, capture: compilerCapture(snapshot) })
    const tamperedWithoutDigest = { ...resolved, status: 'pending' as const }
    const tampered = {
      ...tamperedWithoutDigest,
      digest: digestJson(tamperedWithoutDigest),
    }
    expect(validateTestCompilerCohort(tampered, snapshot)).toEqual([
      'TestCompilerCohortDerivationMismatch',
    ])
  })
})

function compilerCapture(
  snapshot: VerificationSnapshot,
  options: {
    roots?: string[]
    diagnosticExecution?: TestCompilerExecutionCapture
  } = {},
): TestCompilerCapture {
  const withoutDigest = {
    schemaVersion: 1 as const,
    candidateId: 'candidate-test',
    snapshotDigest: snapshot.digest,
    descriptorDigest: TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST,
    compiler: {
      packageSpecifier: '@typescript/native',
      packageName: 'typescript',
      packageVersion: '7.0.2',
      packageJsonSha256: 'a'.repeat(64),
      cliEntrySha256: 'b'.repeat(64),
      nodeExecutableSha256: 'c'.repeat(64),
      nodeExecutableByteLength: 100,
      nativePackageJsonSha256: 'd'.repeat(64),
      nativeExecutableSha256: 'e'.repeat(64),
      nativeExecutableByteLength: 200,
      nodeVersion: 'v26.1.0',
      platform: 'linux' as const,
      arch: 'arm64',
    },
    roots: execution(
      TEST_COMPILER_COHORT_DESCRIPTOR.compiler.rootArgs,
      JSON.stringify({ files: options.roots ?? ['./tests/unit/current.test.ts'] }),
    ),
    diagnostics:
      options.diagnosticExecution ??
      execution(TEST_COMPILER_COHORT_DESCRIPTOR.compiler.diagnosticArgs),
  }
  return { ...withoutDigest, digest: digestJson(withoutDigest) }
}

function execution(
  args: readonly string[],
  stdout = '',
  stderr = '',
  exitCode = 0,
): TestCompilerExecutionCapture {
  return {
    invocation: {
      packageSpecifier: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.packageSpecifier,
      args,
      environment: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.environment,
    },
    stdout: encodedOutput(stdout),
    stderr: encodedOutput(stderr),
    exitCode,
    signal: null,
    error: null,
  }
}

function encodedOutput(value: string): TestCompilerEncodedOutput {
  const bytes = Buffer.from(value)
  return {
    encoding: 'base64',
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    data: bytes.toString('base64'),
  }
}

function verificationSnapshot(files: Readonly<Record<string, string>>): VerificationSnapshot {
  const withoutDigest = {
    schemaVersion: 2 as const,
    obligationSchemaVersion: 2,
    files: Object.fromEntries(
      Object.entries(files).map(([path, sha256Value]) => [
        path,
        { sha256: sha256Value, executable: false, symbols: [] },
      ]),
    ),
    dependencies: Object.fromEntries(Object.keys(files).map((path) => [path, []])),
    graphDiagnostics: [],
  }
  return { ...withoutDigest, digest: sha256(JSON.stringify(withoutDigest)) }
}

function digestJson(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(value))}`
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
