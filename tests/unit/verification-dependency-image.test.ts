import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertVerificationDependencyFacade,
  assertVerificationDependencyImage,
  assertVerificationDependencyImageUnchanged,
  discardVerificationDependencyImage,
  findPnpmPackageJson,
  installVerificationDependencyFacade,
  prepareVerificationDependencyImage,
  readVerificationDependencyImage,
  resolvePnpmLauncherTarget,
  resolveVerificationDependencyRuntime,
  type VerificationDependencyImage,
  type VerificationDependencyProcessInvocation,
  type VerificationDependencyProcessResult,
  type VerificationDependencyRuntimeIdentity,
} from '../../scripts/verification-dependency-image.mjs'

const roots: string[] = []
const images: VerificationDependencyImage[] = []
const PNPM_ACTION_SETUP_REVISION = '0977fd99725f1db4007ccb2928dbb4e90d06cc86'
const PNPM_ACTION_BOOTSTRAP_VERSION = '11.19.0'
const repositoryPackage = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  packageManager: string
  engines: { node: string }
}
const repositoryNodeVersion = readFileSync(resolve('.node-version'), 'utf8').trim()
const runtime: VerificationDependencyRuntimeIdentity = {
  nodeVersion: 'v26.1.0',
  nodeExecutableSha256: 'a'.repeat(64),
  nodeExecutableByteLength: 123,
  pnpmVersion: '11.15.0',
  pnpmExecutableSha256: 'b'.repeat(64),
  pnpmExecutableByteLength: 456,
  pnpmPackageJsonSha256: 'c'.repeat(64),
  pnpmPackageTreeDigest: `sha256:${'d'.repeat(64)}`,
  pnpmPackageTreeByteLength: 789,
  pnpmPackageTreeFileCount: 12,
  platform: 'linux',
  arch: 'arm64',
  libc: '2.43',
}

