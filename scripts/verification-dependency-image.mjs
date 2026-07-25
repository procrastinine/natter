import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { cp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path'
import { executeFileBackedVerificationProcess } from './verification-process-execution.mjs'
import {
  acquireVerificationProcessLease,
  releaseVerificationProcessLease,
} from './verification-process-lease.mjs'

const DEPENDENCY_IMAGES = new WeakSet()
const VALIDATED_DEPENDENCY_IMAGES = new WeakSet()
const IMAGE_SCHEMA_VERSION = 2
const READY_SCHEMA_VERSION = 1
const MAX_INSTALL_OUTPUT_BYTES = 64 * 1024 * 1024
export const VERIFICATION_DEPENDENCY_RECIPE_FILES = Object.freeze([
  '.node-version',
  '.npmrc',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
])
const FACADE_EXCLUSIONS = Object.freeze(
  new Set([
    '.cache',
    '.modules.yaml',
    '.package-map.json',
    '.pnpm',
    '.pnpm-workspace-state-v1.json',
    '.tmp',
    '.vite',
    '.vite-temp',
  ]),
)
const WRITABLE_FACADE_DIRECTORIES = Object.freeze(['.cache', '.tmp', '.vite', '.vite-temp'])
const OMITTED_FACADE_FILES = Object.freeze([
  '.modules.yaml',
  '.package-map.json',
  '.pnpm-workspace-state-v1.json',
])

export async function prepareVerificationDependencyImage(options) {
  const sourceRoot = resolve(options.sourceRoot)
  const evidenceRoot = resolve(options.evidenceRoot ?? sourceRoot)
  const injectedRunProcess = options.runProcess ?? null
  const runtimeCapability = options.runtime
    ? Object.freeze({
        identity: normalizeRuntimeIdentity(options.runtime),
        nodeExecutablePath: null,
        pnpmExecutablePath: null,
      })
    : currentRuntimeCapability(sourceRoot)
  const recipe = buildDependencyRecipe(sourceRoot, runtimeCapability.identity)
  const id = dependencyImageId(recipe.digest)
  const directory = verificationDependencyImageDirectory(evidenceRoot, id)
  if (dependencyImageIsComplete(directory)) {
    return readVerificationDependencyImage({ evidenceRoot, id, expectedRecipe: recipe })
  }
  const lease = acquireVerificationProcessLease({
    path: `${directory}.build-lease`,
    purpose: `dependency-image:${id}`,
  })

  const workspaceRoot = resolve(directory, 'workspace')
  const buildRoot = resolve(directory, '.build')
  let processSequence = 0
  const runProcess =
    injectedRunProcess ??
    ((invocation) =>
      runInstallProcess(invocation, {
        artifactRoot: directory,
        runDirectory: resolve(buildRoot, 'process-output'),
        id: `dependency-${processSequence++}`,
      }))
  try {
    if (dependencyImageIsComplete(directory)) {
      return readVerificationDependencyImage({ evidenceRoot, id, expectedRecipe: recipe })
    }
    rmSync(verificationDependencyImageReadyPath(directory), { force: true })
    makeTreeWritable(directory)
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    mkdirSync(workspaceRoot)
    copyRecipeInputs(sourceRoot, workspaceRoot, recipe)
    mkdirSync(resolve(buildRoot, 'home'), { recursive: true })
    mkdirSync(resolve(buildRoot, 'tmp'), { recursive: true })
    mkdirSync(resolve(buildRoot, 'cache'), { recursive: true })
    const storeRoot = resolve(
      options.storeRoot ?? (await resolvePnpmStoreRoot(sourceRoot, runtimeCapability, runProcess)),
    )
    if (!lstatSync(storeRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('VerificationDependencyImageStoreMissing')
    }
    const install = dependencyInstallInvocation(
      workspaceRoot,
      storeRoot,
      buildRoot,
      runtimeCapability,
    )
    const result = await runProcess(install)
    if (result.exitCode !== 0 || result.signal !== null || result.error !== null) {
      throw new Error(
        `VerificationDependencyImageInstallFailed:${String(result.exitCode)}:${String(result.signal)}:${String(result.error)}`,
      )
    }
    rmSync(buildRoot, { recursive: true, force: true })
    const packageStore = resolve(workspaceRoot, 'node_modules/.pnpm')
    if (!lstatSync(packageStore, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('VerificationDependencyImagePackageStoreMissing')
    }
    const beforeSeal = inspectDependencyTree(workspaceRoot, { requireReadOnly: false })
    sealTree(workspaceRoot)
    const tree = inspectDependencyTree(workspaceRoot, { requireReadOnly: true })
    if (tree.digest !== beforeSeal.digest) {
      throw new Error('VerificationDependencyImageChangedWhileSealing')
    }
    const facade = inspectDependencyFacade(resolve(workspaceRoot, 'node_modules'), {
      requireReadOnly: true,
    })
    const envelopeWithoutDigest = {
      schemaVersion: IMAGE_SCHEMA_VERSION,
      kind: 'sealed-verification-dependency-image',
      id,
      recipe,
      tree,
      facade,
    }
    const envelope = {
      ...envelopeWithoutDigest,
      digest: digestJson(envelopeWithoutDigest),
    }
    writeFileSync(resolve(directory, 'image.json.tmp'), `${JSON.stringify(envelope)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(resolve(directory, 'image.json.tmp'), resolve(directory, 'image.json'))
    chmodSync(resolve(directory, 'image.json'), 0o444)
    chmodSync(directory, 0o555)
    const ready = Object.freeze({
      schemaVersion: READY_SCHEMA_VERSION,
      imageId: id,
      imageDigest: envelope.digest,
    })
    const readyPath = verificationDependencyImageReadyPath(directory)
    const temporaryReadyPath = `${readyPath}.${process.pid}.tmp`
    writeFileSync(temporaryReadyPath, `${JSON.stringify(ready)}\n`, { flag: 'wx', mode: 0o444 })
    renameSync(temporaryReadyPath, readyPath)
    const image = mintDependencyImage(deepFreeze(envelope), evidenceRoot)
    VALIDATED_DEPENDENCY_IMAGES.add(image)
    return image
  } catch (error) {
    makeTreeWritable(directory)
    rmSync(directory, { recursive: true, force: true })
    rmSync(verificationDependencyImageReadyPath(directory), { force: true })
    throw error
  } finally {
    releaseVerificationProcessLease(lease)
  }
}

export function readVerificationDependencyImage(options) {
  const evidenceRoot = resolve(options.evidenceRoot)
  const id = assertDependencyImageId(options.id)
  const directory = verificationDependencyImageDirectory(evidenceRoot, id)
  const manifestPath = resolve(directory, 'image.json')
  if (!dependencyImageIsComplete(directory)) {
    throw new Error('VerificationDependencyImageBuildIncomplete')
  }
  const envelope = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validateDependencyEnvelope(envelope, id, options.expectedRecipe)
  const ready = JSON.parse(readFileSync(verificationDependencyImageReadyPath(directory), 'utf8'))
  if (
    ready?.schemaVersion !== READY_SCHEMA_VERSION ||
    ready?.imageId !== id ||
    ready?.imageDigest !== envelope.digest
  ) {
    throw new Error('VerificationDependencyImageReadyMarkerInvalid')
  }
  const image = mintDependencyImage(deepFreeze(envelope), evidenceRoot)
  assertVerificationDependencyImageUnchanged(image)
  return image
}

export function assertVerificationDependencyImage(value) {
  if (!DEPENDENCY_IMAGES.has(value))
    throw new Error('VerificationDependencyImageCapabilityRequired')
  return value
}

export function assertVerificationDependencyImageUnchanged(value) {
  const image = assertVerificationDependencyImage(value)
  const directoryMode = lstatSync(image.directory).mode
  const manifestMode = lstatSync(resolve(image.directory, 'image.json')).mode
  const workspaceMode = lstatSync(image.workspaceRoot).mode
  if (
    (directoryMode & 0o222) !== 0 ||
    (manifestMode & 0o222) !== 0 ||
    (workspaceMode & 0o222) !== 0
  ) {
    throw new Error('VerificationDependencyImageWritable')
  }
  const actual = inspectDependencyTree(image.workspaceRoot, { requireReadOnly: true })
  if (JSON.stringify(actual) !== JSON.stringify(image.tree)) {
    throw new Error('VerificationDependencyImageTreeMismatch')
  }
  const facade = inspectDependencyFacade(resolve(image.workspaceRoot, 'node_modules'), {
    requireReadOnly: true,
  })
  if (JSON.stringify(facade) !== JSON.stringify(image.facade)) {
    throw new Error('VerificationDependencyImageFacadeMismatch')
  }
  VALIDATED_DEPENDENCY_IMAGES.add(image)
  return image
}

export function assertVerificationDependencyImageValidated(value) {
  const image = assertVerificationDependencyImage(value)
  if (!VALIDATED_DEPENDENCY_IMAGES.has(image)) {
    throw new Error('VerificationDependencyImageFullValidationRequired')
  }
  return image
}

export async function installVerificationDependencyFacade(options) {
  const image = assertVerificationDependencyImageValidated(options.image)
  const runtimeRoot = resolve(options.runtimeRoot)
  const source = resolve(image.workspaceRoot, 'node_modules')
  const target = resolve(runtimeRoot, 'node_modules')
  if (lstatSync(target, { throwIfNoEntry: false })) {
    throw new Error('VerificationDependencyFacadeAlreadyExists')
  }
  await cp(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    filter(path) {
      const local = relative(source, path).replaceAll('\\', '/')
      if (local === '') return true
      return !FACADE_EXCLUSIONS.has(local.split('/')[0])
    },
  })
  chmodSync(target, 0o755)
  const packageStore = resolve(image.workspaceRoot, 'node_modules/.pnpm')
  const linkTarget = relative(target, packageStore).replaceAll('\\', '/')
  if (linkTarget.length === 0 || isAbsolute(linkTarget)) {
    throw new Error('VerificationDependencyFacadeLinkInvalid')
  }
  symlinkSync(linkTarget, resolve(target, '.pnpm'), 'dir')
  for (const path of WRITABLE_FACADE_DIRECTORIES) {
    mkdirSync(resolve(target, path), { recursive: true, mode: 0o755 })
  }
  sealDependencyFacade(target)
  assertVerificationDependencyFacade({ image, runtimeRoot })
}

export function assertVerificationDependencyFacade(options) {
  const image = assertVerificationDependencyImage(options.image)
  const root = resolve(options.runtimeRoot, 'node_modules')
  const link = resolve(root, '.pnpm')
  const metadata = lstatSync(link, { throwIfNoEntry: false })
  if (!metadata?.isSymbolicLink()) throw new Error('VerificationDependencyFacadeStoreLinkMissing')
  if (realpathSync(link) !== realpathSync(resolve(image.workspaceRoot, 'node_modules/.pnpm'))) {
    throw new Error('VerificationDependencyFacadeStoreLinkMismatch')
  }
  for (const path of WRITABLE_FACADE_DIRECTORIES) {
    const directory = resolve(root, path)
    if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`VerificationDependencyFacadeWritableDirectoryMissing:${path}`)
    }
    if ((lstatSync(directory).mode & 0o200) === 0) {
      throw new Error(`VerificationDependencyFacadeWritableDirectorySealed:${path}`)
    }
  }
  for (const path of OMITTED_FACADE_FILES) {
    if (lstatSync(resolve(root, path), { throwIfNoEntry: false })) {
      throw new Error(`VerificationDependencyFacadeOmittedFilePresent:${path}`)
    }
  }
  if ((lstatSync(root).mode & 0o222) !== 0) {
    throw new Error('VerificationDependencyFacadeRootWritable')
  }
  const actual = inspectDependencyFacade(root, { requireReadOnly: true })
  if (JSON.stringify(actual) !== JSON.stringify(image.facade)) {
    throw new Error('VerificationDependencyFacadeDigestMismatch')
  }
}

export function verificationDependencyRecipeInputPaths(sourceRoot) {
  const paths = [...VERIFICATION_DEPENDENCY_RECIPE_FILES]
  const patchesRoot = resolve(sourceRoot, 'patches')
  const patches = lstatSync(patchesRoot, { throwIfNoEntry: false })
  if (patches) {
    if (!patches.isDirectory() || patches.isSymbolicLink()) {
      throw new Error('VerificationDependencyRecipePatchesInvalid')
    }
    paths.push(...listRegularFiles(patchesRoot).map((path) => `patches/${path}`))
  }
  return Object.freeze(paths.sort(compareText))
}

export function resolveVerificationDependencyRuntime(value) {
  const image = assertVerificationDependencyImage(value)
  const capability = currentRuntimeCapability(image.workspaceRoot)
  if (JSON.stringify(capability.identity) !== JSON.stringify(image.recipe.runtime)) {
    throw new Error('VerificationDependencyExecutionRuntimeMismatch')
  }
  return capability
}

export function discardVerificationDependencyImage(value) {
  const image = assertVerificationDependencyImage(value)
  makeTreeWritable(image.directory)
  rmSync(image.directory, { recursive: true, force: true })
  rmSync(verificationDependencyImageReadyPath(image.directory), { force: true })
  DEPENDENCY_IMAGES.delete(image)
  VALIDATED_DEPENDENCY_IMAGES.delete(image)
}

export function verificationDependencyImageDirectory(evidenceRoot, id) {
  return resolve(
    evidenceRoot,
    'test-results/verification-slice/dependency-images',
    assertDependencyImageId(id),
  )
}

function dependencyImageIsComplete(directory) {
  const root = lstatSync(directory, { throwIfNoEntry: false })
  if (!root) return false
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error('VerificationDependencyImageDirectoryInvalid')
  }
  return (
    lstatSync(resolve(directory, 'image.json'), { throwIfNoEntry: false })?.isFile() === true &&
    lstatSync(verificationDependencyImageReadyPath(directory), {
      throwIfNoEntry: false,
    })?.isFile() === true
  )
}

function verificationDependencyImageReadyPath(directory) {
  return `${directory}.ready.json`
}

function buildDependencyRecipe(sourceRoot, runtime) {
  const entries = []
  const inputPaths = verificationDependencyRecipeInputPaths(sourceRoot)
  for (const path of inputPaths) entries.push(recipeEntry(sourceRoot, path))
  const patches = lstatSync(resolve(sourceRoot, 'patches'), { throwIfNoEntry: false })
  entries.sort((left, right) => compareText(left.path, right.path))
  const normalizedRuntime = normalizeRuntimeIdentity(runtime)
  const withoutDigest = {
    schemaVersion: 1,
    installer: {
      packageManager: 'pnpm',
      offline: true,
      frozenLockfile: true,
      frozenStore: true,
      importMethod: 'copy',
    },
    runtime: normalizedRuntime,
    patchesDirectoryPresent: Boolean(patches),
    entries,
  }
  return deepFreeze({ ...withoutDigest, digest: digestJson(withoutDigest) })
}

async function resolvePnpmStoreRoot(sourceRoot, runtimeCapability, runProcess) {
  if (!runtimeCapability.nodeExecutablePath || !runtimeCapability.pnpmExecutablePath) {
    throw new Error('VerificationDependencyStoreCapabilityRequired')
  }
  const result = await runProcess({
    command: runtimeCapability.nodeExecutablePath,
    args: [
      runtimeCapability.pnpmExecutablePath,
      '--config.manage-package-manager-versions=false',
      `--config.userconfig=${resolve(sourceRoot, '.npmrc')}`,
      '--dir',
      sourceRoot,
      'store',
      'path',
      '--silent',
    ],
    cwd: sourceRoot,
    env: {
      FORCE_COLOR: '0',
      HOME: homedir(),
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      PATH: process.env.PATH ?? '',
      TZ: 'UTC',
      ...(process.env.XDG_DATA_HOME ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {}),
    },
  })
  if (result.exitCode !== 0 || result.signal !== null || result.error !== null) {
    throw new Error('VerificationDependencyStoreResolutionFailed')
  }
  const output = result.stdout.toString('utf8').trim()
  if (!isAbsolute(output) || output.includes('\n') || output.includes('\r')) {
    throw new Error('VerificationDependencyStoreResolutionInvalid')
  }
  return output
}

function recipeEntry(sourceRoot, path) {
  assertRecipePath(path)
  const absolute = resolve(sourceRoot, path)
  const metadata = lstatSync(absolute, { throwIfNoEntry: false })
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`VerificationDependencyRecipeInputInvalid:${path}`)
  }
  const bytes = readFileSync(absolute)
  return Object.freeze({ path, byteLength: bytes.byteLength, sha256: sha256(bytes) })
}

function copyRecipeInputs(sourceRoot, workspaceRoot, recipe) {
  for (const entry of recipe.entries) {
    const target = resolve(workspaceRoot, entry.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(resolve(sourceRoot, entry.path), target)
    const bytes = readFileSync(target)
    if (bytes.byteLength !== entry.byteLength || sha256(bytes) !== entry.sha256) {
      throw new Error(`VerificationDependencyRecipeCopyMismatch:${entry.path}`)
    }
  }
  if (recipe.patchesDirectoryPresent)
    mkdirSync(resolve(workspaceRoot, 'patches'), { recursive: true })
}

function dependencyInstallInvocation(workspaceRoot, storeRoot, buildRoot, runtimeCapability) {
  const exactPnpm = runtimeCapability.pnpmExecutablePath
  const exactNode = runtimeCapability.nodeExecutablePath
  return Object.freeze({
    command: exactPnpm && exactNode ? exactNode : 'pnpm',
    args: Object.freeze([
      ...(exactPnpm ? [exactPnpm] : []),
      '-C',
      workspaceRoot,
      'install',
      '--offline',
      '--frozen-lockfile',
      '--frozen-store',
      '--trust-lockfile',
      '--package-import-method=copy',
      '--store-dir',
      storeRoot,
      '--reporter=append-only',
    ]),
    cwd: workspaceRoot,
    env: Object.freeze({
      CI: '1',
      FORCE_COLOR: '0',
      HOME: resolve(buildRoot, 'home'),
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      PATH: process.env.PATH ?? '',
      TMPDIR: resolve(buildRoot, 'tmp'),
      TZ: 'UTC',
      XDG_CACHE_HOME: resolve(buildRoot, 'cache'),
    }),
  })
}

function currentRuntimeCapability(sourceRoot) {
  const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
  const expectedPnpmVersion = /^pnpm@(.+)$/u.exec(packageJson.packageManager)?.[1]
  if (!expectedPnpmVersion) throw new Error('VerificationDependencyPnpmVersionMissing')
  const pnpmLauncherPath = resolvePnpmExecutable()
  const pnpmPackageJsonPath = findPnpmPackageJson(pnpmLauncherPath)
  const pnpmPackageJsonBytes = readFileSync(pnpmPackageJsonPath)
  const pnpmPackageJson = JSON.parse(pnpmPackageJsonBytes.toString('utf8'))
  if (pnpmPackageJson.name !== 'pnpm' || pnpmPackageJson.version !== expectedPnpmVersion) {
    throw new Error('VerificationDependencyPnpmRuntimeMismatch')
  }
  const pnpmExecutablePath = resolvePnpmPackageExecutable(pnpmPackageJsonPath, pnpmPackageJson)
  const pnpmExecutableBytes = readFileSync(pnpmExecutablePath)
  const declaredNodeVersion = readFileSync(resolve(sourceRoot, '.node-version'), 'utf8').trim()
  if (
    declaredNodeVersion !== process.version.replace(/^v/u, '') ||
    packageJson.engines?.node !== declaredNodeVersion
  ) {
    throw new Error('VerificationDependencyNodeRuntimeMismatch')
  }
  const pnpmPackageTree = inspectRuntimePackageTree(dirname(pnpmPackageJsonPath))
  const nodeBytes = readFileSync(process.execPath)
  const identity = normalizeRuntimeIdentity({
    nodeVersion: process.version,
    nodeExecutableSha256: sha256(nodeBytes),
    nodeExecutableByteLength: nodeBytes.byteLength,
    pnpmVersion: pnpmPackageJson.version,
    pnpmExecutableSha256: sha256(pnpmExecutableBytes),
    pnpmExecutableByteLength: pnpmExecutableBytes.byteLength,
    pnpmPackageJsonSha256: sha256(pnpmPackageJsonBytes),
    pnpmPackageTreeDigest: pnpmPackageTree.digest,
    pnpmPackageTreeByteLength: pnpmPackageTree.totalBytes,
    pnpmPackageTreeFileCount: pnpmPackageTree.fileCount,
    platform: process.platform,
    arch: process.arch,
    libc: process.report?.getReport?.().header.glibcVersionRuntime ?? 'unknown',
  })
  return Object.freeze({
    identity,
    nodeExecutablePath: realpathSync(process.execPath),
    pnpmExecutablePath,
  })
}

function normalizeRuntimeIdentity(value) {
  const normalized = {
    nodeVersion: stringValue(value?.nodeVersion),
    nodeExecutableSha256: stringValue(value?.nodeExecutableSha256),
    nodeExecutableByteLength: integerValue(value?.nodeExecutableByteLength),
    pnpmVersion: stringValue(value?.pnpmVersion),
    pnpmExecutableSha256: stringValue(value?.pnpmExecutableSha256),
    pnpmExecutableByteLength: integerValue(value?.pnpmExecutableByteLength),
    pnpmPackageJsonSha256: stringValue(value?.pnpmPackageJsonSha256),
    pnpmPackageTreeDigest: stringValue(value?.pnpmPackageTreeDigest),
    pnpmPackageTreeByteLength: integerValue(value?.pnpmPackageTreeByteLength),
    pnpmPackageTreeFileCount: integerValue(value?.pnpmPackageTreeFileCount),
    platform: stringValue(value?.platform),
    arch: stringValue(value?.arch),
    libc: stringValue(value?.libc),
  }
  if (
    Object.values(normalized).some((item) => item === '') ||
    !/^[0-9a-f]{64}$/u.test(normalized.nodeExecutableSha256) ||
    !/^[0-9a-f]{64}$/u.test(normalized.pnpmExecutableSha256) ||
    !/^[0-9a-f]{64}$/u.test(normalized.pnpmPackageJsonSha256) ||
    !/^sha256:[0-9a-f]{64}$/u.test(normalized.pnpmPackageTreeDigest) ||
    normalized.nodeExecutableByteLength <= 0 ||
    normalized.pnpmExecutableByteLength <= 0 ||
    normalized.pnpmPackageTreeByteLength <= 0 ||
    normalized.pnpmPackageTreeFileCount <= 0
  ) {
    throw new Error('VerificationDependencyRuntimeIdentityInvalid')
  }
  return Object.freeze(normalized)
}

function resolvePnpmExecutable() {
  const names = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = resolve(directory, name)
      const metadata = lstatSync(candidate, { throwIfNoEntry: false })
      if (metadata?.isFile() || metadata?.isSymbolicLink()) return realpathSync(candidate)
    }
  }
  throw new Error('VerificationDependencyPnpmExecutableMissing')
}

export function findPnpmPackageJson(executablePath) {
  const roots = [dirname(executablePath)]
  try {
    const requireFromExecutable = createRequire(
      resolve(dirname(executablePath), 'verification-runtime.cjs'),
    )
    roots.unshift(dirname(requireFromExecutable.resolve('pnpm')))
  } catch {}
  const visited = new Set()
  for (const root of roots) {
    let directory = root
    for (let depth = 0; depth < 6; depth += 1) {
      if (visited.has(directory)) break
      visited.add(directory)
      const candidate = resolve(directory, 'package.json')
      const metadata = lstatSync(candidate, { throwIfNoEntry: false })
      if (metadata?.isFile()) {
        const value = JSON.parse(readFileSync(candidate, 'utf8'))
        if (value.name === 'pnpm') return candidate
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  throw new Error('VerificationDependencyPnpmPackageMissing')
}

function resolvePnpmPackageExecutable(packageJsonPath, packageJson) {
  const entry =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : typeof packageJson.bin?.pnpm === 'string'
        ? packageJson.bin.pnpm
        : null
  if (
    !entry ||
    isAbsolute(entry) ||
    entry.includes('\\') ||
    entry.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('VerificationDependencyPnpmExecutableInvalid')
  }
  const packageRoot = dirname(packageJsonPath)
  const executablePath = resolve(packageRoot, entry)
  const metadata = lstatSync(executablePath, { throwIfNoEntry: false })
  if (!metadata?.isFile() && !metadata?.isSymbolicLink()) {
    throw new Error('VerificationDependencyPnpmExecutableMissing')
  }
  const realExecutablePath = realpathSync(executablePath)
  if (repositoryPath(packageRoot, realExecutablePath) === null) {
    throw new Error('VerificationDependencyPnpmExecutableEscapesPackage')
  }
  return realExecutablePath
}

function inspectRuntimePackageTree(root) {
  const entries = []
  let fileCount = 0
  let totalBytes = 0
  walk(root, '')
  const withoutDigest = {
    schemaVersion: 1,
    fileCount,
    totalBytes,
    contentDigest: sha256(entries.join('\n')),
  }
  return deepFreeze({ ...withoutDigest, digest: digestJson(withoutDigest) })

  function walk(directory, prefix) {
    for (const name of readdirSync(directory).sort(compareText)) {
      const path = prefix ? `${prefix}/${name}` : name
      const absolute = resolve(directory, name)
      const metadata = lstatSync(absolute)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        entries.push(`d\0${path}`)
        walk(absolute, path)
      } else if (metadata.isFile()) {
        const bytes = readFileSync(absolute)
        fileCount += 1
        totalBytes += bytes.byteLength
        entries.push(
          `f\0${path}\0${(metadata.mode & 0o111) !== 0 ? 'x' : '-'}\0${bytes.byteLength}\0${sha256(bytes)}`,
        )
      } else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(absolute)
        if (isAbsolute(target)) throw new Error(`VerificationDependencyPnpmSymlinkAbsolute:${path}`)
        entries.push(`l\0${path}\0${target}`)
      } else {
        throw new Error(`VerificationDependencyPnpmEntryKindForbidden:${path}`)
      }
    }
  }
}

function inspectDependencyTree(root, options) {
  const entries = []
  let fileCount = 0
  let directoryCount = 0
  let symlinkCount = 0
  let totalBytes = 0
  walk(root, '')
  const withoutDigest = {
    schemaVersion: 1,
    entryCount: entries.length,
    fileCount,
    directoryCount,
    symlinkCount,
    totalBytes,
    contentDigest: sha256(entries.join('\n')),
  }
  return deepFreeze({ ...withoutDigest, digest: digestJson(withoutDigest) })

  function walk(directory, prefix) {
    const names = readdirSync(directory).sort(compareText)
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name
      const absolute = resolve(directory, name)
      const metadata = lstatSync(absolute)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (options.requireReadOnly && (metadata.mode & 0o222) !== 0) {
          throw new Error(`VerificationDependencyImageWritable:${path}`)
        }
        directoryCount += 1
        entries.push(`d\0${path}`)
        walk(absolute, path)
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error(`VerificationDependencyImageHardlink:${path}`)
        if (options.requireReadOnly && (metadata.mode & 0o222) !== 0) {
          throw new Error(`VerificationDependencyImageWritable:${path}`)
        }
        const bytes = readFileSync(absolute)
        fileCount += 1
        totalBytes += bytes.byteLength
        entries.push(
          `f\0${path}\0${(metadata.mode & 0o111) !== 0 ? 'x' : '-'}\0${bytes.byteLength}\0${sha256(bytes)}`,
        )
      } else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(absolute)
        if (isAbsolute(target))
          throw new Error(`VerificationDependencyImageSymlinkAbsolute:${path}`)
        let resolved
        try {
          resolved = realpathSync(absolute)
        } catch {
          throw new Error(`VerificationDependencyImageSymlinkBroken:${path}`)
        }
        if (repositoryPath(root, resolved) === null) {
          throw new Error(`VerificationDependencyImageSymlinkEscape:${path}`)
        }
        symlinkCount += 1
        entries.push(`l\0${path}\0${target}`)
      } else {
        throw new Error(`VerificationDependencyImageEntryKindForbidden:${path}`)
      }
    }
  }
}

function inspectDependencyFacade(root, options) {
  const entries = []
  let fileCount = 0
  let directoryCount = 0
  let symlinkCount = 0
  let totalBytes = 0
  walk(root, '')
  const withoutDigest = {
    schemaVersion: 1,
    entryCount: entries.length,
    fileCount,
    directoryCount,
    symlinkCount,
    totalBytes,
    contentDigest: sha256(entries.join('\n')),
  }
  return deepFreeze({ ...withoutDigest, digest: digestJson(withoutDigest) })

  function walk(directory, prefix) {
    for (const name of readdirSync(directory).sort(compareText)) {
      if (prefix === '' && FACADE_EXCLUSIONS.has(name)) continue
      const path = prefix ? `${prefix}/${name}` : name
      const absolute = resolve(directory, name)
      const metadata = lstatSync(absolute)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (options.requireReadOnly && (metadata.mode & 0o222) !== 0) {
          throw new Error(`VerificationDependencyFacadeWritable:${path}`)
        }
        directoryCount += 1
        entries.push(`d\0${path}`)
        walk(absolute, path)
      } else if (metadata.isFile()) {
        if (metadata.nlink !== 1) throw new Error(`VerificationDependencyFacadeHardlink:${path}`)
        if (options.requireReadOnly && (metadata.mode & 0o222) !== 0) {
          throw new Error(`VerificationDependencyFacadeWritable:${path}`)
        }
        const bytes = readFileSync(absolute)
        fileCount += 1
        totalBytes += bytes.byteLength
        entries.push(
          `f\0${path}\0${(metadata.mode & 0o111) !== 0 ? 'x' : '-'}\0${bytes.byteLength}\0${sha256(bytes)}`,
        )
      } else if (metadata.isSymbolicLink()) {
        const target = readlinkSync(absolute)
        if (isAbsolute(target)) {
          throw new Error(`VerificationDependencyFacadeSymlinkAbsolute:${path}`)
        }
        symlinkCount += 1
        entries.push(`l\0${path}\0${target}`)
      } else {
        throw new Error(`VerificationDependencyFacadeEntryKindForbidden:${path}`)
      }
    }
  }
}

function sealTree(root) {
  const metadata = lstatSync(root)
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    for (const name of readdirSync(root)) sealTree(resolve(root, name))
    chmodSync(root, 0o555)
  } else if (metadata.isFile()) {
    chmodSync(root, (metadata.mode & 0o111) !== 0 ? 0o555 : 0o444)
  }
}

function sealDependencyFacade(root) {
  for (const name of readdirSync(root)) {
    if (WRITABLE_FACADE_DIRECTORIES.includes(name) || name === '.pnpm') continue
    sealTree(resolve(root, name))
  }
  chmodSync(root, 0o555)
}

function validateDependencyEnvelope(envelope, id, expectedRecipe) {
  if (
    envelope?.schemaVersion !== IMAGE_SCHEMA_VERSION ||
    envelope?.kind !== 'sealed-verification-dependency-image' ||
    envelope?.id !== id
  ) {
    throw new Error('VerificationDependencyImageEnvelopeInvalid')
  }
  const { digest: _digest, ...withoutDigest } = envelope
  if (envelope.digest !== digestJson(withoutDigest)) {
    throw new Error('VerificationDependencyImageEnvelopeDigestInvalid')
  }
  validateDependencyRecipe(envelope.recipe)
  if (dependencyImageId(envelope.recipe?.digest) !== id) {
    throw new Error('VerificationDependencyImageRecipeIdMismatch')
  }
  if (expectedRecipe && JSON.stringify(envelope.recipe) !== JSON.stringify(expectedRecipe)) {
    throw new Error('VerificationDependencyImageRecipeMismatch')
  }
  if (envelope.tree?.schemaVersion !== 1 || typeof envelope.tree?.digest !== 'string') {
    throw new Error('VerificationDependencyImageTreeInvalid')
  }
  if (envelope.facade?.schemaVersion !== 1 || typeof envelope.facade?.digest !== 'string') {
    throw new Error('VerificationDependencyImageFacadeInvalid')
  }
}

function validateDependencyRecipe(recipe) {
  const expectedInstaller = {
    packageManager: 'pnpm',
    offline: true,
    frozenLockfile: true,
    frozenStore: true,
    importMethod: 'copy',
  }
  if (
    recipe?.schemaVersion !== 1 ||
    JSON.stringify(recipe?.installer) !== JSON.stringify(expectedInstaller) ||
    typeof recipe?.patchesDirectoryPresent !== 'boolean' ||
    !Array.isArray(recipe?.entries)
  ) {
    throw new Error('VerificationDependencyRecipeInvalid')
  }
  const normalizedRuntime = normalizeRuntimeIdentity(recipe.runtime)
  if (JSON.stringify(normalizedRuntime) !== JSON.stringify(recipe.runtime)) {
    throw new Error('VerificationDependencyRecipeRuntimeInvalid')
  }
  const paths = []
  for (const entry of recipe.entries) {
    const path = assertRecipePath(entry?.path)
    paths.push(path)
    if (
      !Number.isSafeInteger(entry?.byteLength) ||
      entry.byteLength < 0 ||
      !/^[0-9a-f]{64}$/u.test(entry?.sha256)
    ) {
      throw new Error(`VerificationDependencyRecipeEntryInvalid:${path}`)
    }
  }
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => path !== [...paths].sort(compareText)[index]) ||
    VERIFICATION_DEPENDENCY_RECIPE_FILES.some((path) => !paths.includes(path)) ||
    paths.some(
      (path) =>
        !VERIFICATION_DEPENDENCY_RECIPE_FILES.includes(path) && !path.startsWith('patches/'),
    ) ||
    (recipe.patchesDirectoryPresent !== paths.some((path) => path.startsWith('patches/')) &&
      paths.some((path) => path.startsWith('patches/')))
  ) {
    throw new Error('VerificationDependencyRecipePathsInvalid')
  }
  const { digest: _digest, ...withoutDigest } = recipe
  if (recipe.digest !== digestJson(withoutDigest)) {
    throw new Error('VerificationDependencyRecipeDigestInvalid')
  }
}

function mintDependencyImage(envelope, evidenceRoot) {
  const directory = verificationDependencyImageDirectory(evidenceRoot, envelope.id)
  const image = deepFreeze({
    ...envelope,
    evidenceRoot,
    directory,
    workspaceRoot: resolve(directory, 'workspace'),
  })
  DEPENDENCY_IMAGES.add(image)
  return image
}

function listRegularFiles(root) {
  const paths = []
  walk(root, '')
  return paths.sort(compareText)
  function walk(directory, prefix) {
    for (const name of readdirSync(directory).sort(compareText)) {
      const path = prefix ? `${prefix}/${name}` : name
      const absolute = resolve(directory, name)
      const metadata = lstatSync(absolute)
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) walk(absolute, path)
      else if (metadata.isFile()) paths.push(path)
      else throw new Error(`VerificationDependencyRecipeEntryForbidden:${path}`)
    }
  }
}

async function runInstallProcess(invocation, output) {
  const execution = await executeFileBackedVerificationProcess({
    id: output.id,
    artifactRoot: output.artifactRoot,
    runDirectory: output.runDirectory,
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    environment: invocation.env,
    forwardOutput: false,
    diagnosticPrefix: 'VerificationDependencyProcess',
  })
  const stdout = readProcessOutput(output.artifactRoot, execution.stdoutPath)
  const stderr = readProcessOutput(output.artifactRoot, execution.stderrPath)
  return {
    exitCode: execution.exitCode,
    signal: execution.signal,
    error:
      stdout.byteLength > MAX_INSTALL_OUTPUT_BYTES || stderr.byteLength > MAX_INSTALL_OUTPUT_BYTES
        ? 'output-limit'
        : execution.diagnostics.length > 0
          ? execution.diagnostics.join(';')
          : null,
    stdout,
    stderr,
  }
}

function readProcessOutput(artifactRoot, path) {
  return path === null ? Buffer.alloc(0) : readFileSync(resolve(artifactRoot, path))
}

function makeTreeWritable(root) {
  const metadata = lstatSync(root, { throwIfNoEntry: false })
  if (!metadata) return
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    chmodSync(root, 0o755)
    for (const name of readdirSync(root)) makeTreeWritable(resolve(root, name))
  } else if (metadata.isFile()) {
    chmodSync(root, 0o644)
  }
}

function assertRecipePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    hasControlCharacter(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('VerificationDependencyRecipePathInvalid')
  }
  return value
}

function hasControlCharacter(value) {
  for (const character of value) {
    const code = character.codePointAt(0)
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true
  }
  return false
}

function dependencyImageId(digest) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new Error('VerificationDependencyRecipeDigestInvalid')
  }
  return `dependency-${sha256(`${IMAGE_SCHEMA_VERSION}\0${digest}`)}`
}

function assertDependencyImageId(value) {
  if (!/^dependency-[0-9a-f]{64}$/u.test(value)) {
    throw new Error('VerificationDependencyImageIdInvalid')
  }
  return value
}

function repositoryPath(root, path) {
  const value = relative(root, resolve(path)).replaceAll('\\', '/')
  return value === '..' || value.startsWith('../') || value.startsWith('/') ? null : value
}

function stringValue(value) {
  return typeof value === 'string' ? value : ''
}

function integerValue(value) {
  return Number.isSafeInteger(value) ? value : -1
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
