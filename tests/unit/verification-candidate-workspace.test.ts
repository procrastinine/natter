import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TEST_COMPILER_COHORT_DESCRIPTOR,
  TEST_COMPILER_COHORT_DESCRIPTOR_DIGEST,
  type TestCompilerCapture,
  type TestCompilerExecutionCapture,
} from '../../scripts/test-compiler-cohort.mjs'
import type { VerificationCandidateAdmissionManifest } from '../../scripts/verification-candidate-admission.mjs'
import {
  assertMaterializedVerificationCandidate,
  assertMaterializedVerificationCandidateExecutionReady,
  assertMaterializedVerificationCandidateUnchanged,
  discardMaterializedVerificationCandidate,
  type MaterializedVerificationCandidate,
  materializeVerificationCandidate,
  readMaterializedVerificationCandidate,
  resetMaterializedVerificationCandidateWritableState,
} from '../../scripts/verification-candidate-workspace.mjs'
import {
  discardVerificationDependencyImage,
  prepareVerificationDependencyImage,
  type VerificationDependencyImage,
  type VerificationDependencyProcessResult,
  type VerificationDependencyRuntimeIdentity,
} from '../../scripts/verification-dependency-image.mjs'
import type { VerificationSnapshot } from '../../scripts/verification-impact-plan.mjs'