afterEach(() => {
  for (const image of images.splice(0)) {
    try {
      discardVerificationDependencyImage(image)
    } catch {
      makeTreeWritable(image.directory)
    }
  }
  for (const root of roots.splice(0)) {
    makeTreeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('verification dependency image', () => {
  it('follows the pinned action self-update shim to the invoked pnpm package', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'natter-pnpm-action-runtime-'))
    roots.push(root)
    const targetVersion = repositoryPackage.packageManager.replace(/^pnpm@/u, '')
    const launcher = resolve(root, 'setup-pnpm/node_modules/.bin/pnpm')
    const bootstrapPackageJson = resolve(root, 'setup-pnpm/node_modules/pnpm/package.json')
    const targetPackageJson = resolve(
      root,
      `pnpm-home/.tools/pnpm/${targetVersion}/node_modules/pnpm/package.json`,
    )
    const target = resolve(
      root,
      `pnpm-home/.tools/pnpm/${targetVersion}/node_modules/pnpm/bin/pnpm.mjs`,
    )
    write(
      root,
      'setup-pnpm/node_modules/pnpm/package.json',
      `${JSON.stringify({
        name: 'pnpm',
        version: PNPM_ACTION_BOOTSTRAP_VERSION,
        main: 'package.json',
        bin: { pnpm: 'bin/pnpm.cjs' },
      })}\n`,
    )
    write(root, 'setup-pnpm/node_modules/pnpm/bin/pnpm.cjs', '#!/usr/bin/env node\n')
    write(
      root,
      `pnpm-home/.tools/pnpm/${targetVersion}/node_modules/pnpm/package.json`,
      `${JSON.stringify({ name: 'pnpm', version: targetVersion, bin: { pnpm: 'bin/pnpm.mjs' } })}\n`,
    )
    write(
      root,
      `pnpm-home/.tools/pnpm/${targetVersion}/node_modules/pnpm/bin/pnpm.mjs`,
      '#!/usr/bin/env node\n',
    )
    write(root, 'setup-pnpm/node_modules/.bin/pnpm', `#!/bin/sh\n# cmd-shim-target=${target}\n`)

    expect(readFileSync(resolve('.github/workflows/verify.yml'), 'utf8')).toContain(
      `pnpm/action-setup@${PNPM_ACTION_SETUP_REVISION}`,
    )
    expect(findPnpmPackageJson(launcher)).toBe(bootstrapPackageJson)
    const resolvedTarget = resolvePnpmLauncherTarget(launcher)
    expect(resolvedTarget).toBe(target)
    expect(findPnpmPackageJson(resolvedTarget)).toBe(targetPackageJson)
  })

  it('rejects cyclic command-shim targets instead of guessing a runtime', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'natter-pnpm-action-cycle-'))
    roots.push(root)
    const first = resolve(root, 'first')
    const second = resolve(root, 'second')
    write(root, 'first', `#!/bin/sh\n# cmd-shim-target=${second}\n`)
    write(root, 'second', `#!/bin/sh\n# cmd-shim-target=${first}\n`)

    expect(() => resolvePnpmLauncherTarget(first)).toThrow(
      'VerificationDependencyPnpmLauncherCycle',
    )
  })

  it('resolves pnpm metadata beside a content-addressed store-link launcher', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'natter-pnpm-runtime-'))
    roots.push(root)
    const launcher = resolve(root, 'links/@/pnpm/11.17.0/hash/bin/pnpm')
    const packageJson = resolve(root, 'links/@/pnpm/11.17.0/hash/node_modules/pnpm/package.json')
    mkdirSync(resolve(launcher, '..'), { recursive: true })
    writeFileSync(launcher, '#!/usr/bin/env node\n')
    write(
      root,
      'links/@/pnpm/11.17.0/hash/node_modules/pnpm/package.json',
      '{"name":"pnpm","version":"11.17.0","main":"package.json","bin":{"pnpm":"bin/pnpm.mjs"}}\n',
    )

    expect(findPnpmPackageJson(launcher)).toBe(packageJson)
  })

  it('builds once with an offline frozen copy install and reuses the sealed recipe image', async () => {
    const fixture = dependencyFixture()
    const invocations: VerificationDependencyProcessInvocation[] = []
    const runInstall = fakeInstaller(fixture.storeRoot, invocations)

    const first = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: runInstall,
    })
    const second = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: runInstall,
    })
    images.push(first, second)

    expect(first.id).toBe(second.id)
    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.args).toEqual([
      '-C',
      first.workspaceRoot,
      'install',
      '--offline',
      '--frozen-lockfile',
      '--frozen-store',
      '--trust-lockfile',
      '--package-import-method=copy',
      '--store-dir',
      fixture.storeRoot,
      '--reporter=append-only',
    ])
    expect(invocations[0]?.env).not.toHaveProperty('OPENROUTER_API_KEY')
    expect(readFileSync(resolve(first.workspaceRoot, 'node_modules/pkg/index.js'), 'utf8')).toBe(
      'export const value = 1\n',
    )
    expect(() => assertVerificationDependencyImage({ ...first })).toThrow(
      'VerificationDependencyImageCapabilityRequired',
    )
    expect(assertVerificationDependencyImage(second)).toBe(second)
    expect(
      readVerificationDependencyImage({ evidenceRoot: fixture.sourceRoot, id: first.id }).digest,
    ).toBe(first.digest)
  })

  it('keys lock and runtime changes to distinct images', async () => {
    const fixture = dependencyFixture()
    const invocations: VerificationDependencyProcessInvocation[] = []
    const runInstall = fakeInstaller(fixture.storeRoot, invocations)
    const first = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: runInstall,
    })
    images.push(first)
    write(fixture.sourceRoot, 'pnpm-lock.yaml', 'lockfileVersion: 9\nchanged: true\n')
    const lockChanged = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: runInstall,
    })
    images.push(lockChanged)
    const runtimeChanged = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime: { ...runtime, libc: '2.44' },
      runProcess: runInstall,
    })
    images.push(runtimeChanged)

    expect(new Set([first.id, lockChanged.id, runtimeChanged.id]).size).toBe(3)
    expect(invocations).toHaveLength(3)
  })

  it('copies package bytes instead of retaining the source store inode or contents', async () => {
    const fixture = dependencyFixture()
    const image = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: fakeInstaller(fixture.storeRoot),
    })
    images.push(image)

    writeFileSync(resolve(fixture.storeRoot, 'pkg-index.js'), 'export const value = 2\n')
    expect(readFileSync(resolve(image.workspaceRoot, 'node_modules/pkg/index.js'), 'utf8')).toBe(
      'export const value = 1\n',
    )
    expect(assertVerificationDependencyImageUnchanged(image)).toBe(image)
  })

  it('rejects an install tree whose package symlink escapes the image', async () => {
    const fixture = dependencyFixture()
    await expect(
      prepareVerificationDependencyImage({
        sourceRoot: fixture.sourceRoot,
        storeRoot: fixture.storeRoot,
        runtime,
        runProcess: async (invocation) => {
          const packageStore = resolve(invocation.cwd, 'node_modules/.pnpm')
          mkdirSync(packageStore, { recursive: true })
          symlinkSync(resolve(fixture.storeRoot, 'pkg-index.js'), resolve(packageStore, 'escape'))
          return successfulProcess()
        },
      }),
    ).rejects.toThrow('VerificationDependencyImageSymlinkAbsolute:node_modules/.pnpm/escape')
  })

  it('rejects incomplete and corrupted persisted images instead of waiting or rebuilding', async () => {
    const fixture = dependencyFixture()
    const image = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: fakeInstaller(fixture.storeRoot),
    })
    images.push(image)
    chmodSync(image.directory, 0o755)
    chmodSync(resolve(image.directory, 'image.json'), 0o644)
    writeFileSync(resolve(image.directory, 'image.json'), '{}\n')
    expect(() =>
      readVerificationDependencyImage({ evidenceRoot: fixture.sourceRoot, id: image.id }),
    ).toThrow('VerificationDependencyImageEnvelopeInvalid')
  })

  it('publishes only a sealed ready image and validates the recipe behind its content address', async () => {
    const fixture = dependencyFixture()
    const image = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: fakeInstaller(fixture.storeRoot),
    })
    images.push(image)
    const readyPath = `${image.directory}.ready.json`

    chmodSync(image.workspaceRoot, 0o755)
    expect(() => assertVerificationDependencyImageUnchanged(image)).toThrow(
      'VerificationDependencyImageWritable',
    )
    chmodSync(image.workspaceRoot, 0o555)

    chmodSync(image.directory, 0o755)
    chmodSync(resolve(image.directory, 'image.json'), 0o644)
    chmodSync(readyPath, 0o644)
    const parsed: unknown = JSON.parse(readFileSync(resolve(image.directory, 'image.json'), 'utf8'))
    const envelope = parsed as {
      recipe: { entries: Array<{ byteLength: number }> }
      digest?: string
    }
    const firstEntry = envelope.recipe.entries[0]
    if (!firstEntry) throw new Error('VerificationDependencyRecipeEntryMissing')
    firstEntry.byteLength += 1
    delete envelope.digest
    envelope.digest = digestJson(envelope)
    writeFileSync(resolve(image.directory, 'image.json'), `${JSON.stringify(envelope)}\n`)
    writeFileSync(
      readyPath,
      `${JSON.stringify({ schemaVersion: 1, imageId: image.id, imageDigest: envelope.digest })}\n`,
    )
    chmodSync(resolve(image.directory, 'image.json'), 0o444)
    chmodSync(image.directory, 0o555)
    chmodSync(readyPath, 0o444)
    expect(() =>
      readVerificationDependencyImage({ evidenceRoot: fixture.sourceRoot, id: image.id }),
    ).toThrow('VerificationDependencyRecipeDigestInvalid')
  })

  it('keeps the image sealed while candidate-local dependency caches remain writable', async () => {
    const fixture = dependencyFixture()
    const image = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: fakeInstaller(fixture.storeRoot),
    })
    images.push(image)
    const runtimeRoot = resolve(fixture.sourceRoot, 'candidate-runtime')
    mkdirSync(runtimeRoot)
    await installVerificationDependencyFacade({ image, runtimeRoot })

    expect(() =>
      writeFileSync(resolve(image.workspaceRoot, 'node_modules/pkg/index.js'), 'mutated\n'),
    ).toThrow()
    writeFileSync(resolve(runtimeRoot, 'node_modules/.cache/probe'), 'ok\n')
    expect(readFileSync(resolve(runtimeRoot, 'node_modules/.cache/probe'), 'utf8')).toBe('ok\n')
    expect(readlinkSync(resolve(runtimeRoot, 'node_modules/.pnpm'))).not.toContain(
      fixture.sourceRoot,
    )
    expect(readFileSync(resolve(runtimeRoot, 'node_modules/pkg/index.js'), 'utf8')).toBe(
      'export const value = 1\n',
    )
    expect(() => assertVerificationDependencyFacade({ image, runtimeRoot })).not.toThrow()

    chmodSync(resolve(runtimeRoot, 'node_modules'), 0o755)
    writeFileSync(resolve(runtimeRoot, 'node_modules/.modules.yaml'), 'untracked\n')
    chmodSync(resolve(runtimeRoot, 'node_modules'), 0o555)
    expect(() => assertVerificationDependencyFacade({ image, runtimeRoot })).toThrow(
      'VerificationDependencyFacadeOmittedFilePresent:.modules.yaml',
    )
    chmodSync(resolve(runtimeRoot, 'node_modules'), 0o755)
    rmSync(resolve(runtimeRoot, 'node_modules/.modules.yaml'))
    chmodSync(resolve(runtimeRoot, 'node_modules'), 0o555)

    chmodSync(resolve(runtimeRoot, 'node_modules/.bin/fixture-tool'), 0o755)
    writeFileSync(resolve(runtimeRoot, 'node_modules/.bin/fixture-tool'), '#!/bin/sh\nexit 9\n')
    chmodSync(resolve(runtimeRoot, 'node_modules/.bin/fixture-tool'), 0o555)
    expect(() => assertVerificationDependencyFacade({ image, runtimeRoot })).toThrow(
      'VerificationDependencyFacadeDigestMismatch',
    )
  })

  it('does not turn a captured identity into permission to use a different runtime', async () => {
    const fixture = dependencyFixture()
    const image = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: fakeInstaller(fixture.storeRoot),
    })
    images.push(image)

    expect(() => resolveVerificationDependencyRuntime(image)).toThrow(
      'VerificationDependencyExecutionRuntimeMismatch',
    )
  })

  it('uses and revalidates the exact production Node and pnpm execution closure', async () => {
    const fixture = dependencyFixture()
    const invocations: VerificationDependencyProcessInvocation[] = []
    const image = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runProcess: fakeInstaller(fixture.storeRoot, invocations),
    })
    images.push(image)

    const capability = resolveVerificationDependencyRuntime(image)
    expect(invocations[0]?.command).toBe(realpathSync(process.execPath))
    expect(invocations[0]?.args[0]).toBe(capability.pnpmExecutablePath)
    expect(capability.nodeExecutablePath).toBe(realpathSync(process.execPath))
    expect(image.recipe.runtime.pnpmPackageTreeByteLength).toBeGreaterThan(1_000_000)
  })

  it("uses the source install's recorded store when a reduced environment would derive another path", async () => {
    const fixture = dependencyFixture()
    const actionStoreLink = resolve(fixture.sourceRoot, 'action-store-link')
    symlinkSync(fixture.storeRoot, actionStoreLink, 'dir')
    write(
      fixture.sourceRoot,
      'node_modules/.modules.yaml',
      `${JSON.stringify({ storeDir: actionStoreLink, virtualStoreDir: '.pnpm' })}\n`,
    )
    const invocations: VerificationDependencyProcessInvocation[] = []
    const image = await prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      runProcess: fakeInstaller(fixture.storeRoot, invocations),
    })
    images.push(image)

    expect(invocations).toHaveLength(1)
    expect(invocations[0]?.command).toBe(realpathSync(process.execPath))
    expect(invocations[0]?.args).toContain(realpathSync(fixture.storeRoot))
    expect(invocations[0]?.args).not.toContain('store')
  })

  it('fails causally when verification starts without a successful source install', async () => {
    const fixture = dependencyFixture()
    await expect(
      prepareVerificationDependencyImage({
        sourceRoot: fixture.sourceRoot,
        runtime,
        runProcess: fakeInstaller(fixture.storeRoot),
      }),
    ).rejects.toThrow('VerificationDependencySourceInstallMetadataMissing:')
  })

  it('admits only one publisher for an incomplete dependency image', async () => {
    const fixture = dependencyFixture()
    let releaseInstall!: () => void
    const installReleased = new Promise<void>((resolveInstall) => {
      releaseInstall = resolveInstall
    })
    const first = prepareVerificationDependencyImage({
      sourceRoot: fixture.sourceRoot,
      storeRoot: fixture.storeRoot,
      runtime,
      runProcess: async (invocation) => {
        await installReleased
        return fakeInstaller(fixture.storeRoot)(invocation)
      },
    })

    await expect(
      prepareVerificationDependencyImage({
        sourceRoot: fixture.sourceRoot,
        storeRoot: fixture.storeRoot,
        runtime,
        runProcess: fakeInstaller(fixture.storeRoot),
      }),
    ).rejects.toThrow('VerificationProcessLeaseActive:dependency-image:')
    releaseInstall()
    const image = await first
    images.push(image)
  })
})

