import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildTestCompilerCohort,
  TEST_COMPILER_COHORT_DESCRIPTOR,
  TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST,
  validateTestCompilerCohort,
} from './test-compiler-cohort.mjs'
import {
  assertVerificationCandidateAdmissionReady,
  verificationCandidateAdmission,
} from './verification-candidate-admission.mjs'
import {
  assertVerificationDependencyFacade,
  assertVerificationDependencyImageUnchanged,
  installVerificationDependencyFacade,
  readVerificationDependencyImage,
  resolveVerificationDependencyRuntime,
} from './verification-dependency-image.mjs'
import { buildVerificationSnapshot } from './verification-impact-plan.mjs'

const MATERIALIZED_CANDIDATES = new WeakSet()
const VALIDATED_CANDIDATES = new WeakSet()
const CANDIDATE_RUNTIMES = new WeakSet()
const CANDIDATE_SCHEMA_VERSION = 3
const SOURCE_MANIFEST_SCHEMA_VERSION = 2
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_FILES = 100_000
const MAX_SOURCE_FILE_BYTES = 128 * 1024 * 1024
const MAX_SOURCE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const RUNTIME_DIRECTORIES = Object.freeze([
  '.verification-runtime/cache',
  '.verification-runtime/home',
  '.verification-runtime/tmp',
  '.verification-runtime/tool-bin',
  'coverage',
  'dist',
  'dist-engine',
  'output',
  'playwright-report',
  'test-results',
])
const DEPENDENCY_RUNTIME_DIRECTORIES = Object.freeze([
  'node_modules/.cache',
  'node_modules/.tmp',
  'node_modules/.vite',
  'node_modules/.vite-temp',
])
const RESERVED_SOURCE_ROOTS = Object.freeze(
  new Set([
    '.git',
    '.verification-runtime',
    'coverage',
    'dist',
    'dist-engine',
    'node_modules',
    'output',
    'playwright-report',
    'test-results',
  ]),
)

export async function materializeVerificationCandidate(options) {
  const admission = assertVerificationCandidateAdmissionReady(options.manifest)
  const sourceRoot = resolve(options.sourceRoot)
  const evidenceRoot = resolve(options.evidenceRoot ?? sourceRoot)
  const dependencyImage = assertVerificationDependencyImageUnchanged(options.dependencyImage)
  const id = `candidate-${randomBytes(8).toString('hex')}`
  const directory = verificationCandidateDirectory(evidenceRoot, id)
  const temporaryDirectory = `${directory}.tmp`
  const runtimeRoot = resolve(temporaryDirectory, 'workspace')
  rmSync(temporaryDirectory, { recursive: true, force: true })
  mkdirSync(runtimeRoot, { recursive: true })
  try {
    const inventory =
      options.sourcePathInventory ?? (() => readGitSourceInventory(sourceRoot, options.runProcess))
    const sourceManifest = await buildSourceManifest(sourceRoot, await inventory())
    copySourceManifest(sourceRoot, runtimeRoot, sourceManifest)
    const sourceAfterCopy = await buildSourceManifest(sourceRoot, await inventory())
    if (sourceAfterCopy.digest !== sourceManifest.digest) {
      throw new Error('VerificationCandidateSourceChangedDuringMaterialization')
    }
    assertCopiedSourceManifest(runtimeRoot, sourceManifest)
    await installVerificationDependencyFacade({ image: dependencyImage, runtimeRoot })
    createWritableRuntimeDirectories(runtimeRoot)
    const snapshot = buildVerificationSnapshot({ root: runtimeRoot })
    sealCandidateSource(runtimeRoot, sourceManifest)
    const capture = options.captureCompiler
      ? await options.captureCompiler({ runtimeRoot, candidateId: id, snapshot })
      : await captureTestCompiler({
          runtimeRoot,
          candidateId: id,
          snapshot,
          executionRuntime: resolveVerificationDependencyRuntime(dependencyImage),
        })
    const compilerCohort = buildTestCompilerCohort({ snapshot, capture })
    assertValidCompilerCohort(compilerCohort, snapshot)
    assertCopiedSourceManifest(runtimeRoot, sourceManifest, true)
    assertVerificationDependencyFacade({ image: dependencyImage, runtimeRoot })
    assertVerificationDependencyImageUnchanged(dependencyImage)

    const dependency = dependencyReference(dependencyImage)
    const envelopeWithoutDigest = {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      kind: 'materialized-verification-candidate',
      id,
      waveId: admission.waveId,
      dependency,
      sourceManifest,
      snapshot,
      compilerCohort,
    }
    const envelope = deepFreeze({
      ...envelopeWithoutDigest,
      digest: digestJson(envelopeWithoutDigest),
    })
    writeFileSync(resolve(temporaryDirectory, 'candidate.json'), `${JSON.stringify(envelope)}\n`, {
      flag: 'wx',
      mode: 0o444,
    })
    renameSync(temporaryDirectory, directory)
    const candidate = mintCandidateCapability(envelope, evidenceRoot, dependencyImage)
    VALIDATED_CANDIDATES.add(candidate)
    return candidate
  } catch (error) {
    makeTreeWritable(temporaryDirectory)
    rmSync(temporaryDirectory, { recursive: true, force: true })
    throw error
  }
}

