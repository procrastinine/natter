import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseVerificationSlicePlanArgs } from '../../scripts/plan-slice-verification.mjs'
import {
  assertCommittedVerificationComparison,
  buildCommittedVerificationComparison,
  type GitComparisonCapture,
  materializeCommittedVerificationComparison,
  restoreCommittedVerificationComparison,
  type VerificationComparisonManifest,
} from '../../scripts/verification-git-comparison.mjs'
import {
  createVerificationSliceBaseline,
  readVerificationSliceBaseline,
} from '../../scripts/verification-slice-workspace.mjs'

const manifest: VerificationComparisonManifest = {
  id: 'wave-test',
  comparison: { kind: 'git-commit', oid: '1'.repeat(40) },
}
const CURRENT_COMPARISON_OID = '0c688c8f1855380118c20bae7e38f6ab8a640048'
const COMPARISON_MATERIALIZATION_BUDGET_MS = 15_000
const TEST_SETTLEMENT_BUDGET_MS = 1_000

describe('committed verification comparison', () => {
  it('accepts only the fixed comparison mode or a persisted baseline id', () => {
    expect(parseVerificationSlicePlanArgs(['--begin', '--json'])).toEqual({
      begin: true,
      baseline: null,
      explain: false,
      head: false,
      json: true,
    })
    expect(parseVerificationSlicePlanArgs(['--begin', '--head'])).toEqual({
      begin: true,
      baseline: null,
      explain: false,
      head: true,
      json: false,
    })
    expect(parseVerificationSlicePlanArgs(['--baseline', 'slice-fixed'])).toEqual({
      begin: false,
      baseline: 'slice-fixed',
      explain: false,
      head: false,
      json: false,
    })
    expect(() => parseVerificationSlicePlanArgs(['--begin', '--oid', 'deadbeef'])).toThrow(
      'VerificationSliceArgumentForbidden:--oid',
    )
    expect(() => parseVerificationSlicePlanArgs(['--baseline', 'slice-fixed', '--head'])).toThrow(
      'VerificationHeadComparisonRequiresBegin',
    )
  })
  it('derives one deterministic, branded snapshot from exact tree and batch bytes', () => {
    const capture = comparisonCapture({
      'package.json': { bytes: Buffer.from('{"name":"fixture"}\n'), executable: false },
      'src/a.ts': { bytes: Buffer.from('export const a = 1\n'), executable: true },
    })
    const first = buildCommittedVerificationComparison({ manifest, capture })
    const second = buildCommittedVerificationComparison({ manifest, capture })

    expect(first.digest).toBe(second.digest)
    expect(first.commitOid).toBe(manifest.comparison.oid)
    expect(first.sourceStats).toEqual({
      treeEntryCount: 2,
      selectedFileCount: 2,
      uniqueBlobCount: 2,
      selectedBytes: 38,
      gitProcessCount: 4,
    })
    expect(first.snapshot.files['src/a.ts']?.executable).toBe(true)
    expect(first.snapshot.graphDiagnostics).toEqual([])
    expect(assertCommittedVerificationComparison(first)).toBe(first)
    expect(() => assertCommittedVerificationComparison({ ...first })).toThrow(
      'VerificationCommittedComparisonRequired',
    )
    expect(
      restoreCommittedVerificationComparison(JSON.parse(JSON.stringify(first)), manifest),
    ).toEqual(first)
  })

  it('rejects batch bytes that do not match the Git object identity', () => {
    const capture = comparisonCapture({
      'src/a.ts': { bytes: Buffer.from('export const a = 1\n'), executable: false },
    })
    const brokenBatch = Buffer.from(capture.blobBatch.data, 'base64')
    const changedIndex = brokenBatch.byteLength - 2
    brokenBatch[changedIndex] = (brokenBatch[changedIndex] ?? 0) ^ 1
    const tampered = {
      ...capture,
      blobBatch: encodedBytes(brokenBatch),
    }

    expect(() => buildCommittedVerificationComparison({ manifest, capture: tampered })).toThrow(
      'VerificationComparisonBlobObjectIdMismatch',
    )
  })

  it('does not apply current explicit edges to dependencies absent from a historical tree', () => {
    const capture = comparisonCapture({
      'scripts/audit-e2e-browser-storage.mjs': {
        bytes: Buffer.from('export const audit = true\n'),
        executable: false,
      },
    })

    const comparison = buildCommittedVerificationComparison({ manifest, capture })

    expect(comparison.snapshot.graphDiagnostics).toEqual([])
    expect(comparison.snapshot.dependencies['scripts/audit-e2e-browser-storage.mjs']).toEqual([])
  })

  it('reads the fixed comparison commit from Git objects in four bounded processes', {
    timeout: COMPARISON_MATERIALIZATION_BUDGET_MS + TEST_SETTLEMENT_BUDGET_MS,
  }, async () => {
    const startedAt = performance.now()
    const comparison = await materializeCommittedVerificationComparison()

    expect(comparison.commitOid).toBe(CURRENT_COMPARISON_OID)
    expect(comparison.sourceStats.gitProcessCount).toBe(4)
    expect(comparison.sourceStats.selectedFileCount).toBeGreaterThan(500)
    expect(comparison.sourceStats.selectedBytes).toBeGreaterThan(1_000_000)
    expect(
      comparison.snapshot.graphDiagnostics.every(
        (diagnostic) => diagnostic.code === 'opaque-module-reference',
      ),
    ).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(COMPARISON_MATERIALIZATION_BUDGET_MS)
  })

  it('materializes the current committed descendant for an incremental slice', {
    timeout: COMPARISON_MATERIALIZATION_BUDGET_MS + TEST_SETTLEMENT_BUDGET_MS,
  }, async () => {
    const startedAt = performance.now()
    const comparison = await materializeCommittedVerificationComparison({
      comparisonMode: 'head',
    })

    expect(comparison.comparisonKind).toBe('descendant')
    expect(comparison.comparisonBaseOid).toBe(CURRENT_COMPARISON_OID)
    expect(comparison.commitOid).toMatch(/^[0-9a-f]{40}$/u)
    expect(comparison.commitOid).not.toBe(CURRENT_COMPARISON_OID)
    expect(comparison.sourceStats.gitProcessCount).toBe(6)
    expect(restoreCommittedVerificationComparison(JSON.parse(JSON.stringify(comparison)))).toEqual(
      comparison,
    )
    expect(performance.now() - startedAt).toBeLessThan(COMPARISON_MATERIALIZATION_BUDGET_MS)
  })

  it('does not let the executable materializer accept a caller-forged manifest', async () => {
    await expect(materializeCommittedVerificationComparison({ manifest })).rejects.toThrow(
      'VerificationCanonicalComparisonManifestRequired',
    )
  })

  it('persists only a branded comparison with its exact Git provenance', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'natter-verification-baseline-'))
    try {
      const comparison = buildCommittedVerificationComparison({
        manifest,
        capture: comparisonCapture({
          'src/a.ts': { bytes: Buffer.from('export const a = 1\n'), executable: false },
        }),
      })
      const created = createVerificationSliceBaseline({
        root,
        comparison,
        now: () => new Date('2026-07-20T00:00:00.000Z'),
      })
      const loaded = readVerificationSliceBaseline(root, created.id, {
        ...manifest,
        mode: 'coherence/gate',
        sourceObligations: [],
        costObligations: [],
      })

      expect(loaded.schemaVersion).toBe(2)
      expect(loaded.comparison.commitOid).toBe(manifest.comparison.oid)
      expect(loaded.comparison.digest).toBe(comparison.digest)
      expect(() =>
        createVerificationSliceBaseline({
          root,
          comparison: comparison.snapshot as never,
        }),
      ).toThrow('VerificationCommittedComparisonRequired')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function comparisonCapture(
  files: Readonly<Record<string, { bytes: Buffer; executable: boolean }>>,
): GitComparisonCapture {
  const entries = Object.entries(files)
    .map(([path, file]) => ({
      path,
      ...file,
      oid: gitBlobObjectId(file.bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
  const requestedObjectIds = [...new Set(entries.map((entry) => entry.oid))].sort()
  const bytesByOid = new Map(entries.map((entry) => [entry.oid, entry.bytes]))
  const treeListing = Buffer.concat(
    entries.map((entry) =>
      Buffer.concat([
        Buffer.from(
          `${entry.executable ? '100755' : '100644'} blob ${entry.oid}    ${entry.bytes.byteLength}\t${entry.path}`,
        ),
        Buffer.from([0]),
      ]),
    ),
  )
  const blobBatch = Buffer.concat(
    requestedObjectIds.flatMap((oid) => {
      const bytes = bytesByOid.get(oid)
      if (!bytes) throw new Error('FixtureBlobMissing')
      return [Buffer.from(`${oid} blob ${bytes.byteLength}\n`), bytes, Buffer.from('\n')]
    }),
  )
  return {
    schemaVersion: 1,
    commitOid: manifest.comparison.oid,
    treeOid: '2'.repeat(40),
    treeListing: encodedBytes(treeListing),
    blobBatch: encodedBytes(blobBatch),
    requestedObjectIds,
    gitProcessCount: 4,
  }
}

function encodedBytes(bytes: Buffer) {
  return {
    encoding: 'base64' as const,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  }
}

function gitBlobObjectId(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}
