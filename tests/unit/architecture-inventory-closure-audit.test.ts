import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ARCHITECTURE_AUDIT_MECHANISMS,
  ARCHITECTURE_DIMENSION_CLOSURE,
  ARCHITECTURE_INVENTORY_CLOSURE_SCHEMA_VERSION,
  type ArchitectureAuditMechanism,
  type ArchitectureDimensionClosure,
  type ArchitectureVerificationStageClassification,
  VERIFICATION_STAGE_CLASSIFICATIONS,
} from '../../scripts/architecture-inventory-closure-manifest.mjs'
import {
  type ArchitectureInventoryClosureManifest,
  auditArchitectureInventoryClosure,
} from '../../scripts/audit-architecture-inventory-closure.mjs'
import { VERIFICATION_STAGES } from '../../scripts/run-verification.mjs'

const ROOT = resolve(__dirname, '../..')
const requiredIntegrationIds = ['architecture-inventory-closure', 'production-work-memory']
const actualStageIds = new Set(VERIFICATION_STAGES.map((stage) => stage.id))
const missingRequiredIntegrations = requiredIntegrationIds.filter((id) => !actualStageIds.has(id))

describe('architecture inventory closure meta-audit', () => {
  it('classifies every verification stage and preserves all closure and integration gaps', async () => {
    const result = await runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      actualStageCount: VERIFICATION_STAGES.length,
      classifiedStageCount: VERIFICATION_STAGE_CLASSIFICATIONS.length,
      integratedClassifiedStageCount: VERIFICATION_STAGES.length,
      requiredIntegrationCount: 2,
      missingIntegrationCount: missingRequiredIntegrations.length,
      mechanismCount: 25,
      dimensionCount: 17,
      openDimensionCount: 17,
      openGapCount: 17 + missingRequiredIntegrations.length,
      problems: [],
    })
    expect(sum(Object.values(result.report.orientationCounts))).toBe(
      VERIFICATION_STAGE_CLASSIFICATIONS.length,
    )
    expect(result.report.mechanismIds).toEqual(
      expect.arrayContaining([
        'production-runtime-effects',
        'production-async-ownership',
        'production-work-memory',
        'scroll-continuity',
        'tab-cross-tab-locality',
      ]),
    )
    expect(result.report.integrationGaps.map((gap) => gap.id)).toEqual(missingRequiredIntegrations)
    expect(
      ARCHITECTURE_AUDIT_MECHANISMS.filter((mechanism) =>
        [
          'production-discriminated-unions',
          'production-protocol',
          'configuration-protocol',
          'durable-command-pipeline',
          'protocol-stage-coverage',
          'tab-cross-tab-locality',
        ].includes(mechanism.id),
      ).map((mechanism) => mechanism.stageId),
    ).toEqual(Array.from({ length: 6 }, () => 'protocol-contracts'))
    expect(result.report.dimensions).toHaveLength(17)
    for (const dimension of result.report.dimensions) {
      expect(dimension.additiveMechanisms.length).toBeGreaterThan(0)
      expect(dimension.subtractiveMechanisms.length).toBeGreaterThan(0)
      expect(dimension.scannerLimitation.length).toBeGreaterThan(0)
      expect(dimension.closureCriterion.length).toBeGreaterThan(0)
      expect(dimension.status).toBe('open')
    }
  })

  it('makes reviewed open gaps fatal only in enforce mode', async () => {
    const result = await runAudit('enforce')

    expect(result.status).toBe(1)
    expect(result.report.ok).toBe(false)
    expect(result.report.structurallyValid).toBe(true)
    expect(result.report.openGapCount).toBe(17 + missingRequiredIntegrations.length)
    expect(result.report.problems).toEqual([])
  })

  it('rejects a current verification stage omitted from the orientation inventory', async () => {
    const manifest = createManifest({
      stageClassifications: VERIFICATION_STAGE_CLASSIFICATIONS.filter(
        (stage) => stage.id !== 'environment',
      ),
    })
    const result = await runAudit('inventory', manifest)

    expect(result.status).toBe(1)
    expect(result.report.problems).toContain('stage classifications: missing stage: environment')
  })

  it('pins exact verification commands so a stage cannot drift under an old classification', async () => {
    const manifest = createManifest({
      stageClassifications: VERIFICATION_STAGE_CLASSIFICATIONS.map((stage) =>
        stage.id === 'production-runtime-effects'
          ? { ...stage, argv: ['node', 'scripts/retired-runtime-effect-audit.mjs'] }
          : stage,
      ),
    })
    const result = await runAudit('inventory', manifest)

    expect(result.status).toBe(1)
    expect(result.report.problems).toContain(
      'stage classifications:production-runtime-effects: argv drift: expected ["node","scripts/retired-runtime-effect-audit.mjs"], actual ["node","scripts/audit-production-runtime-effects.mjs","--mode","inventory"]',
    )
  })

  it('rejects subtractive-only scanners used as additive closure mechanisms', async () => {
    const manifest = createManifest({
      dimensionClosure: ARCHITECTURE_DIMENSION_CLOSURE.map((dimension) =>
        dimension.id === 'exact-modules-responsibilities'
          ? { ...dimension, additiveMechanisms: ['general-dead-code'] }
          : dimension,
      ),
    })
    const result = await runAudit('inventory', manifest)

    expect(result.status).toBe(1)
    expect(result.report.problems).toContain(
      'dimension closure:exact-modules-responsibilities: mechanism general-dead-code orientation subtractive cannot satisfy additive coverage',
    )
  })

  it('requires grouped mechanism capabilities to match the typed stage declaration exactly', async () => {
    const missingCapability = createManifest({
      auditMechanisms: ARCHITECTURE_AUDIT_MECHANISMS.filter(
        (mechanism) => mechanism.id !== 'production-protocol',
      ),
    })
    const missingResult = await runAudit('inventory', missingCapability)
    expect(missingResult.status).toBe(1)
    expect(missingResult.report.problems).toContain(
      'audit mechanisms:protocol-contracts: declared capabilities: missing production-protocol',
    )

    const protocolMechanism = ARCHITECTURE_AUDIT_MECHANISMS.find(
      (mechanism) => mechanism.id === 'production-protocol',
    )
    if (!protocolMechanism) throw new Error('ProtocolMechanismFixtureMissing')
    const inventedCapability = createManifest({
      auditMechanisms: [
        ...ARCHITECTURE_AUDIT_MECHANISMS,
        { ...protocolMechanism, id: 'invented-protocol-capability' },
      ],
    })
    const inventedResult = await runAudit('inventory', inventedCapability)
    expect(inventedResult.status).toBe(1)
    expect(inventedResult.report.problems).toContain(
      'audit mechanisms:protocol-contracts: declared capabilities: unclassified invented-protocol-capability',
    )

    const groupedStage = VERIFICATION_STAGE_CLASSIFICATIONS.find(
      (stage) => stage.id === 'protocol-contracts',
    )
    const duplicateCapability = groupedStage?.mechanismIds[0]
    if (!duplicateCapability) throw new Error('ProtocolContractCapabilityFixtureMissing')
    const duplicateDeclaration = createManifest({
      stageClassifications: VERIFICATION_STAGE_CLASSIFICATIONS.map((stage) =>
        stage.id === 'protocol-contracts'
          ? { ...stage, mechanismIds: [...stage.mechanismIds, duplicateCapability] }
          : stage,
      ),
    })
    const duplicateResult = await runAudit('inventory', duplicateDeclaration)
    expect(duplicateResult.status).toBe(1)
    expect(duplicateResult.report.problems).toContain(
      `stage classifications:protocol-contracts: mechanismIds duplicate: ${duplicateCapability}`,
    )
  })

  it('requires additive and subtractive mappings plus an explicit scanner limitation', async () => {
    const manifest = createManifest({
      dimensionClosure: ARCHITECTURE_DIMENSION_CLOSURE.map((dimension) =>
        dimension.id === 'cpu-complexity'
          ? { ...dimension, subtractiveMechanisms: [], scannerLimitation: '' }
          : dimension,
      ),
    })
    const result = await runAudit('inventory', manifest)

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'dimension closure:cpu-complexity: subtractiveMechanisms must be a non-empty string array',
        'dimension closure:cpu-complexity: scannerLimitation must be non-empty',
      ]),
    )
  })

  it('cannot omit self-classification or invent arbitrary pending stages', async () => {
    const missingSelf = createManifest({
      stageClassifications: VERIFICATION_STAGE_CLASSIFICATIONS.filter(
        (stage) => stage.id !== 'architecture-inventory-closure',
      ),
    })
    const missingResult = await runAudit('inventory', missingSelf)
    expect(missingResult.status).toBe(1)
    expect(missingResult.report.problems).toContain(
      'stage classifications: missing required integration declaration: architecture-inventory-closure',
    )

    const inventedPending = createManifest({
      stageClassifications: [
        ...VERIFICATION_STAGE_CLASSIFICATIONS,
        {
          id: 'retired-architecture-audit',
          label: 'Retired audit',
          policy: 'blocking',
          argv: ['node', 'scripts/retired-audit.mjs'],
          orientation: 'meta',
          rationale: 'Deliberately invalid pending stage.',
          requiredIntegration: true,
          mechanismIds: [],
        },
      ],
    })
    const inventedResult = await runAudit('inventory', inventedPending)
    expect(inventedResult.status).toBe(1)
    expect(inventedResult.report.problems).toContain(
      'stage classifications: stale stage: retired-architecture-audit',
    )
  })

  it('does not let a dimension claim closure without exact integrated-stage evidence', async () => {
    const noEvidence = createManifest({
      dimensionClosure: ARCHITECTURE_DIMENSION_CLOSURE.map((dimension) =>
        dimension.id === 'exact-modules-responsibilities'
          ? { ...dimension, status: 'closed', gap: null }
          : dimension,
      ),
    })
    const noEvidenceResult = await runAudit('inventory', noEvidence)
    expect(noEvidenceResult.status).toBe(1)
    expect(noEvidenceResult.report.problems).toContain(
      'dimension closure:exact-modules-responsibilities: closed dimensions need exact closure evidence',
    )

    const staleLocator = ['RetiredArchitecture', 'ClosureProof'].join('')
    const staleEvidence = createManifest({
      dimensionClosure: ARCHITECTURE_DIMENSION_CLOSURE.map((dimension) =>
        dimension.id === 'exact-modules-responsibilities'
          ? {
              ...dimension,
              status: 'closed',
              gap: null,
              closureEvidence: [
                {
                  id: 'stale-proof',
                  stageId: 'vitest',
                  path: 'tests/unit/architecture-inventory-closure-audit.test.ts',
                  locator: staleLocator,
                  claim: 'Deliberately stale locator.',
                },
              ],
            }
          : dimension,
      ),
    })
    const staleResult = await runAudit('inventory', staleEvidence)
    expect(staleResult.status).toBe(1)
    expect(staleResult.report.problems).toContain(
      `dimension closure:exact-modules-responsibilities:closureEvidence[0]: locator is stale in tests/unit/architecture-inventory-closure-audit.test.ts: ${staleLocator}`,
    )
  })
})

async function runAudit(
  mode: 'inventory' | 'enforce',
  manifest: ArchitectureInventoryClosureManifest = createManifest(),
) {
  const report = await auditArchitectureInventoryClosure({
    root: ROOT,
    mode,
    manifest,
  })
  return {
    status: report.ok ? 0 : 1,
    report,
  }
}

function createManifest(
  overrides: Partial<{
    stageClassifications: readonly ArchitectureVerificationStageClassification[]
    auditMechanisms: readonly ArchitectureAuditMechanism[]
    dimensionClosure: readonly ArchitectureDimensionClosure[]
  }> = {},
): ArchitectureInventoryClosureManifest {
  return {
    ARCHITECTURE_INVENTORY_CLOSURE_SCHEMA_VERSION,
    VERIFICATION_STAGE_CLASSIFICATIONS:
      overrides.stageClassifications ?? VERIFICATION_STAGE_CLASSIFICATIONS,
    ARCHITECTURE_AUDIT_MECHANISMS: overrides.auditMechanisms ?? ARCHITECTURE_AUDIT_MECHANISMS,
    ARCHITECTURE_DIMENSION_CLOSURE: overrides.dimensionClosure ?? ARCHITECTURE_DIMENSION_CLOSURE,
  }
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}