export function readMaterializedVerificationCandidate(options) {
  const evidenceRoot = resolve(options.evidenceRoot)
  const id = assertCandidateId(options.id)
  const envelope = JSON.parse(
    readFileSync(
      resolve(verificationCandidateDirectory(evidenceRoot, id), 'candidate.json'),
      'utf8',
    ),
  )
  validateCandidateEnvelope(envelope, id, options.manifest)
  const dependencyImage = readVerificationDependencyImage({
    evidenceRoot,
    id: envelope.dependency.imageId,
  })
  validateDependencyReference(envelope.dependency, dependencyImage)
  const candidate = mintCandidateCapability(deepFreeze(envelope), evidenceRoot, dependencyImage)
  assertMaterializedVerificationCandidateUnchanged(candidate)
  return candidate
}

export function assertMaterializedVerificationCandidate(value) {
  if (!MATERIALIZED_CANDIDATES.has(value)) {
    throw new Error('VerificationImmutableCandidateRequired')
  }
  return value
}

export function assertMaterializedVerificationCandidateUnchanged(value) {
  const candidate = assertMaterializedVerificationCandidate(value)
  assertCopiedSourceManifest(candidate.runtimeRoot, candidate.sourceManifest, true)
  assertVerificationDependencyImageUnchanged(candidate.dependencyImage)
  assertVerificationDependencyFacade({
    image: candidate.dependencyImage,
    runtimeRoot: candidate.runtimeRoot,
  })
  const snapshot = buildVerificationSnapshot({ root: candidate.runtimeRoot })
  if (snapshot.digest !== candidate.snapshot.digest) {
    throw new Error('VerificationCandidateSnapshotChanged')
  }
  assertValidCompilerCohort(candidate.compilerCohort, candidate.snapshot)
  VALIDATED_CANDIDATES.add(candidate)
  return candidate
}

export function assertMaterializedVerificationCandidateExecutionReady(value) {
  const candidate = assertMaterializedVerificationCandidate(value)
  if (!VALIDATED_CANDIDATES.has(candidate)) {
    throw new Error('VerificationCandidateFullValidationRequired')
  }
  if (candidate.compilerCohort.status !== 'resolved') {
    throw new Error(`VerificationCandidateCompilerCohortOpen:${candidate.compilerCohort.status}`)
  }
  return candidate
}