const roots: string[] = []
const candidates: MaterializedVerificationCandidate[] = []
const images: VerificationDependencyImage[] = []
const manifest: VerificationCandidateAdmissionManifest = {
  id: 'wave-test',
  mode: 'coherence/gate',
  sourceObligations: [],
  costObligations: ['full-gate-remains-open'],
}
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
  for (const candidate of candidates.splice(0)) {
    try {
      discardMaterializedVerificationCandidate(candidate)
    } catch {
      makeTreeWritable(candidate.directory)
      rmSync(candidate.directory, { recursive: true, force: true })
    }
  }
  for (const image of images.splice(0)) {
    try {
      discardVerificationDependencyImage(image)
    } catch {
      makeTreeWritable(image.directory)
      rmSync(image.directory, { recursive: true, force: true })
    }
  }
  for (const root of roots.splice(0)) {
    makeTreeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('materialized verification candidate', () => {
  it('copies one exact source state and reloads a path-independent sealed capability', async () => {
    const fixture = await candidateFixture()
    const candidate = await materializeVerificationCandidate({
      sourceRoot: fixture.root,
      dependencyImage: fixture.image,
      manifest,
      sourcePathInventory: () => fixture.paths,
      captureCompiler: resolvedCompilerCapture,
    })
    candidates.push(candidate)

    expect(candidate.runtimeRoot).not.toBe(fixture.root)
    expect(candidate.waveId).toBe('wave-test')
    expect(candidate.compilerCohort.status).toBe('resolved')
    expect(candidate.compilerCohort.roots.map(({ path }) => path)).toEqual([
      'tests/current.test.ts',
    ])
    expect(candidate).not.toHaveProperty('relativeRuntimeRoot')
    expect(candidate.dependency.imageId).toBe(fixture.image.id)
    expect(candidate.dependency.facadeDigest).toBe(fixture.image.facade.digest)
    expect(readFileSync(resolve(candidate.runtimeRoot, 'src/value.ts'), 'utf8')).toBe(
      'export const value = 1\n',
    )
    writeFileSync(resolve(fixture.root, 'src/value.ts'), 'export const value = 2\n')
    expect(readFileSync(resolve(candidate.runtimeRoot, 'src/value.ts'), 'utf8')).toBe(
      'export const value = 1\n',
    )
    expect(() =>
      writeFileSync(resolve(candidate.runtimeRoot, 'src/value.ts'), 'export const value = 3\n'),
    ).toThrow()
    writeFileSync(resolve(candidate.runtimePaths.tmp, 'probe'), 'writable\n')
    writeFileSync(resolve(candidate.runtimeRoot, 'node_modules/.cache/probe'), 'cached\n')
    resetMaterializedVerificationCandidateWritableState(candidate)
    expect(readdirSync(candidate.runtimePaths.tmp)).toEqual([])
    expect(readdirSync(resolve(candidate.runtimeRoot, 'node_modules/.cache'))).toEqual([])

    const reloaded = readMaterializedVerificationCandidate({
      evidenceRoot: fixture.root,
      id: candidate.id,
      manifest,
    })
    candidates.push(reloaded)
    expect(assertMaterializedVerificationCandidateExecutionReady(reloaded)).toBe(reloaded)
    expect(reloaded.digest).toBe(candidate.digest)
    expect(() => assertMaterializedVerificationCandidate({ ...candidate })).toThrow(
      'VerificationImmutableCandidateRequired',
    )
  })

  it('uses only tracked paths for the default candidate inventory', async () => {
    const fixture = await candidateFixture()
    write(fixture.root, 'unrelated-local-file.html', '<!doctype html>local only\n')
    const calls: string[][] = []
    const candidate = await materializeVerificationCandidate({
      sourceRoot: fixture.root,
      dependencyImage: fixture.image,
      manifest,
      runProcess: async (command, args) => {
        expect(command).toBe('git')
        calls.push([...args])
        return {
          ...successfulProcess(),
          stdout: Buffer.from(`${fixture.paths.join('\0')}\0`),
        }
      },
      captureCompiler: resolvedCompilerCapture,
    })
    candidates.push(candidate)

    expect(calls).toEqual([
      ['-C', fixture.root, 'ls-files', '--cached', '-z'],
      ['-C', fixture.root, 'ls-files', '--cached', '-z'],
    ])
    expect(candidate.sourceManifest.entries.map(({ path }) => path)).toEqual(fixture.paths)
    expect(
      lstatSync(resolve(candidate.runtimeRoot, 'unrelated-local-file.html'), {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined()
  })

  it('persists a pending compiler cohort for adaptation but refuses to execute it', async () => {
    const fixture = await candidateFixture()
    const candidate = await materializeVerificationCandidate({
      sourceRoot: fixture.root,
      dependencyImage: fixture.image,
      manifest,
      sourcePathInventory: () => fixture.paths,
      captureCompiler: async ({ candidateId, snapshot }) =>
        compilerCapture(candidateId, snapshot, {
          diagnostics: "tests/current.test.ts(1,1): error TS2304: Cannot find name 'missing'.\n",
          exitCode: 2,
        }),
    })
    candidates.push(candidate)

    expect(candidate.compilerCohort.status).toBe('pending')
    expect(() => assertMaterializedVerificationCandidateUnchanged(candidate)).not.toThrow()
    expect(() => assertMaterializedVerificationCandidateExecutionReady(candidate)).toThrow(
      'VerificationCandidateCompilerCohortOpen:pending',
    )
  })

  it('blocks materialization while source obligations remain open even if costs are empty', async () => {
    const fixture = await candidateFixture()
    await expect(
      materializeVerificationCandidate({
        sourceRoot: fixture.root,
        dependencyImage: fixture.image,
        manifest: {
          ...manifest,
          sourceObligations: ['adapt-preserved-tests'],
          costObligations: [],
        },
        sourcePathInventory: () => fixture.paths,
        captureCompiler: resolvedCompilerCapture,
      }),
    ).rejects.toThrow(
      'VerificationCandidateBeforeSourceFreeze:coherence/gate:adapt-preserved-tests',
    )
  })

  it('rejects traversal, secret, reserved and symbolic-link source inventory entries', async () => {
    const fixture = await candidateFixture()
    for (const path of ['src/../outside.ts', 'src\\outside.ts', 'keys.json', 'node_modules/x.ts']) {
      await expect(
        materializeVerificationCandidate({
          sourceRoot: fixture.root,
          dependencyImage: fixture.image,
          manifest,
          sourcePathInventory: () => [...fixture.paths, path],
          captureCompiler: resolvedCompilerCapture,
        }),
      ).rejects.toThrow(/VerificationCandidateSourcePath/u)
    }
    symlinkSync('value.ts', resolve(fixture.root, 'src/link.ts'))
    await expect(
      materializeVerificationCandidate({
        sourceRoot: fixture.root,
        dependencyImage: fixture.image,
        manifest,
        sourcePathInventory: () => [...fixture.paths, 'src/link.ts'],
        captureCompiler: resolvedCompilerCapture,
      }),
    ).rejects.toThrow('VerificationCandidateSourceKindForbidden:src/link.ts')
  })

  it('detects a source inventory or byte change between its two capture passes', async () => {
    const fixture = await candidateFixture()
    let call = 0
    await expect(
      materializeVerificationCandidate({
        sourceRoot: fixture.root,
        dependencyImage: fixture.image,
        manifest,
        sourcePathInventory: () => {
          call += 1
          if (call === 1) return fixture.paths
          write(fixture.root, 'src/added.ts', 'export const added = true\n')
          return [...fixture.paths, 'src/added.ts']
        },
        captureCompiler: resolvedCompilerCapture,
      }),
    ).rejects.toThrow('VerificationCandidateSourceChangedDuringMaterialization')
  })
})

async function candidateFixture(): Promise<{
  root: string
  image: VerificationDependencyImage
  paths: string[]
}> {
  const root = mkdtempSync(resolve(tmpdir(), 'natter-verification-candidate-'))
  roots.push(root)
  const storeRoot = resolve(root, 'pnpm-store')
  mkdirSync(storeRoot)
  write(root, '.node-version', '26.1.0\n')
  write(root, '.npmrc', 'fund=false\n')
  write(
    root,
    'package.json',
    '{"name":"candidate-fixture","private":true,"type":"module","packageManager":"pnpm@11.15.0","engines":{"node":"26.1.0"}}\n',
  )
  write(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n')
  write(root, 'pnpm-workspace.yaml', 'packages:\n  - .\n')
  mkdirSync(resolve(root, 'patches'))
  write(
    root,
    'tsconfig.test.json',
    JSON.stringify({
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler',
        noEmit: true,
        strict: true,
        target: 'es2022',
      },
      files: ['./tests/current.test.ts'],
    }),
  )
  write(root, 'src/value.ts', 'export const value = 1\n')
  write(root, 'tests/current.test.ts', "import { value } from '../src/value'\nvoid value\n")
  write(root, 'scripts/tool.mjs', '#!/usr/bin/env node\n')
  chmodSync(resolve(root, 'scripts/tool.mjs'), 0o755)
  const image = await prepareVerificationDependencyImage({
    sourceRoot: root,
    storeRoot,
    runtime,
    runProcess: async (invocation) => {
      mkdirSync(resolve(invocation.cwd, 'node_modules/.pnpm'), { recursive: true })
      return successfulProcess()
    },
  })
  images.push(image)
  return {
    root,
    image,
    paths: [
      '.node-version',
      '.npmrc',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/tool.mjs',
      'src/value.ts',
      'tests/current.test.ts',
      'tsconfig.test.json',
    ],
  }
}

async function resolvedCompilerCapture(options: {
  candidateId: string
  snapshot: VerificationSnapshot
}): Promise<TestCompilerCapture> {
  return compilerCapture(options.candidateId, options.snapshot)
}

function compilerCapture(
  candidateId: string,
  snapshot: VerificationSnapshot,
  options: { diagnostics?: string; exitCode?: number } = {},
): TestCompilerCapture {
  const withoutDigest = {
    schemaVersion: 1 as const,
    candidateId,
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
    roots: compilerExecution(
      TEST_COMPILER_COHORT_DESCRIPTOR.compiler.rootArgs,
      JSON.stringify({ files: ['./tests/current.test.ts'] }),
    ),
    diagnostics: compilerExecution(
      TEST_COMPILER_COHORT_DESCRIPTOR.compiler.diagnosticArgs,
      options.diagnostics ?? '',
      options.exitCode ?? 0,
    ),
  }
  return { ...withoutDigest, digest: digestJson(withoutDigest) }
}

function compilerExecution(
  args: readonly string[],
  stdout: string,
  exitCode = 0,
): TestCompilerExecutionCapture {
  return {
    invocation: {
      packageSpecifier: '@typescript/native',
      args,
      environment: TEST_COMPILER_COHORT_DESCRIPTOR.compiler.environment,
    },
    stdout: encodedOutput(stdout),
    stderr: encodedOutput(''),
    exitCode,
    signal: null,
    error: null,
  }
}

function encodedOutput(value: string) {
  const bytes = Buffer.from(value)
  return {
    encoding: 'base64' as const,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    data: bytes.toString('base64'),
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
  const absolutePath = resolve(root, path)
  mkdirSync(resolve(absolutePath, '..'), { recursive: true })
  writeFileSync(absolutePath, value)
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
  return `sha256:${sha256(JSON.stringify(value))}`
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
