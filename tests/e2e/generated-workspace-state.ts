import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GeneratedWorkspaceFixtureStats } from '../../scripts/generated-workspace-fixture.mjs'
import {
  GENERATED_WORKSPACE_FIXTURE_VERSION,
  GENERATED_WORKSPACE_SCALES,
} from '../../scripts/generated-workspace-fixture.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CACHE_DIRECTORY = resolve(ROOT, 'test-results/.playwright/generated-workspaces')
const CACHE_MANIFEST_PATH = resolve(CACHE_DIRECTORY, 'manifest.json')
const CACHE_INPUT_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
  'scripts/generated-workspace-fixture.mjs',
  'scripts/workspace-provider-fixture.mjs',
  'tests/e2e/generated-workspace-state.ts',
])
const CACHE_INPUT_DIRECTORIES = Object.freeze(['src/core/import-export', 'src/store'])
const TRANSIENT_PROFILE_PATTERN = /\.chromium-profile\.(?:build|run)-/u
const OMITTED_CHROMIUM_PROFILE_NAMES = new Set([
  'DevToolsActivePort',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
])

export type GeneratedWorkspaceStateName = keyof typeof GENERATED_WORKSPACE_SCALES

export interface GeneratedWorkspaceDirectoryFootprint {
  readonly files: number
  readonly bytes: number
}

export interface GeneratedWorkspaceSetupTiming {
  readonly totalMs: number
  readonly browserLaunchMs: number
  readonly publicImportMs: number
  readonly browserCloseMs: number
}

export interface GeneratedWorkspaceStateRecord {
  readonly browserProfilePath: string
  readonly appStorageSchemaVersion: number
  readonly stats: GeneratedWorkspaceFixtureStats
  readonly footprint: GeneratedWorkspaceDirectoryFootprint
  readonly setup: GeneratedWorkspaceSetupTiming
}

export interface GeneratedWorkspaceStateManifest {
  readonly fixtureVersion: number
  readonly fingerprint: string
  readonly origin: string
  readonly playwrightVersion: string
  readonly generatedAt: string
  readonly states: Record<GeneratedWorkspaceStateName, GeneratedWorkspaceStateRecord>
}

export interface GeneratedWorkspaceBrowserProfileClone {
  readonly path: string
  readonly cloneMs: number
  readonly copiedBytes: number
  readonly reflinkFiles: number
  readonly fallbackFiles: number
  release(): Promise<void>
}

export function generatedWorkspaceBrowserProfilePath(name: GeneratedWorkspaceStateName): string {
  return resolve(CACHE_DIRECTORY, `${name}.chromium-profile`)
}

export async function prepareGeneratedWorkspaceCacheDirectory(): Promise<void> {
  await mkdir(CACHE_DIRECTORY, { recursive: true })
  for (const entry of await readdir(CACHE_DIRECTORY, { withFileTypes: true })) {
    if (TRANSIENT_PROFILE_PATTERN.test(entry.name) || entry.name.endsWith('.tmp')) {
      await rm(resolve(CACHE_DIRECTORY, entry.name), { recursive: true, force: true })
    }
  }
}