function dependencyFixture(): { sourceRoot: string; storeRoot: string } {
  const sourceRoot = mkdtempSync(resolve(tmpdir(), 'natter-dependency-image-'))
  roots.push(sourceRoot)
  const storeRoot = resolve(sourceRoot, 'pnpm-store')
  mkdirSync(storeRoot)
  writeFileSync(resolve(storeRoot, 'pkg-index.js'), 'export const value = 1\n')
  write(sourceRoot, '.node-version', `${repositoryNodeVersion}\n`)
  write(sourceRoot, '.npmrc', 'fund=false\n')
  write(
    sourceRoot,
    'package.json',
    `${JSON.stringify({
      name: 'fixture',
      private: true,
      packageManager: repositoryPackage.packageManager,
      engines: { node: repositoryPackage.engines.node },
    })}\n`,
  )
  write(sourceRoot, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write(sourceRoot, 'pnpm-workspace.yaml', 'packages:\n  - .\n')
  mkdirSync(resolve(sourceRoot, 'patches'))
  return { sourceRoot, storeRoot }
}

function fakeInstaller(
  storeRoot: string,
  invocations: VerificationDependencyProcessInvocation[] = [],
): (
  invocation: VerificationDependencyProcessInvocation,
) => Promise<VerificationDependencyProcessResult> {
  return async (invocation) => {
    invocations.push(invocation)
    const packageRoot = resolve(invocation.cwd, 'node_modules/.pnpm/pkg@1/node_modules/pkg')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      resolve(packageRoot, 'index.js'),
      readFileSync(resolve(storeRoot, 'pkg-index.js')),
    )
    symlinkSync('.pnpm/pkg@1/node_modules/pkg', resolve(invocation.cwd, 'node_modules/pkg'))
    const binRoot = resolve(invocation.cwd, 'node_modules/.bin')
    mkdirSync(binRoot)
    writeFileSync(resolve(binRoot, 'fixture-tool'), '#!/bin/sh\nexit 0\n')
    chmodSync(resolve(binRoot, 'fixture-tool'), 0o755)
    return successfulProcess()
  }
}

function successfulProcess(): VerificationDependencyProcessResult {
  return {
    exitCode: 0,
    signal: null,
    error: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  }
}

function write(root: string, path: string, value: string): void {
  const absolute = resolve(root, path)
  mkdirSync(resolve(absolute, '..'), { recursive: true })
  writeFileSync(absolute, value)
}

function makeTreeWritable(root: string): void {
  const metadata = lstatSync(root, { throwIfNoEntry: false })
  if (!metadata) return
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    chmodSync(root, 0o755)
    for (const name of readdirSync(root)) makeTreeWritable(resolve(root, name))
  } else if (metadata.isFile()) {
    chmodSync(root, 0o644)
  }
}

function digestJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
