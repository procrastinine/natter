import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { posix, resolve } from 'node:path'
import { currentWaveManifest } from './current-wave-manifest.mjs'
import { discoverLocalModulePaths } from './local-module-graph.mjs'
import { buildVerificationSnapshot } from './verification-impact-plan.mjs'
import {
  VERIFICATION_EXPLICIT_MODULE_EDGES,
  verificationGlobalInputPaths,
} from './verification-obligation-manifest.mjs'

const COMMITTED_COMPARISONS = new WeakSet()
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024

export async function materializeCommittedVerificationComparison(options = {}) {
  const root = resolve(options.root ?? resolve(import.meta.dirname, '..'))
  const manifest = options.manifest ?? currentWaveManifest
  if (manifest !== currentWaveManifest) {
    throw new Error('VerificationCanonicalComparisonManifestRequired')
  }
  const expected = expectedComparisonCommit(manifest)
  const runGit = options.runGit ?? runGitProcess
  const capture = await captureGitTree(root, expected.oid, runGit)
  return buildCommittedVerificationComparison({ manifest, capture })
}

export function buildCommittedVerificationComparison(options) {
  const manifest = options.manifest ?? currentWaveManifest
  const expected = expectedComparisonCommit(manifest)
  const capture = validateGitTreeCapture(options.capture, expected.oid)
  const entries = parseTreeEntries(capture.treeListing)
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]))
  const { allPaths, selectedEntries } = selectTreeEntries(entries)
  const requestedObjectIds = uniqueSorted(selectedEntries.map((entry) => entry.oid))
  if (JSON.stringify(requestedObjectIds) !== JSON.stringify(capture.requestedObjectIds)) {
    throw new Error('VerificationComparisonCaptureSelectionMismatch')
  }
  const blobs = parseBlobBatch(capture.blobBatch, requestedObjectIds)
  const bytesByPath = new Map()
  let totalBytes = 0
  for (const entry of selectedEntries) {
    const bytes = blobs.get(entry.oid)
    if (!bytes || bytes.byteLength !== entry.size) {
      throw new Error(`VerificationComparisonBlobSizeMismatch:${entry.path}`)
    }
    bytesByPath.set(entry.path, bytes)
    totalBytes += bytes.byteLength
  }
  const source = Object.freeze({
    kind: 'git-tree',
    allPaths,
    readFileBytes(path) {
      const bytes = bytesByPath.get(path)
      if (!bytes) throw new Error(`VerificationComparisonBlobMissing:${path}`)
      return bytes
    },
    isExecutable(path) {
      const entry = entryByPath.get(path)
      if (entry?.kind !== 'file') {
        throw new Error(`VerificationComparisonMetadataMissing:${path}`)
      }
      return entry.executable
    },
  })
  const snapshot = buildVerificationSnapshot({
    source,
    globalInputs: verificationGlobalInputPaths({ allPaths }),
    explicitEdges: VERIFICATION_EXPLICIT_MODULE_EDGES,
  })
  const withoutDigest = {
    schemaVersion: 1,
    kind: 'git-object-comparison',
    waveId: manifest.id,
    commitOid: capture.commitOid,
    treeOid: capture.treeOid,
    snapshotSchemaVersion: snapshot.schemaVersion,
    sourceStats: Object.freeze({
      treeEntryCount: entries.length,
      selectedFileCount: selectedEntries.length,
      uniqueBlobCount: requestedObjectIds.length,
      selectedBytes: totalBytes,
      gitProcessCount: capture.gitProcessCount,
    }),
    snapshot,
  }
  return mintComparison(
    deepFreeze({ ...withoutDigest, digest: digestJson(withoutDigest) }),
    manifest,
  )
}

export function restoreCommittedVerificationComparison(value, manifest = currentWaveManifest) {
  validateComparisonEnvelope(value, manifest)
  return mintComparison(deepFreeze(value), manifest)
}

export function assertCommittedVerificationComparison(value) {
  if (!COMMITTED_COMPARISONS.has(value)) {
    throw new Error('VerificationCommittedComparisonRequired')
  }
  return value
}

async function captureGitTree(root, commitOid, runGit) {
  const type = await checkedGit(runGit, root, ['cat-file', '-t', commitOid], null)
  if (type.stdout.toString('utf8') !== 'commit\n') {
    throw new Error('VerificationComparisonObjectNotCommit')
  }
  const commit = await checkedGit(runGit, root, ['cat-file', 'commit', commitOid], null)
  const treeMatch = /^tree ([0-9a-f]{40})\n/u.exec(commit.stdout.toString('ascii'))
  if (!treeMatch) {
    throw new Error('VerificationComparisonTreeOidInvalid')
  }
  const treeOid = treeMatch[1]
  const listing = await checkedGit(runGit, root, ['ls-tree', '-rzl', '--full-tree', treeOid], null)
  const { selectedEntries } = selectTreeEntries(parseTreeEntries(listing.stdout))
  const requestedObjectIds = uniqueSorted(selectedEntries.map((entry) => entry.oid))
  const batch = await checkedGit(
    runGit,
    root,
    ['cat-file', '--batch'],
    Buffer.from(`${requestedObjectIds.join('\n')}\n`),
  )
  return deepFreeze({
    schemaVersion: 1,
    commitOid,
    treeOid,
    treeListing: encodedBytes(listing.stdout),
    blobBatch: encodedBytes(batch.stdout),
    requestedObjectIds,
    gitProcessCount: 4,
  })
}

