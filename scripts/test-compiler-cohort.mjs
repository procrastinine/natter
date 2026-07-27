import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { VERIFICATION_SNAPSHOT_SCHEMA_VERSION } from './verification-snapshot-schema.mjs'

export const TEST_COMPILER_COHORT_DESCRIPTOR = deepFreeze({
  schemaVersion: 1,
  assignment: {
    waveId: 'wave-b-cut-1-semantic-operation-capabilities',
    sourceObligation: 'adapt-preserved-tests-to-current-contract',
  },
  compiler: {
    packageSpecifier: '@typescript/native',
    rootArgs: ['-p', 'tsconfig.test.json', '--showConfig', '--pretty', 'false', '--locale', 'en'],
    diagnosticArgs: ['-p', 'tsconfig.test.json', '--noEmit', '--pretty', 'false', '--locale', 'en'],
    environment: {
      CI: '1',
      FORCE_COLOR: '0',
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      TZ: 'UTC',
    },
  },
  historicalCohort: {
    status: 'evidence-lost',
    expectedFileCount: 76,
    disposition:
      'The original compiler output and matching source snapshot are unavailable; no current or reconstructed rows may be represented as that historical cohort.',
  },
})

export const TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST = digestJson(TEST_COMPILER_COHORT_DESCRIPTOR)

export function buildTestCompilerCohort(options) {
  return deriveTestCompilerCohort(options.snapshot, options.capture)
}

export function validateTestCompilerCohort(cohort, snapshot) {
  const problems = []
  let expected
  try {
    expected = deriveTestCompilerCohort(snapshot, cohort?.capture)
  } catch (error) {
    problems.push(`TestCompilerCohortCaptureInvalid:${errorName(error)}`)
    return Object.freeze(problems)
  }
  if (JSON.stringify(cohort) !== JSON.stringify(expected)) {
    problems.push('TestCompilerCohortDerivationMismatch')
  }
  return Object.freeze(problems)
}

function deriveTestCompilerCohort(snapshot, captureInput) {
  const problems = []
  const capture = normalizeCapture(captureInput, problems)
  validateSnapshot(snapshot, problems)
  if (capture.snapshotDigest !== snapshot?.digest) {
    problems.push('TestCompilerCohortSnapshotMismatch')
  }
  if (capture.descriptorDigest !== TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST) {
    problems.push('TestCompilerCohortDescriptorMismatch')
  }
  validateCompilerIdentity(capture.compiler, problems)
  validateInvocation(
    capture.roots,
    'Roots',
    TEST_COMPILER_COHORT_DESCRIPTOR.compiler.rootArgs,
    problems,
  )
  validateInvocation(
    capture.diagnostics,
    'Diagnostics',
    TEST_COMPILER_COHORT_DESCRIPTOR.compiler.diagnosticArgs,
    problems,
  )

  const rootOutput = decodeOutput(capture.roots.stdout, 'RootsStdout', problems)
  const rootStderr = decodeOutput(capture.roots.stderr, 'RootsStderr', problems)
  if (rootStderr.byteLength > 0) problems.push('TestCompilerCohortRootsStderrUnexpected')
  const configured = parseConfiguredRoots(rootOutput.text, problems)
  const roots = configured.sorted.map((path) => {
    const sha256 = snapshot?.files?.[path]?.sha256
    if (typeof sha256 !== 'string') problems.push(`TestCompilerCohortRootHashMissing:${path}`)
    return Object.freeze({ path, sha256: typeof sha256 === 'string' ? sha256 : null })
  })

  const diagnosticStdout = decodeOutput(capture.diagnostics.stdout, 'DiagnosticsStdout', problems)
  const diagnosticStderr = decodeOutput(capture.diagnostics.stderr, 'DiagnosticsStderr', problems)
  const parsedOutput = parseCompilerDiagnosticOutput(diagnosticStdout.text, diagnosticStderr.text)
  problems.push(...parsedOutput.problems)
  validateDiagnosticExit(capture.diagnostics, parsedOutput.diagnostics, problems)

  const uniqueProblems = uniqueSorted(problems)
  const status = deriveStatus(capture.diagnostics, parsedOutput.diagnostics, uniqueProblems)
  const cohortWithoutDigest = {
    schemaVersion: 1,
    assignment: TEST_COMPILER_COHORT_DESCRIPTOR.assignment,
    candidateId: capture.candidateId,
    snapshotDigest: capture.snapshotDigest,
    descriptorDigest: capture.descriptorDigest,
    compiler: capture.compiler,
    status,
    configuredRootOrder: Object.freeze(configured.original),
    roots: Object.freeze(roots),
    diagnostics: parsedOutput.diagnostics,
    unparsedOutput: parsedOutput.unparsedOutput,
    exitCode: capture.diagnostics.exitCode,
    signal: capture.diagnostics.signal,
    error: capture.diagnostics.error,
    problems: Object.freeze(uniqueProblems),
    historicalCohort: TEST_COMPILER_COHORT_DESCRIPTOR.historicalCohort,
    capture,
  }
  return deepFreeze({
    ...cohortWithoutDigest,
    digest: digestJson(cohortWithoutDigest),
  })
}