export async function generatedWorkspaceCacheFingerprint(origin: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(`fixture:${GENERATED_WORKSPACE_FIXTURE_VERSION}\n`)
  hash.update(`origin:${origin}\n`)
  hash.update(`scales:${JSON.stringify(GENERATED_WORKSPACE_SCALES)}\n`)
  const paths = [
    ...CACHE_INPUT_FILES,
    ...(await filesUnderDirectories(CACHE_INPUT_DIRECTORIES)),
  ].sort()
  for (const relativePath of paths) {
    hash.update(`${relativePath}\0`)
    hash.update(await readFile(resolve(ROOT, relativePath)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export async function readReusableGeneratedWorkspaceStateManifest(
  origin: string,
): Promise<GeneratedWorkspaceStateManifest | null> {
  const fingerprint = await generatedWorkspaceCacheFingerprint(origin)
  let value: unknown
  try {
    value = JSON.parse(await readFile(CACHE_MANIFEST_PATH, 'utf8'))
  } catch {
    return null
  }
  if (!isGeneratedWorkspaceStateManifest(value)) return null
  if (
    value.fixtureVersion !== GENERATED_WORKSPACE_FIXTURE_VERSION ||
    value.fingerprint !== fingerprint ||
    value.origin !== origin
  ) {
    return null
  }
  for (const name of Object.keys(GENERATED_WORKSPACE_SCALES) as GeneratedWorkspaceStateName[]) {
    const record = value.states[name]
    if (record.browserProfilePath !== generatedWorkspaceBrowserProfilePath(name)) return null
    if (!(await browserProfileLooksReusable(record))) return null
  }
  return value
}

export async function writeGeneratedWorkspaceStateManifest(
  manifest: GeneratedWorkspaceStateManifest,
): Promise<void> {
  await prepareGeneratedWorkspaceCacheDirectory()
  await writeAtomically(CACHE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function generatedWorkspaceTemporaryBrowserProfilePath(
  name: GeneratedWorkspaceStateName,
  purpose: 'build' | 'run',
): Promise<string> {
  await prepareGeneratedWorkspaceCacheDirectory()
  const path = `${generatedWorkspaceBrowserProfilePath(name)}.${purpose}-${process.pid}-${randomUUID()}`
  await mkdir(path, { recursive: true })
  return path
}

export async function commitGeneratedWorkspaceBrowserProfile(
  name: GeneratedWorkspaceStateName,
  temporaryPath: string,
): Promise<string> {
  const path = generatedWorkspaceBrowserProfilePath(name)
  await rm(path, { recursive: true, force: true })
  await rename(temporaryPath, path)
  return path
}

export async function cloneGeneratedWorkspaceBrowserProfile(
  name: GeneratedWorkspaceStateName,
): Promise<GeneratedWorkspaceBrowserProfileClone> {
  const source = generatedWorkspaceBrowserProfilePath(name)
  const destination = await generatedWorkspaceTemporaryBrowserProfilePath(name, 'run')
  const startedAt = performance.now()
  const copy = await copyDirectory(source, destination)
  const cloneMs = performance.now() - startedAt
  return {
    path: destination,
    cloneMs,
    copiedBytes: copy.bytes,
    reflinkFiles: copy.reflinkFiles,
    fallbackFiles: copy.fallbackFiles,
    release: () => rm(destination, { recursive: true, force: true }),
  }
}

export async function generatedWorkspaceDirectoryFootprint(
  path: string,
): Promise<GeneratedWorkspaceDirectoryFootprint> {
  const footprint = { files: 0, bytes: 0 }
  await walkDirectory(path, async (entryPath, kind) => {
    if (kind !== 'file') return
    footprint.files += 1
    footprint.bytes += (await stat(entryPath)).size
  })
  return footprint
}

export async function removeObsoleteGeneratedWorkspaceStateFiles(): Promise<void> {
  for (const name of Object.keys(GENERATED_WORKSPACE_SCALES) as GeneratedWorkspaceStateName[]) {
    await rm(resolve(CACHE_DIRECTORY, `${name}.storage-state.json`), { force: true })
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, content)
  await rename(temporaryPath, path)
}

async function browserProfileLooksReusable(
  record: GeneratedWorkspaceStateRecord,
): Promise<boolean> {
  try {
    if (!(await stat(record.browserProfilePath)).isDirectory()) return false
    if (!(await stat(resolve(record.browserProfilePath, 'Default/IndexedDB'))).isDirectory()) {
      return false
    }
    const footprint = await generatedWorkspaceDirectoryFootprint(record.browserProfilePath)
    return (
      footprint.files === record.footprint.files &&
      footprint.bytes === record.footprint.bytes &&
      footprint.bytes > 1_024
    )
  } catch {
    return false
  }
}

async function copyDirectory(
  source: string,
  destination: string,
): Promise<{ bytes: number; reflinkFiles: number; fallbackFiles: number }> {
  const result = { bytes: 0, reflinkFiles: 0, fallbackFiles: 0 }
  await walkDirectory(source, async (entryPath, kind) => {
    const relativePath = relative(source, entryPath)
    if (relativePath === '') return
    if (OMITTED_CHROMIUM_PROFILE_NAMES.has(relativePath.split('/').at(-1) ?? '')) return
    const target = resolve(destination, relativePath)
    if (kind === 'directory') {
      await mkdir(target, { recursive: true })
      return
    }
    await mkdir(dirname(target), { recursive: true })
    if (kind === 'symlink') {
      await symlink(await readlink(entryPath), target)
      return
    }
    const size = (await stat(entryPath)).size
    result.bytes += size
    try {
      await copyFile(entryPath, target, constants.COPYFILE_FICLONE_FORCE)
      result.reflinkFiles += 1
    } catch (error) {
      if (!isReflinkUnsupported(error)) throw error
      await copyFile(entryPath, target)
      result.fallbackFiles += 1
    }
  })
  return result
}

async function walkDirectory(
  root: string,
  visit: (path: string, kind: 'directory' | 'file' | 'symlink') => Promise<void>,
): Promise<void> {
  const pending = [root]
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const path = pending[cursor]
    if (path === undefined) throw new Error('GeneratedWorkspaceDirectoryWalkCorrupt')
    const info = await lstat(path)
    const kind = info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'file'
    await visit(path, kind)
    if (kind !== 'directory') continue
    const children = await readdir(path)
    children.sort()
    for (const child of children) pending.push(resolve(path, child))
  }
}

async function filesUnderDirectories(directories: readonly string[]): Promise<string[]> {
  const files: string[] = []
  for (const directory of directories) {
    await walkDirectory(resolve(ROOT, directory), async (path, kind) => {
      if (kind === 'file' && /\.[cm]?[jt]sx?$/u.test(path)) files.push(relative(ROOT, path))
    })
  }
  return files
}

function isReflinkUnsupported(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== 'string') return false
  return ['ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(error.code)
}

function isGeneratedWorkspaceStateManifest(
  value: unknown,
): value is GeneratedWorkspaceStateManifest {
  if (!isRecord(value) || !isRecord(value.states)) return false
  if (
    typeof value.fixtureVersion !== 'number' ||
    typeof value.fingerprint !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.playwrightVersion !== 'string' ||
    typeof value.generatedAt !== 'string'
  ) {
    return false
  }
  for (const name of Object.keys(GENERATED_WORKSPACE_SCALES)) {
    const record = value.states[name]
    if (
      !isRecord(record) ||
      typeof record.browserProfilePath !== 'string' ||
      typeof record.appStorageSchemaVersion !== 'number' ||
      !isRecord(record.stats) ||
      !isDirectoryFootprint(record.footprint) ||
      !isSetupTiming(record.setup)
    ) {
      return false
    }
  }
  return true
}

function isDirectoryFootprint(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.files) &&
    Number.isSafeInteger(value.bytes) &&
    Number(value.files) >= 0 &&
    Number(value.bytes) >= 0
  )
}

function isSetupTiming(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['totalMs', 'browserLaunchMs', 'publicImportMs', 'browserCloseMs'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
