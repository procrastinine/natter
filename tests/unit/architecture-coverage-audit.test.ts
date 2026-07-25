import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type ArchitectureCoverageManifest,
  auditArchitectureCoverage,
} from '../../scripts/audit-architecture-coverage.mjs'

const ROOT = resolve(__dirname, '../..')

describe('architecture coverage meta-audit', () => {
  it('accepts the complete domain-by-dimension inventory while preserving visible gaps', async () => {
    const result = await runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      domainCount: 19,
      dimensionCount: 17,
      cellCount: 323,
      proofCount: 16,
      statusCounts: {
        covered: 32,
        gap: 262,
        'not-applicable': 29,
      },
      problems: [],
    })
    expect(result.report.sourceModuleCount).toBe(result.report.classifiedModuleCount)
    expect(result.report.sourceModuleCount).toBeGreaterThan(0)
    expect(result.report.gaps.length).toBeGreaterThan(0)
    expect(
      result.report.statusCounts.covered +
        result.report.statusCounts.gap +
        result.report.statusCounts['not-applicable'],
    ).toBe(323)
  })

  it('makes documented gaps fatal only in enforce mode', async () => {
    const result = await runAudit('enforce')

    expect(result.status).toBe(1)
    expect(result.report.ok).toBe(false)
    expect(result.report.structurallyValid).toBe(true)
    expect(result.report.gaps.length).toBeGreaterThan(0)
    expect(result.report.problems).toEqual([])
  })

  it('rejects a missing domain-dimension cell', async () => {
    const result = await runAudit('inventory', (base) => ({
      ...base,
      ARCHITECTURE_COVERAGE: base.ARCHITECTURE_COVERAGE.map((row, index) =>
        index === 0
          ? { ...row, cells: Object.fromEntries(Object.entries(row.cells).slice(1)) }
          : row,
      ),
    }))

    expect(result.status).toBe(1)
    expect(result.report.problems).toContain(
      'coverage:application-shell: missing dimension: exact-modules-responsibilities',
    )
  })

  it('rejects stale proof files and locators', async () => {
    const result = await runAudit('inventory', (base) => ({
      ...base,
      ARCHITECTURE_PROOFS: base.ARCHITECTURE_PROOFS.map((proof, index) =>
        index === 0
          ? {
              ...proof,
              path: 'scripts/retired-architecture-proof.mjs',
              locator: 'RetiredProof',
            }
          : proof,
      ),
    }))

    expect(result.status).toBe(1)
    expect(result.report.problems).toContain(
      'proofs:canonical-production-module-inventory: path does not exist: scripts/retired-architecture-proof.mjs',
    )
  })

  it('rejects stale domain and dimension scopes on proofs', async () => {
    const result = await runAudit('inventory', (base) => ({
      ...base,
      ARCHITECTURE_PROOFS: base.ARCHITECTURE_PROOFS.map((proof, index) =>
        index === 0
          ? {
              ...proof,
              domains: [...proof.domains, 'retired-domain'],
              dimensions: [...proof.dimensions, 'retired-dimension'],
            }
          : proof,
      ),
    }))

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'proofs:canonical-production-module-inventory: domain is stale: retired-domain',
        'proofs:canonical-production-module-inventory: dimension is stale: retired-dimension',
      ]),
    )
  })

  it('does not let a static inventory masquerade as browser or performance evidence', async () => {
    const result = await runAudit('inventory', (base) => ({
      ...base,
      ARCHITECTURE_PROOFS: base.ARCHITECTURE_PROOFS.map((proof) =>
        proof.id === 'canonical-production-module-inventory'
          ? { ...proof, dimensions: [...proof.dimensions, 'browser-performance-tests'] }
          : proof,
      ),
      ARCHITECTURE_COVERAGE: base.ARCHITECTURE_COVERAGE.map((row) =>
        row.domain === 'application-shell'
          ? {
              ...row,
              cells: {
                ...row.cells,
                'browser-performance-tests': {
                  status: 'covered',
                  rationale: 'Deliberately invalid static-only browser claim.',
                  proofs: ['canonical-production-module-inventory'],
                },
              },
            }
          : row,
      ),
    }))

    expect(result.status).toBe(1)
    expect(result.report.problems).toContain(
      'coverage:application-shell:browser-performance-tests: proof canonical-production-module-inventory kind canonical-inventory cannot satisfy this dimension; allowed=browser-test,performance-test',
    )
  })
})

async function runAudit(
  mode: 'inventory' | 'enforce',
  transformManifest?: (manifest: ArchitectureCoverageManifest) => ArchitectureCoverageManifest,
) {
  const report = await auditArchitectureCoverage({
    root: ROOT,
    mode,
    ...(transformManifest ? { transformManifest } : {}),
  })
  return {
    status: report.ok ? 0 : 1,
    report,
  }
}