function normalizeCapture(value, problems) {
  const candidateId = typeof value?.candidateId === 'string' ? value.candidateId : ''
  if (!/^candidate-[a-z0-9-]+$/u.test(candidateId)) {
    problems.push('TestCompilerCohortCandidateIdInvalid')
  }
  const snapshotDigest = typeof value?.snapshotDigest === 'string' ? value.snapshotDigest : ''
  const descriptorDigest = typeof value?.descriptorDigest === 'string' ? value.descriptorDigest : ''
  const captureWithoutDigest = {
    schemaVersion: value?.schemaVersion,
    candidateId,
    snapshotDigest,
    descriptorDigest,
    compiler: normalizeCompilerIdentity(value?.compiler),
    roots: normalizeExecution(value?.roots),
    diagnostics: normalizeExecution(value?.diagnostics),
  }
  if (captureWithoutDigest.schemaVersion !== 1) {
    problems.push('TestCompilerCohortCaptureSchemaInvalid')
  }
  const capture = {
    ...captureWithoutDigest,
    digest: typeof value?.digest === 'string' ? value.digest : '',
  }
  if (capture.digest !== digestJson(captureWithoutDigest)) {
    problems.push('TestCompilerCohortCaptureDigestMismatch')
  }
  return deepFreeze(capture)
}

function normalizeCompilerIdentity(value) {
  return {
    packageSpecifier: stringOrEmpty(value?.packageSpecifier),
    packageName: stringOrEmpty(value?.packageName),
    packageVersion: stringOrEmpty(value?.packageVersion),
    packageJsonSha256: stringOrEmpty(value?.packageJsonSha256),
    cliEntrySha256: stringOrEmpty(value?.cliEntrySha256),
    nodeExecutableSha256: stringOrEmpty(value?.nodeExecutableSha256),
    nodeExecutableByteLength: integerOrInvalid(value?.nodeExecutableByteLength),
    nativePackageJsonSha256: stringOrEmpty(value?.nativePackageJsonSha256),
    nativeExecutableSha256: stringOrEmpty(value?.nativeExecutableSha256),
    nativeExecutableByteLength: integerOrInvalid(value?.nativeExecutableByteLength),
    nodeVersion: stringOrEmpty(value?.nodeVersion),
    platform: stringOrEmpty(value?.platform),
    arch: stringOrEmpty(value?.arch),
  }
}

function normalizeExecution(value) {
  return {
    invocation: {
      packageSpecifier: stringOrEmpty(value?.invocation?.packageSpecifier),
      args: stringsOrEmpty(value?.invocation?.args),
      environment: stringRecordOrEmpty(value?.invocation?.environment),
    },
    stdout: normalizeOutput(value?.stdout),
    stderr: normalizeOutput(value?.stderr),
    exitCode: Number.isInteger(value?.exitCode) ? value.exitCode : null,
    signal: typeof value?.signal === 'string' ? value.signal : null,
    error:
      typeof value?.error === 'string' ? value.error : value?.error === null ? null : 'missing',
  }
}

function normalizeOutput(value) {
  return {
    encoding: value?.encoding,
    byteLength: Number.isInteger(value?.byteLength) ? value.byteLength : null,
    sha256: stringOrEmpty(value?.sha256),
    data: stringOrEmpty(value?.data),
  }
}