function selectTreeEntries(entries) {
  const allPaths = new Set(entries.map((entry) => entry.path))
  const discoverySource = Object.freeze({
    kind: 'git-tree',
    allPaths,
    readFileBytes() {
      throw new Error('VerificationComparisonDiscoveryReadForbidden')
    },
    isExecutable() {
      throw new Error('VerificationComparisonDiscoveryMetadataForbidden')
    },
  })
  const selectedPaths = uniqueSorted([
    ...discoverLocalModulePaths({ source: discoverySource }),
    ...verificationGlobalInputPaths({ allPaths }).filter((path) => allPaths.has(path)),
  ])
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]))
  const selectedEntries = selectedPaths.map((path) => {
    const entry = entryByPath.get(path)
    if (entry?.kind !== 'file') {
      throw new Error(`VerificationComparisonSelectedKindForbidden:${path}`)
    }
    return entry
  })
  return Object.freeze({ allPaths, selectedEntries: Object.freeze(selectedEntries) })
}

function validateGitTreeCapture(value, expectedCommitOid) {
  if (
    value?.schemaVersion !== 1 ||
    value?.commitOid !== expectedCommitOid ||
    !/^[0-9a-f]{40}$/u.test(value?.treeOid ?? '') ||
    value?.gitProcessCount !== 4 ||
    !Array.isArray(value?.requestedObjectIds)
  ) {
    throw new Error('VerificationComparisonCaptureInvalid')
  }
  const requestedObjectIds = value.requestedObjectIds.map(assertObjectId)
  if (JSON.stringify(requestedObjectIds) !== JSON.stringify(uniqueSorted(requestedObjectIds))) {
    throw new Error('VerificationComparisonCaptureObjectIdsInvalid')
  }
  return Object.freeze({
    ...value,
    requestedObjectIds: Object.freeze(requestedObjectIds),
    treeListing: decodeBytes(value.treeListing, 'tree'),
    blobBatch: decodeBytes(value.blobBatch, 'blobs'),
  })
}

function parseTreeEntries(bytes) {
  const entries = []
  let offset = 0
  while (offset < bytes.byteLength) {
    const end = bytes.indexOf(0, offset)
    if (end < 0) throw new Error('VerificationComparisonTreeListingTruncated')
    const record = bytes.subarray(offset, end)
    const tab = record.indexOf(9)
    if (tab < 0) throw new Error('VerificationComparisonTreeRecordInvalid')
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40}) +(\d+|-)$/u.exec(
      record.subarray(0, tab).toString('ascii'),
    )
    if (!match) throw new Error('VerificationComparisonTreeHeaderInvalid')
    const pathBytes = record.subarray(tab + 1)
    const path = pathBytes.toString('utf8')
    if (!Buffer.from(path, 'utf8').equals(pathBytes)) {
      throw new Error('VerificationComparisonTreePathEncodingInvalid')
    }
    assertRepositoryPath(path)
    const mode = match[1]
    const type = match[2]
    const oid = match[3]
    const sizeText = match[4]
    const kind =
      mode === '100644' || mode === '100755' ? 'file' : mode === '120000' ? 'symlink' : 'submodule'
    if ((kind === 'file' || kind === 'symlink') && type !== 'blob') {
      throw new Error(`VerificationComparisonTreeTypeInvalid:${path}`)
    }
    if (kind === 'submodule' && type !== 'commit') {
      throw new Error(`VerificationComparisonTreeTypeInvalid:${path}`)
    }
    if (kind === 'file' && !/^\d+$/u.test(sizeText)) {
      throw new Error(`VerificationComparisonTreeSizeInvalid:${path}`)
    }
    entries.push(
      Object.freeze({
        path,
        kind,
        executable: mode === '100755',
        oid,
        size: kind === 'file' ? safeSize(sizeText, path) : null,
      }),
    )
    offset = end + 1
  }
  const paths = entries.map((entry) => entry.path)
  if (new Set(paths).size !== paths.length)
    throw new Error('VerificationComparisonTreePathDuplicate')
  return Object.freeze(entries.sort((left, right) => compareText(left.path, right.path)))
}