export async function resolveVerificationCandidateRuntime(value) {
  const candidate = assertMaterializedVerificationCandidateExecutionReady(value)
  const dependencyRuntime = resolveVerificationDependencyRuntime(candidate.dependencyImage)
  const require = createRequire(resolve(candidate.runtimeRoot, 'package.json'))
  const packageJsonPath = require.resolve(
    `${candidate.compilerCohort.compiler.packageSpecifier}/package.json`,
  )
  const packageJsonBytes = readFileSync(packageJsonPath)
  const packageJson = JSON.parse(packageJsonBytes.toString('utf8'))
  const cliEntryPath = resolve(dirname(packageJsonPath), packageJson.bin?.tsc ?? '')
  const cliEntryBytes = readFileSync(cliEntryPath)
  const getExePathModule = await import(
    `${pathToFileURL(resolve(dirname(packageJsonPath), 'lib/getExePath.js')).href}?candidate-runtime=${candidate.id}`
  )
  const nativeExecutablePath = getExePathModule.default()
  const nativeExecutableBytes = readFileSync(nativeExecutablePath)
  const nativePackageJsonBytes = readFileSync(
    resolve(dirname(nativeExecutablePath), '../package.json'),
  )
  const expected = candidate.compilerCohort.compiler
  const actual = {
    packageSpecifier: expected.packageSpecifier,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    packageJsonSha256: sha256(packageJsonBytes),
    cliEntrySha256: sha256(cliEntryBytes),
    nodeExecutableSha256: dependencyRuntime.identity.nodeExecutableSha256,
    nodeExecutableByteLength: dependencyRuntime.identity.nodeExecutableByteLength,
    nativePackageJsonSha256: sha256(nativePackageJsonBytes),
    nativeExecutableSha256: sha256(nativeExecutableBytes),
    nativeExecutableByteLength: nativeExecutableBytes.byteLength,
    nodeVersion: dependencyRuntime.identity.nodeVersion,
    platform: dependencyRuntime.identity.platform,
    arch: dependencyRuntime.identity.arch,
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('VerificationCandidateCompilerRuntimeMismatch')
  }
  const runtime = Object.freeze({
    nodeExecutablePath: dependencyRuntime.nodeExecutablePath,
    pnpmExecutablePath: dependencyRuntime.pnpmExecutablePath,
    compilerCliEntryPath: cliEntryPath,
    nativeExecutablePath,
  })
  CANDIDATE_RUNTIMES.add(runtime)
  return runtime
}

export function resetMaterializedVerificationCandidateWritableState(value) {
  const candidate = assertMaterializedVerificationCandidateExecutionReady(value)
  for (const path of [...RUNTIME_DIRECTORIES, ...DEPENDENCY_RUNTIME_DIRECTORIES]) {
    resetWritableDirectory(resolve(candidate.runtimeRoot, path))
  }
  return candidate
}

export function installMaterializedVerificationCandidateRuntime(value, runtime) {
  const candidate = assertMaterializedVerificationCandidateExecutionReady(value)
  if (!CANDIDATE_RUNTIMES.has(runtime)) {
    throw new Error('VerificationCandidateRuntimeCapabilityRequired')
  }
  const toolBin = candidate.runtimePaths.toolBin
  if (readdirSync(toolBin).length !== 0) {
    throw new Error('VerificationCandidateRuntimeToolBinNotEmpty')
  }
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const pnpmName = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  symlinkSync(runtime.nodeExecutablePath, resolve(toolBin, nodeName), 'file')
  symlinkSync(runtime.pnpmExecutablePath, resolve(toolBin, pnpmName), 'file')
  if (
    realpathSync(resolve(toolBin, nodeName)) !== realpathSync(runtime.nodeExecutablePath) ||
    realpathSync(resolve(toolBin, pnpmName)) !== realpathSync(runtime.pnpmExecutablePath)
  ) {
    throw new Error('VerificationCandidateRuntimeToolBinMismatch')
  }
  return candidate
}

export function discardMaterializedVerificationCandidate(value) {
  const candidate = assertMaterializedVerificationCandidate(value)
  const directory = verificationCandidateDirectory(candidate.evidenceRoot, candidate.id)
  makeTreeWritable(directory)
  rmSync(directory, { recursive: true, force: true })
  MATERIALIZED_CANDIDATES.delete(candidate)
  VALIDATED_CANDIDATES.delete(candidate)
}