function validateSnapshot(snapshot, problems) {
  if (
    snapshot?.schemaVersion !== VERIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    typeof snapshot?.digest !== 'string'
  ) {
    problems.push('TestCompilerCohortSnapshotInvalid')
    return
  }
  const { digest: _digest, ...withoutDigest } = snapshot
  if (snapshot.digest !== sha256(JSON.stringify(withoutDigest))) {
    problems.push('TestCompilerCohortSnapshotDigestInvalid')
  }
}

function validateCompilerIdentity(compiler, problems) {
  if (compiler.packageSpecifier !== TEST_COMPILER_COHORT_DESCRIPTOR.compiler.packageSpecifier) {
    problems.push('TestCompilerCohortCompilerPackageInvalid')
  }
  for (const [key, value] of Object.entries(compiler)) {
    if (key === 'nativeExecutableByteLength' || key === 'nodeExecutableByteLength') continue
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`TestCompilerCohortCompilerIdentityMissing:${key}`)
    }
  }
  for (const key of [
    'cliEntrySha256',
    'nativeExecutableSha256',
    'nativePackageJsonSha256',
    'nodeExecutableSha256',
    'packageJsonSha256',
  ]) {
    if (!/^[0-9a-f]{64}$/u.test(compiler[key])) {
      problems.push(`TestCompilerCohortCompilerHashInvalid:${key}`)
    }
  }
  for (const key of ['nativeExecutableByteLength', 'nodeExecutableByteLength']) {
    if (!Number.isSafeInteger(compiler[key]) || compiler[key] <= 0) {
      problems.push(`TestCompilerCohortCompilerByteLengthInvalid:${key}`)
    }
  }
}

function validateInvocation(execution, label, expectedArgs, problems) {
  if (
    execution.invocation.packageSpecifier !==
    TEST_COMPILER_COHORT_DESCRIPTOR.compiler.packageSpecifier
  ) {
    problems.push(`TestCompilerCohort${label}PackageInvalid`)
  }
  if (!sameStrings(execution.invocation.args, expectedArgs)) {
    problems.push(`TestCompilerCohort${label}ArgsInvalid`)
  }
  if (
    JSON.stringify(execution.invocation.environment) !==
    JSON.stringify(TEST_COMPILER_COHORT_DESCRIPTOR.compiler.environment)
  ) {
    problems.push(`TestCompilerCohort${label}EnvironmentInvalid`)
  }
  if (execution.exitCode !== null && execution.exitCode < 0) {
    problems.push(`TestCompilerCohort${label}ExitInvalid`)
  }
  if (execution.exitCode === null && execution.signal === null && execution.error === null) {
    problems.push(`TestCompilerCohort${label}TerminationMissing`)
  }
  if (execution.signal !== null)
    problems.push(`TestCompilerCohort${label}Signal:${execution.signal}`)
  if (execution.error !== null)
    problems.push(`TestCompilerCohort${label}ExecutionFailed:${execution.error}`)
  if (label === 'Roots' && execution.exitCode !== 0) {
    problems.push(`TestCompilerCohortRootsExit:${String(execution.exitCode)}`)
  }
}

function decodeOutput(output, label, problems) {
  if (output.encoding !== 'base64') problems.push(`TestCompilerCohort${label}EncodingInvalid`)
  let bytes
  try {
    bytes = Buffer.from(output.data, 'base64')
  } catch {
    bytes = Buffer.alloc(0)
    problems.push(`TestCompilerCohort${label}Base64Invalid`)
  }
  if (bytes.toString('base64') !== output.data) {
    problems.push(`TestCompilerCohort${label}Base64Invalid`)
  }
  if (output.byteLength !== bytes.byteLength) {
    problems.push(`TestCompilerCohort${label}LengthMismatch`)
  }
  if (output.sha256 !== sha256(bytes)) problems.push(`TestCompilerCohort${label}HashMismatch`)
  return { byteLength: bytes.byteLength, text: bytes.toString('utf8') }
}

function parseConfiguredRoots(output, problems) {
  let config
  try {
    config = JSON.parse(output)
  } catch {
    problems.push('TestCompilerCohortShowConfigJsonInvalid')
    return { original: [], sorted: [] }
  }
  if (!Array.isArray(config?.files)) {
    problems.push('TestCompilerCohortShowConfigFilesInvalid')
    return { original: [], sorted: [] }
  }
  if (config.files.length === 0) problems.push('TestCompilerCohortShowConfigFilesEmpty')
  const paths = []
  for (const value of config.files) {
    const path = canonicalRepositoryPath(value)
    if (path === null) problems.push(`TestCompilerCohortRootPathInvalid:${String(value)}`)
    else paths.push(path)
  }
  if (new Set(paths).size !== paths.length) problems.push('TestCompilerCohortRootDuplicate')
  return { original: paths, sorted: uniqueSorted(paths) }
}