function parseBlobBatch(bytes, requestedObjectIds) {
  const blobs = new Map()
  let offset = 0
  for (const expectedOid of requestedObjectIds) {
    const headerEnd = bytes.indexOf(10, offset)
    if (headerEnd < 0) throw new Error('VerificationComparisonBlobBatchTruncated')
    const match = /^([0-9a-f]{40}) blob (\d+)$/u.exec(
      bytes.subarray(offset, headerEnd).toString('ascii'),
    )
    if (!match || match[1] !== expectedOid) {
      throw new Error('VerificationComparisonBlobBatchHeaderInvalid')
    }
    const size = Number(match[2])
    const start = headerEnd + 1
    const end = start + size
    if (end >= bytes.byteLength || bytes[end] !== 10) {
      throw new Error('VerificationComparisonBlobBatchSizeInvalid')
    }
    const blob = Buffer.from(bytes.subarray(start, end))
    if (gitBlobObjectId(blob) !== expectedOid) {
      throw new Error('VerificationComparisonBlobObjectIdMismatch')
    }
    blobs.set(expectedOid, blob)
    offset = end + 1
  }
  if (offset !== bytes.byteLength) throw new Error('VerificationComparisonBlobBatchTrailingBytes')
  return blobs
}

function validateComparisonEnvelope(value, manifest) {
  const expected = expectedComparisonCommit(manifest)
  if (
    value?.schemaVersion !== 1 ||
    value?.kind !== 'git-object-comparison' ||
    value?.waveId !== manifest.id ||
    value?.commitOid !== expected.oid ||
    !/^[0-9a-f]{40}$/u.test(value?.treeOid ?? '') ||
    value?.snapshotSchemaVersion !== value?.snapshot?.schemaVersion
  ) {
    throw new Error('VerificationComparisonEnvelopeInvalid')
  }
  const { digest: _digest, ...withoutDigest } = value
  if (value.digest !== digestJson(withoutDigest)) {
    throw new Error('VerificationComparisonEnvelopeDigestInvalid')
  }
  const { digest: _snapshotDigest, ...snapshotWithoutDigest } = value.snapshot
  if (value.snapshot.digest !== sha256(JSON.stringify(snapshotWithoutDigest))) {
    throw new Error('VerificationComparisonSnapshotDigestInvalid')
  }
}

function mintComparison(value, manifest) {
  validateComparisonEnvelope(value, manifest)
  COMMITTED_COMPARISONS.add(value)
  return value
}

function expectedComparisonCommit(manifest) {
  if (
    typeof manifest?.id !== 'string' ||
    manifest?.comparison?.kind !== 'git-commit' ||
    !/^[0-9a-f]{40}$/u.test(manifest?.comparison?.oid ?? '')
  ) {
    throw new Error('VerificationComparisonManifestInvalid')
  }
  return manifest.comparison
}

async function checkedGit(runGit, root, args, input) {
  const result = await runGit(root, args, input)
  if (
    result?.exitCode !== 0 ||
    result?.signal !== null ||
    result?.error !== null ||
    !Buffer.isBuffer(result?.stdout) ||
    !Buffer.isBuffer(result?.stderr) ||
    result.stderr.byteLength !== 0
  ) {
    throw new Error(`VerificationComparisonGitFailed:${args[0]}`)
  }
  return result
}

function runGitProcess(root, args, input) {
  return new Promise((resolveProcess) => {
    const child = spawn('git', ['--no-replace-objects', '-C', root, ...args], {
      cwd: root,
      env: gitEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let error = null
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) child.kill('SIGKILL')
      else stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > MAX_GIT_OUTPUT_BYTES) child.kill('SIGKILL')
      else stderr.push(Buffer.from(chunk))
    })
    child.once('error', (cause) => {
      error = cause.message
    })
    child.stdin.once('error', (cause) => {
      error ??= cause.message
    })
    child.once('close', (exitCode, signal) => {
      resolveProcess({
        exitCode,
        signal,
        error:
          stdoutBytes > MAX_GIT_OUTPUT_BYTES || stderrBytes > MAX_GIT_OUTPUT_BYTES
            ? 'output-limit'
            : error,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      })
    })
    child.stdin.end(input ?? undefined)
  })
}

function gitEnvironment() {
  return Object.freeze({
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    HOME: '/nonexistent',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: process.env.PATH ?? '',
  })
}

function assertRepositoryPath(value) {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x1f || code === 0x7f
    }) ||
    posix.normalize(value) !== value ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('VerificationComparisonTreePathInvalid')
  }
}

function assertObjectId(value) {
  if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error('VerificationComparisonObjectIdInvalid')
  return value
}

function safeSize(value, path) {
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`VerificationComparisonTreeSizeInvalid:${path}`)
  }
  return size
}

function encodedBytes(bytes) {
  return Object.freeze({
    encoding: 'base64',
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    data: bytes.toString('base64'),
  })
}

function decodeBytes(value, label) {
  if (
    value?.encoding !== 'base64' ||
    !Number.isSafeInteger(value?.byteLength) ||
    value.byteLength < 0 ||
    !/^[0-9a-f]{64}$/u.test(value?.sha256 ?? '') ||
    typeof value?.data !== 'string'
  ) {
    throw new Error(`VerificationComparisonCaptureBytesInvalid:${label}`)
  }
  const bytes = Buffer.from(value.data, 'base64')
  if (bytes.byteLength !== value.byteLength || sha256(bytes) !== value.sha256) {
    throw new Error(`VerificationComparisonCaptureBytesMismatch:${label}`)
  }
  return bytes
}

function digestJson(value) {
  return `sha256:${sha256(JSON.stringify(value))}`
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function gitBlobObjectId(bytes) {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText)
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