export function verificationCandidateDirectory(evidenceRoot, candidateId) {
  return resolve(
    evidenceRoot,
    'test-results/verification-slice/candidates',
    assertCandidateId(candidateId),
  )
}

async function buildSourceManifest(root, inputPaths) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error('VerificationCandidateSourceInventoryEmpty')
  }
  if (inputPaths.length > MAX_SOURCE_FILES) {
    throw new Error('VerificationCandidateSourceInventoryTooLarge')
  }
  const paths = inputPaths.map(assertSourcePath).sort(compareText)
  if (new Set(paths).size !== paths.length) {
    throw new Error('VerificationCandidateSourceInventoryDuplicate')
  }
  const entries = []
  let totalBytes = 0
  for (const path of paths) {
    const entry = sourceManifestEntry(root, path)
    totalBytes += entry.byteLength
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error('VerificationCandidateSourceInventoryBytesExceeded')
    }
    entries.push(entry)
  }
  const withoutDigest = {
    schemaVersion: SOURCE_MANIFEST_SCHEMA_VERSION,
    fileCount: entries.length,
    totalBytes,
    entries,
  }
  return deepFreeze({ ...withoutDigest, digest: digestJson(withoutDigest) })
}

function sourceManifestEntry(root, path) {
  const absolutePath = exactSourcePath(root, path)
  const metadata = lstatSync(absolutePath, { throwIfNoEntry: false })
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`VerificationCandidateSourceKindForbidden:${path}`)
  }
  if (metadata.size > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`VerificationCandidateSourceFileTooLarge:${path}`)
  }
  const bytes = readFileSync(absolutePath)
  if (bytes.byteLength !== metadata.size) {
    throw new Error(`VerificationCandidateSourceChangedWhileReading:${path}`)
  }
  return Object.freeze({
    path,
    executable: (metadata.mode & 0o111) !== 0,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  })
}

function copySourceManifest(sourceRoot, runtimeRoot, manifest) {
  for (const entry of manifest.entries) {
    const source = exactSourcePath(sourceRoot, entry.path)
    const target = exactSourcePath(runtimeRoot, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target, constants.COPYFILE_FICLONE)
    chmodSync(target, entry.executable ? 0o755 : 0o644)
  }
}

function assertCopiedSourceManifest(runtimeRoot, manifest, requireReadOnly = false) {
  validateSourceManifest(manifest)
  const actualPaths = listCandidateSourceFiles(runtimeRoot)
  const expectedPaths = manifest.entries.map(({ path }) => path)
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('VerificationCandidateSourceEnumerationMismatch')
  }
  for (const expected of manifest.entries) {
    const actual = sourceManifestEntry(runtimeRoot, expected.path)
    if (
      actual.sha256 !== expected.sha256 ||
      actual.byteLength !== expected.byteLength ||
      actual.executable !== expected.executable
    ) {
      throw new Error(`VerificationCandidateSourceDigestMismatch:${expected.path}`)
    }
    if (
      requireReadOnly &&
      (lstatSync(exactSourcePath(runtimeRoot, actual.path)).mode & 0o222) !== 0
    ) {
      throw new Error(`VerificationCandidateSourceWritable:${actual.path}`)
    }
  }
}

function listCandidateSourceFiles(root) {
  const paths = []
  walk(root, '')
  return paths.sort(compareText)
  function walk(directory, prefix) {
    for (const name of readdirSync(directory).sort(compareText)) {
      if (prefix === '' && RESERVED_SOURCE_ROOTS.has(name)) continue
      const path = prefix ? `${prefix}/${name}` : name
      const absolute = resolve(directory, name)
      const metadata = lstatSync(absolute)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) walk(absolute, path)
      else if (metadata.isFile()) paths.push(assertSourcePath(path))
      else throw new Error(`VerificationCandidateSourceKindForbidden:${path}`)
    }
  }
}