function parseCompilerDiagnosticOutput(stdout, stderr) {
  const parsed = [parseDiagnosticStream(stdout, 'stdout'), parseDiagnosticStream(stderr, 'stderr')]
  const diagnostics = parsed.flatMap((entry) => entry.diagnostics)
  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    unparsedOutput: Object.freeze(parsed.flatMap((entry) => entry.unparsedOutput)),
    problems: Object.freeze(parsed.flatMap((entry) => entry.problems)),
  })
}

function parseDiagnosticStream(output, channel) {
  const diagnostics = []
  const unparsedOutput = []
  const problems = []
  let current = null
  const flush = () => {
    if (current === null) return
    diagnostics.push(Object.freeze({ ...current, raw: current.raw.join('') }))
    current = null
  }
  for (const segment of lineSegments(output)) {
    const text = segment.replace(/\r?\n$/u, '')
    const match = /^(?:(.+)\((\d+),(\d+)\): )?(error|warning|message) TS(\d+): (.*)$/u.exec(text)
    if (match) {
      flush()
      const path = match[1] === undefined ? null : canonicalRepositoryPath(match[1])
      if (match[1] !== undefined && path === null) {
        problems.push(`TestCompilerCohortDiagnosticPathInvalid:${match[1]}`)
      }
      current = {
        ordinal: diagnostics.length,
        channel,
        path,
        line: match[2] === undefined ? null : Number(match[2]),
        column: match[3] === undefined ? null : Number(match[3]),
        category: match[4],
        code: Number(match[5]),
        raw: [segment],
      }
      continue
    }
    if (current !== null && (text.length === 0 || /^\s/u.test(text))) {
      current.raw.push(segment)
      continue
    }
    flush()
    if (segment.length > 0) {
      unparsedOutput.push(Object.freeze({ channel, raw: segment }))
      problems.push(`TestCompilerCohortDiagnosticOutputUnparsed:${channel}`)
    }
  }
  flush()
  return { diagnostics, unparsedOutput, problems }
}

function validateDiagnosticExit(execution, diagnostics, problems) {
  if (execution.exitCode === 0 && diagnostics.length > 0) {
    problems.push('TestCompilerCohortSuccessfulCompilerReportedDiagnostics')
  }
  if (execution.exitCode !== 0 && diagnostics.length === 0) {
    problems.push(`TestCompilerCohortFailedWithoutDiagnostics:${String(execution.exitCode)}`)
  }
}

function deriveStatus(execution, diagnostics, problems) {
  if (problems.length > 0) return 'invalid'
  if (execution.exitCode === 0 && diagnostics.length === 0) return 'resolved'
  if (Number.isInteger(execution.exitCode) && execution.exitCode > 0 && diagnostics.length > 0) {
    return 'pending'
  }
  return 'invalid'
}

function canonicalRepositoryPath(value) {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) return null
  const slashPath = value.replaceAll('\\', '/')
  if (/^(?:\/|[A-Za-z]:\/|\/\/)/u.test(slashPath)) return null
  const normalized = posix.normalize(slashPath.replace(/^\.\//u, ''))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true
  }
  return false
}

function lineSegments(value) {
  const segments = []
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\n') continue
    segments.push(value.slice(start, index + 1))
    start = index + 1
  }
  if (start < value.length) segments.push(value.slice(start))
  return segments
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

function integerOrInvalid(value) {
  return Number.isSafeInteger(value) ? value : -1
}

function stringsOrEmpty(value) {
  return Array.isArray(value) ? value.map(stringOrEmpty) : []
}

function stringRecordOrEmpty(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => [key, stringOrEmpty(entry)])
      .sort(([left], [right]) => compareText(left, right)),
  )
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function digestJson(value) {
  return `sha256:${sha256(JSON.stringify(value))}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText)
}

function errorName(error) {
  return error instanceof Error ? error.name : 'UnknownError'
}