function createWritableRuntimeDirectories(runtimeRoot) {
  for (const path of RUNTIME_DIRECTORIES) {
    mkdirSync(resolve(runtimeRoot, path), { recursive: true, mode: 0o755 })
  }
}

function sealCandidateSource(runtimeRoot, manifest) {
  const directories = new Set([runtimeRoot])
  for (const entry of manifest.entries) {
    const absolutePath = exactSourcePath(runtimeRoot, entry.path)
    chmodSync(absolutePath, entry.executable ? 0o555 : 0o444)
    let directory = dirname(absolutePath)
    while (directory !== runtimeRoot) {
      directories.add(directory)
      directory = dirname(directory)
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    chmodSync(directory, 0o555)
  }
}

async function captureTestCompiler({ runtimeRoot, candidateId, snapshot, executionRuntime }) {
  const require = createRequire(resolve(runtimeRoot, 'package.json'))
  const packageJsonPath = require.resolve(
    `${TEST_COMPILER_COHORT_DESCRIPTOR.compiler.packageSpecifier}/package.json`,
  )
  const packageJsonBytes = readFileSync(packageJsonPath)
  const packageJson = JSON.parse(packageJsonBytes.toString('utf8'))
  const cliEntryPath = resolve(dirname(packageJsonPath), packageJson.bin?.tsc ?? '')
  const cliEntryBytes = readFileSync(cliEntryPath)
  const getExePathModule = await import(
    `${pathToFileURL(resolve(dirname(packageJsonPath), 'lib/getExePath.js')).href}?candidate=${candidateId}`
  )
  const nativeExecutablePath = getExePathModule.default()
  const nativeExecutableBytes = readFileSync(nativeExecutablePath)
  const nativePackageJsonBytes = readFileSync(
    resolve(dirname(nativeExecutablePath), '../package.json'),
  )
  const nodeExecutableBytes = readFileSync(executionRuntime.nodeExecutablePath)
  const compiler = Object.freeze({
    packageSpecifier: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.packageSpecifier,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    packageJsonSha256: sha256(packageJsonBytes),
    cliEntrySha256: sha256(cliEntryBytes),
    nodeExecutableSha256: sha256(nodeExecutableBytes),
    nodeExecutableByteLength: nodeExecutableBytes.byteLength,
    nativePackageJsonSha256: sha256(nativePackageJsonBytes),
    nativeExecutableSha256: sha256(nativeExecutableBytes),
    nativeExecutableByteLength: nativeExecutableBytes.byteLength,
    nodeVersion: executionRuntime.identity.nodeVersion,
    platform: executionRuntime.identity.platform,
    arch: executionRuntime.identity.arch,
  })
  const [roots, diagnostics] = await Promise.all([
    captureCompilerInvocation(
      runtimeRoot,
      cliEntryPath,
      TEST_COMPILER_COHORT_DESCRIPTOR.compiler.rootArgs,
      executionRuntime.nodeExecutablePath,
    ),
    captureCompilerInvocation(
      runtimeRoot,
      cliEntryPath,
      TEST_COMPILER_COHORT_DESCRIPTOR.compiler.diagnosticArgs,
      executionRuntime.nodeExecutablePath,
    ),
  ])
  const withoutDigest = {
    schemaVersion: 1,
    candidateId,
    snapshotDigest: snapshot.digest,
    descriptorDigest: TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST,
    compiler,
    roots,
    diagnostics,
  }
  return deepFreeze({ ...withoutDigest, digest: digestJson(withoutDigest) })
}

async function readGitSourceInventory(root, injectedRunProcess) {
  const run = injectedRunProcess ?? runProcess
  const listing = await run('git', ['-C', root, 'ls-files', '--cached', '-z'], {
    cwd: root,
    env: {
      FORCE_COLOR: '0',
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      PATH: process.env.PATH ?? '',
      TZ: 'UTC',
    },
  })
  if (listing.exitCode !== 0 || listing.signal !== null || listing.error !== null) {
    throw new Error('VerificationCandidateSourceInventoryFailed')
  }
  if (listing.stderr.byteLength > 0) throw new Error('VerificationCandidateSourceInventoryStderr')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(listing.stdout)
  } catch {
    throw new Error('VerificationCandidateSourceInventoryUtf8Invalid')
  }
  return text
    .split('\0')
    .filter((path) => path.length > 0)
    .map(assertSourcePath)
    .filter(
      (path) => lstatSync(exactSourcePath(root, path), { throwIfNoEntry: false }) !== undefined,
    )
}

async function captureCompilerInvocation(runtimeRoot, cliEntryPath, args, nodeExecutablePath) {
  const result = await runProcess(nodeExecutablePath, [cliEntryPath, ...args], {
    cwd: runtimeRoot,
    env: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.environment,
  })
  return deepFreeze({
    invocation: {
      packageSpecifier: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.packageSpecifier,
      args,
      environment: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.environment,
    },
    stdout: encodedOutput(result.stdout),
    stderr: encodedOutput(result.stderr),
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
  })
}

function runProcess(command, args, options) {
  return new Promise((resolveProcess) => {
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let error = null
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) child.kill('SIGKILL')
      else stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) child.kill('SIGKILL')
      else stderr.push(Buffer.from(chunk))
    })
    child.once('error', (cause) => {
      error = cause.message
    })
    child.once('close', (exitCode, signal) => {
      resolveProcess({
        exitCode,
        signal,
        error:
          stdoutBytes > MAX_PROCESS_OUTPUT_BYTES || stderrBytes > MAX_PROCESS_OUTPUT_BYTES
            ? 'output-limit'
            : error,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      })
    })
  })
}

function encodedOutput(bytes) {
  return Object.freeze({
    encoding: 'base64',
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    data: bytes.toString('base64'),
  })
}

function assertValidCompilerCohort(cohort, snapshot) {
  const problems = validateTestCompilerCohort(cohort, snapshot)
  if (problems.length > 0) throw new Error(problems[0])
}

function validateCandidateEnvelope(envelope, id, manifest) {
  if (
    envelope?.schemaVersion !== CANDIDATE_SCHEMA_VERSION ||
    envelope?.kind !== 'materialized-verification-candidate' ||
    envelope?.id !== id
  ) {
    throw new Error('VerificationCandidateEnvelopeInvalid')
  }
  const { digest: _digest, ...withoutDigest } = envelope
  if (envelope.digest !== digestJson(withoutDigest)) {
    throw new Error('VerificationCandidateEnvelopeDigestInvalid')
  }
  const admission = verificationCandidateAdmission(manifest)
  if (envelope.waveId !== admission.waveId) throw new Error('VerificationCandidateWaveMismatch')
  validateSourceManifest(envelope.sourceManifest)
  validateDependencyReferenceShape(envelope.dependency)
}

function validateSourceManifest(manifest) {
  if (
    manifest?.schemaVersion !== SOURCE_MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(manifest?.entries) ||
    !Number.isSafeInteger(manifest?.fileCount) ||
    !Number.isSafeInteger(manifest?.totalBytes)
  ) {
    throw new Error('VerificationCandidateSourceManifestInvalid')
  }
  const { digest: _digest, ...withoutDigest } = manifest
  if (manifest.digest !== digestJson(withoutDigest)) {
    throw new Error('VerificationCandidateSourceManifestDigestInvalid')
  }
  const paths = []
  let totalBytes = 0
  for (const entry of manifest.entries) {
    const path = assertSourcePath(entry?.path)
    paths.push(path)
    if (
      typeof entry.executable !== 'boolean' ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > MAX_SOURCE_FILE_BYTES ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`VerificationCandidateSourceManifestEntryInvalid:${path}`)
    }
    totalBytes += entry.byteLength
  }
  if (
    manifest.fileCount !== paths.length ||
    manifest.totalBytes !== totalBytes ||
    totalBytes > MAX_SOURCE_TOTAL_BYTES ||
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => path !== [...paths].sort(compareText)[index])
  ) {
    throw new Error('VerificationCandidateSourceManifestPathsInvalid')
  }
}

function dependencyReference(image) {
  return deepFreeze({
    imageId: image.id,
    imageDigest: image.digest,
    recipeDigest: image.recipe.digest,
    treeDigest: image.tree.digest,
    facadeDigest: image.facade.digest,
  })
}

function validateDependencyReferenceShape(value) {
  if (
    !/^dependency-[0-9a-f]{64}$/u.test(value?.imageId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value?.imageDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value?.recipeDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value?.treeDigest) ||
    !/^sha256:[0-9a-f]{64}$/u.test(value?.facadeDigest)
  ) {
    throw new Error('VerificationCandidateDependencyReferenceInvalid')
  }
}

function validateDependencyReference(reference, image) {
  validateDependencyReferenceShape(reference)
  if (JSON.stringify(reference) !== JSON.stringify(dependencyReference(image))) {
    throw new Error('VerificationCandidateDependencyMismatch')
  }
}

function mintCandidateCapability(envelope, evidenceRoot, dependencyImage) {
  const directory = verificationCandidateDirectory(evidenceRoot, envelope.id)
  const runtimeRoot = resolve(directory, 'workspace')
  const candidate = deepFreeze({
    ...envelope,
    evidenceRoot,
    directory,
    runtimeRoot,
    dependencyImage,
    runtimePaths: {
      cache: resolve(runtimeRoot, '.verification-runtime/cache'),
      home: resolve(runtimeRoot, '.verification-runtime/home'),
      tmp: resolve(runtimeRoot, '.verification-runtime/tmp'),
      toolBin: resolve(runtimeRoot, '.verification-runtime/tool-bin'),
    },
  })
  MATERIALIZED_CANDIDATES.add(candidate)
  return candidate
}

function resetWritableDirectory(path) {
  const metadata = lstatSync(path, { throwIfNoEntry: false })
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
    throw new Error(`VerificationCandidateWritablePathInvalid:${path}`)
  }
  if (!metadata) mkdirSync(path, { recursive: true, mode: 0o755 })
  else {
    chmodSync(path, 0o755)
    for (const entry of readdirSync(path)) {
      const child = resolve(path, entry)
      makeTreeWritable(child)
      rmSync(child, { recursive: true, force: true })
    }
  }
}

function exactSourcePath(root, path) {
  const absolute = resolve(root, path)
  if (repositoryPath(root, absolute) !== path) {
    throw new Error(`VerificationCandidateSourcePathEscape:${path}`)
  }
  return absolute
}

function assertCandidateId(value) {
  if (!/^candidate-[a-f0-9]{16}$/u.test(value)) throw new Error('VerificationCandidateIdInvalid')
  return value
}

function assertSourcePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes('\\') ||
    hasControlCharacter(value) ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error('VerificationCandidateSourcePathInvalid')
  }
  const parts = value.split('/')
  if (
    parts.some((part) => part === '' || part === '.' || part === '..') ||
    RESERVED_SOURCE_ROOTS.has(parts[0]) ||
    isSecretSourcePath(parts)
  ) {
    throw new Error(`VerificationCandidateSourcePathForbidden:${value}`)
  }
  return value
}

function isSecretSourcePath(parts) {
  const name = parts.at(-1)?.toLowerCase()
  return name === 'key.txt' || name === 'keys.json' || name === '.env' || name?.startsWith('.env.')
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true
  }
  return false
}

function repositoryPath(root, path) {
  const value = relative(root, resolve(path)).replaceAll('\\', '/')
  return value === '..' || value.startsWith('../') || value.startsWith('/') ? null : value
}

function makeTreeWritable(root) {
  const metadata = lstatSync(root, { throwIfNoEntry: false })
  if (!metadata) return
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    chmodSync(root, 0o755)
    for (const entry of readdirSync(root)) makeTreeWritable(resolve(root, entry))
  } else if (metadata.isFile()) {
    chmodSync(root, 0o644)
  }
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
