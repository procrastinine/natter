import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, posix, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ARCHITECTURE_DIMENSIONS } from './architecture-coverage-manifest.mjs'
import { staticAuditState } from './audit-result-state.mjs'
import { VERIFICATION_STAGES } from './run-verification.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_MANIFEST = resolve(ROOT, 'scripts/architecture-inventory-closure-manifest.mjs')
const ORIENTATIONS = new Set([
  'environment',
  'hygiene',
  'additive',
  'subtractive',
  'both',
  'behavior',
  'performance',
  'meta',
])
const MECHANISM_ORIENTATIONS = new Set(['additive', 'subtractive', 'both'])
const SUPPORTING_ORIENTATIONS = new Set([
  'environment',
  'hygiene',
  'behavior',
  'performance',
  'meta',
])
const REQUIRED_INTEGRATION_SIGNATURES = Object.freeze({
  'production-work-memory': Object.freeze({
    label: 'Audit production work and memory ownership',
    policy: 'blocking',
    argv: Object.freeze([
      'node',
      'scripts/audit-production-work-memory.mjs',
      '--mode',
      'inventory',
    ]),
    orientation: 'both',
  }),
  'architecture-inventory-closure': Object.freeze({
    label: 'Audit architecture inventory closure',
    policy: 'blocking',
    argv: Object.freeze([
      'node',
      'scripts/audit-architecture-inventory-closure.mjs',
      '--mode',
      'inventory',
    ]),
    orientation: 'meta',
  }),
})

export async function auditArchitectureInventoryClosure(options = {}) {
  const root = options.root ?? ROOT
  const mode = options.mode ?? 'inventory'
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`Invalid architecture-inventory-closure mode: ${mode}`)
  }
  const importProblems = []
  let manifest = options.manifest ?? null
  if (!manifest) {
    const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST
    try {
      manifest = await import(`${pathToFileURL(manifestPath).href}?audit=${Date.now()}`)
    } catch (error) {
      importProblems.push(`manifest: ${errorText(error)}`)
    }
  }
  const report = validateArchitectureInventoryClosure({
    root,
    stages: options.stages ?? VERIFICATION_STAGES,
    dimensions: options.dimensions ?? ARCHITECTURE_DIMENSIONS,
    manifest,
    initialProblems: importProblems,
  })
  const enforcedGaps = mode === 'enforce' ? report.gaps : []
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok: report.problems.length === 0 && enforcedGaps.length === 0,
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    actualStageCount: report.actualStageCount,
    classifiedStageCount: report.classifiedStageCount,
    integratedClassifiedStageCount: report.integratedClassifiedStageCount,
    requiredIntegrationCount: report.requiredIntegrationCount,
    missingIntegrationCount: report.integrationGaps.length,
    orientationCounts: report.orientationCounts,
    mechanismCount: report.mechanisms.length,
    dimensionCount: report.dimensions.length,
    openDimensionCount: report.dimensionGaps.length,
    openGapCount: report.gaps.length,
    mechanismIds: report.mechanisms.map((mechanism) => mechanism.id),
    dimensions: report.dimensions,
    integrationGaps: report.integrationGaps,
    gaps: report.gaps,
    problems: report.problems,
  })
}

export function validateArchitectureInventoryClosure({
  root,
  stages,
  dimensions,
  manifest: closureManifest,
  initialProblems = [],
}) {
  const problems = [...initialProblems]
  if (closureManifest?.ARCHITECTURE_INVENTORY_CLOSURE_SCHEMA_VERSION !== 1) {
    problems.push(
      `schema: expected 1, found ${format(closureManifest?.ARCHITECTURE_INVENTORY_CLOSURE_SCHEMA_VERSION)}`,
    )
  }

  const actualStageById = uniqueById(stages, 'verification stage', problems)
  const classifications = closureManifest?.VERIFICATION_STAGE_CLASSIFICATIONS
  const classificationById = uniqueById(classifications, 'stage classification', problems)
  const integrationGaps = validateStageClassifications({
    actualStageById,
    classificationById,
    problems,
  })

  const mechanisms = closureManifest?.ARCHITECTURE_AUDIT_MECHANISMS
  const mechanismById = uniqueById(mechanisms, 'audit mechanism', problems)
  validateMechanisms({ classificationById, mechanismById, problems })

  const canonicalDimensionById = uniqueById(dimensions, 'canonical dimension', problems)
  const closureDimensions = closureManifest?.ARCHITECTURE_DIMENSION_CLOSURE
  const closureDimensionById = uniqueById(closureDimensions, 'dimension closure', problems)
  const { normalizedDimensions, dimensionGaps, referencedMechanisms } = validateDimensions({
    root,
    canonicalDimensionById,
    closureDimensionById,
    classificationById,
    actualStageById,
    mechanismById,
    problems,
  })

  for (const mechanismId of mechanismById.keys()) {
    if (!referencedMechanisms.has(mechanismId)) {
      problems.push(`audit mechanisms: unreferenced mechanism: ${mechanismId}`)
    }
  }

  const normalizedMechanisms = [...mechanismById.values()]
    .map((mechanism) => ({
      id: mechanism.id,
      stageId: mechanism.stageId,
      orientation: mechanism.orientation,
      integrated: actualStageById.has(mechanism.stageId),
      contribution: mechanism.contribution,
      scannerLimitation: mechanism.scannerLimitation,
    }))
    .sort(compareIds)
  integrationGaps.sort(compareIds)
  dimensionGaps.sort(compareIds)
  problems.sort()
  return Object.freeze({
    actualStageCount: actualStageById.size,
    classifiedStageCount: classificationById.size,
    integratedClassifiedStageCount: [...classificationById.keys()].filter((id) =>
      actualStageById.has(id),
    ).length,
    requiredIntegrationCount: Object.keys(REQUIRED_INTEGRATION_SIGNATURES).length,
    orientationCounts: countBy(
      [...classificationById.values()].map((classification) => classification.orientation),
      ORIENTATIONS,
    ),
    mechanisms: Object.freeze(normalizedMechanisms),
    dimensions: Object.freeze(normalizedDimensions),
    integrationGaps: Object.freeze(integrationGaps),
    dimensionGaps: Object.freeze(dimensionGaps),
    gaps: Object.freeze([...integrationGaps, ...dimensionGaps].sort(compareGaps)),
    problems: Object.freeze(problems),
  })
}

function validateStageClassifications({ actualStageById, classificationById, problems }) {
  const integrationGaps = []
  for (const id of actualStageById.keys()) {
    if (!classificationById.has(id)) {
      problems.push(`stage classifications: missing stage: ${id}`)
    }
  }
  for (const [id, classification] of classificationById) {
    const prefix = `stage classifications:${id}`
    if (!isNonEmptyString(classification.label)) problems.push(`${prefix}: label must be non-empty`)
    if (!['blocking', 'advisory'].includes(classification.policy)) {
      problems.push(`${prefix}: invalid policy: ${format(classification.policy)}`)
    }
    if (!isStringArray(classification.argv) || classification.argv.length === 0) {
      problems.push(`${prefix}: argv must be a non-empty string array`)
    }
    if (!ORIENTATIONS.has(classification.orientation)) {
      problems.push(`${prefix}: invalid orientation: ${format(classification.orientation)}`)
    }
    if (!isNonEmptyString(classification.rationale)) {
      problems.push(`${prefix}: rationale must be non-empty`)
    }
    if (typeof classification.requiredIntegration !== 'boolean') {
      problems.push(`${prefix}: requiredIntegration must be boolean`)
    }
    if (!isStringArray(classification.mechanismIds)) {
      problems.push(`${prefix}: mechanismIds must be a string array`)
    } else {
      for (const duplicate of duplicates(classification.mechanismIds)) {
        problems.push(`${prefix}: mechanismIds duplicate: ${duplicate}`)
      }
    }

    const actual = actualStageById.get(id)
    if (actual) {
      if (classification.label !== actual.label) {
        problems.push(
          `${prefix}: label drift: expected ${format(classification.label)}, actual ${format(actual.label)}`,
        )
      }
      if (classification.policy !== actual.policy) {
        problems.push(
          `${prefix}: policy drift: expected ${format(classification.policy)}, actual ${format(actual.policy)}`,
        )
      }
      if (!sameStringArray(classification.argv, actual.argv)) {
        problems.push(
          `${prefix}: argv drift: expected ${format(classification.argv)}, actual ${format(actual.argv)}`,
        )
      }
      if (
        classification.requiredIntegration === true &&
        !Object.hasOwn(REQUIRED_INTEGRATION_SIGNATURES, id)
      ) {
        problems.push(`${prefix}: only reviewed required integrations may set requiredIntegration`)
      }
      continue
    }

    const required = REQUIRED_INTEGRATION_SIGNATURES[id]
    if (!required || classification.requiredIntegration !== true) {
      problems.push(`stage classifications: stale stage: ${id}`)
      continue
    }
    validateRequiredIntegrationSignature(id, classification, required, problems)
    integrationGaps.push(
      Object.freeze({
        kind: 'verification-stage-integration',
        id,
        detail: `${id} is reviewed and self-classified but is not present in VERIFICATION_STAGES.`,
      }),
    )
  }

  for (const [id, signature] of Object.entries(REQUIRED_INTEGRATION_SIGNATURES)) {
    const classification = classificationById.get(id)
    if (!classification) {
      problems.push(`stage classifications: missing required integration declaration: ${id}`)
      continue
    }
    validateRequiredIntegrationSignature(id, classification, signature, problems)
  }
  return integrationGaps
}

function validateRequiredIntegrationSignature(id, classification, signature, problems) {
  const prefix = `stage classifications:${id}`
  for (const field of ['label', 'policy', 'orientation']) {
    if (classification[field] !== signature[field]) {
      problems.push(`${prefix}: required integration ${field} must be ${format(signature[field])}`)
    }
  }
  if (!sameStringArray(classification.argv, signature.argv)) {
    problems.push(`${prefix}: required integration argv must be ${format(signature.argv)}`)
  }
  if (classification.requiredIntegration !== true) {
    problems.push(`${prefix}: requiredIntegration must remain true`)
  }
}

function validateMechanisms({ classificationById, mechanismById, problems }) {
  const mechanismsByStageId = Map.groupBy(mechanismById.values(), (mechanism) => mechanism.stageId)
  for (const [id, classification] of classificationById) {
    const mechanisms = mechanismsByStageId.get(id) ?? []
    compareExact(
      `audit mechanisms:${id}: declared capabilities`,
      classification.mechanismIds ?? [],
      mechanisms.map((mechanism) => mechanism.id),
      problems,
    )
    if (MECHANISM_ORIENTATIONS.has(classification.orientation)) {
      if (mechanisms.length === 0) problems.push(`audit mechanisms: missing stage mechanism: ${id}`)
    } else if (mechanisms.length > 0) {
      problems.push(
        `audit mechanisms:${id}: stage orientation ${classification.orientation} cannot be an additive/subtractive mechanism`,
      )
    }
  }

  for (const [id, mechanism] of mechanismById) {
    const prefix = `audit mechanisms:${id}`
    if (!isNonEmptyString(mechanism.stageId)) {
      problems.push(`${prefix}: stageId must be non-empty`)
      continue
    }
    const classification = classificationById.get(mechanism.stageId)
    if (!classification) {
      problems.push(`${prefix}: unknown stage: ${mechanism.stageId}`)
    } else if (classification.orientation !== mechanism.orientation) {
      problems.push(
        `${prefix}: orientation ${format(mechanism.orientation)} conflicts with stage orientation ${format(classification.orientation)}`,
      )
    }
    if (!MECHANISM_ORIENTATIONS.has(mechanism.orientation)) {
      problems.push(`${prefix}: invalid mechanism orientation: ${format(mechanism.orientation)}`)
    }
    if (!isNonEmptyString(mechanism.contribution)) {
      problems.push(`${prefix}: contribution must be non-empty`)
    }
    if (!isNonEmptyString(mechanism.scannerLimitation)) {
      problems.push(`${prefix}: scannerLimitation must be non-empty`)
    }
  }
}

function validateDimensions({
  root,
  canonicalDimensionById,
  closureDimensionById,
  classificationById,
  actualStageById,
  mechanismById,
  problems,
}) {
  for (const id of canonicalDimensionById.keys()) {
    if (!closureDimensionById.has(id)) {
      problems.push(`dimension closure: missing canonical dimension: ${id}`)
    }
  }
  for (const id of closureDimensionById.keys()) {
    if (!canonicalDimensionById.has(id)) {
      problems.push(`dimension closure: stale dimension: ${id}`)
    }
  }

  const normalizedDimensions = []
  const dimensionGaps = []
  const referencedMechanisms = new Set()
  for (const [id, dimension] of closureDimensionById) {
    const prefix = `dimension closure:${id}`
    validateReferenceArray(
      dimension.additiveMechanisms,
      `${prefix}: additiveMechanisms`,
      problems,
      (mechanismId) => {
        const mechanism = mechanismById.get(mechanismId)
        if (!mechanism) {
          problems.push(`${prefix}: additive mechanism is unknown: ${mechanismId}`)
          return
        }
        referencedMechanisms.add(mechanismId)
        if (!['additive', 'both'].includes(mechanism.orientation)) {
          problems.push(
            `${prefix}: mechanism ${mechanismId} orientation ${mechanism.orientation} cannot satisfy additive coverage`,
          )
        }
      },
    )
    validateReferenceArray(
      dimension.subtractiveMechanisms,
      `${prefix}: subtractiveMechanisms`,
      problems,
      (mechanismId) => {
        const mechanism = mechanismById.get(mechanismId)
        if (!mechanism) {
          problems.push(`${prefix}: subtractive mechanism is unknown: ${mechanismId}`)
          return
        }
        referencedMechanisms.add(mechanismId)
        if (!['subtractive', 'both'].includes(mechanism.orientation)) {
          problems.push(
            `${prefix}: mechanism ${mechanismId} orientation ${mechanism.orientation} cannot satisfy subtractive coverage`,
          )
        }
      },
    )
    validateReferenceArray(
      dimension.supportingStages,
      `${prefix}: supportingStages`,
      problems,
      (stageId) => {
        const classification = classificationById.get(stageId)
        if (!classification) {
          problems.push(`${prefix}: supporting stage is unknown: ${stageId}`)
        } else if (!SUPPORTING_ORIENTATIONS.has(classification.orientation)) {
          problems.push(
            `${prefix}: supporting stage ${stageId} orientation ${classification.orientation} must be represented as an additive/subtractive mechanism instead`,
          )
        }
      },
      false,
    )
    if (!isNonEmptyString(dimension.scannerLimitation)) {
      problems.push(`${prefix}: scannerLimitation must be non-empty`)
    }
    if (!isNonEmptyString(dimension.closureCriterion)) {
      problems.push(`${prefix}: closureCriterion must be non-empty`)
    }
    if (!['open', 'closed'].includes(dimension.status)) {
      problems.push(`${prefix}: invalid status: ${format(dimension.status)}`)
    }
    if (!Array.isArray(dimension.closureEvidence)) {
      problems.push(`${prefix}: closureEvidence must be an array`)
    } else if (dimension.status === 'open') {
      if (dimension.closureEvidence.length > 0) {
        problems.push(`${prefix}: open dimensions cannot launder closure evidence`)
      }
    } else if (dimension.closureEvidence.length === 0) {
      problems.push(`${prefix}: closed dimensions need exact closure evidence`)
    } else {
      validateClosureEvidence({
        root,
        dimensionId: id,
        evidenceRows: dimension.closureEvidence,
        classificationById,
        actualStageById,
        problems,
      })
    }
    if (dimension.status === 'open') {
      if (!isNonEmptyString(dimension.gap)) problems.push(`${prefix}: open gap must be non-empty`)
      dimensionGaps.push(
        Object.freeze({
          kind: 'dimension-closure',
          id,
          detail: dimension.gap,
        }),
      )
    } else if (dimension.gap !== null) {
      problems.push(`${prefix}: closed dimensions must set gap to null`)
    }

    normalizedDimensions.push(
      Object.freeze({
        id,
        additiveMechanisms: Object.freeze([...(dimension.additiveMechanisms ?? [])]),
        subtractiveMechanisms: Object.freeze([...(dimension.subtractiveMechanisms ?? [])]),
        supportingStages: Object.freeze([...(dimension.supportingStages ?? [])]),
        scannerLimitation: dimension.scannerLimitation,
        closureCriterion: dimension.closureCriterion,
        status: dimension.status,
        gap: dimension.gap,
      }),
    )
  }
  normalizedDimensions.sort(compareIds)
  return { normalizedDimensions, dimensionGaps, referencedMechanisms }
}

function validateClosureEvidence({
  root,
  dimensionId,
  evidenceRows,
  classificationById,
  actualStageById,
  problems,
}) {
  const ids = new Set()
  for (const [index, evidence] of evidenceRows.entries()) {
    const prefix = `dimension closure:${dimensionId}:closureEvidence[${index}]`
    if (!isRecord(evidence)) {
      problems.push(`${prefix}: evidence must be an object`)
      continue
    }
    if (!isNonEmptyString(evidence.id)) problems.push(`${prefix}: id must be non-empty`)
    else if (ids.has(evidence.id)) problems.push(`${prefix}: duplicate id: ${evidence.id}`)
    else ids.add(evidence.id)
    if (!isNonEmptyString(evidence.stageId)) {
      problems.push(`${prefix}: stageId must be non-empty`)
    } else if (!classificationById.has(evidence.stageId)) {
      problems.push(`${prefix}: unknown stage: ${evidence.stageId}`)
    } else if (!actualStageById.has(evidence.stageId)) {
      problems.push(
        `${prefix}: stage is not integrated in VERIFICATION_STAGES: ${evidence.stageId}`,
      )
    }
    if (!isNonEmptyString(evidence.claim)) problems.push(`${prefix}: claim must be non-empty`)
    validateExactLocator(root, evidence, prefix, problems)
  }
}

function validateExactLocator(root, evidence, prefix, problems) {
  if (!isExactRepoPath(evidence.path)) {
    problems.push(`${prefix}: path must be an exact normalized repository path`)
    return
  }
  if (!isNonEmptyString(evidence.locator)) {
    problems.push(`${prefix}: locator must be non-empty`)
    return
  }
  const absolute = resolve(root, evidence.path)
  const local = relative(root, absolute)
  if (local.startsWith('..') || isAbsolute(local)) {
    problems.push(`${prefix}: path escapes repository root: ${evidence.path}`)
  } else if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    problems.push(`${prefix}: path does not exist: ${evidence.path}`)
  } else if (!readFileSync(absolute, 'utf8').includes(evidence.locator)) {
    problems.push(`${prefix}: locator is stale in ${evidence.path}: ${evidence.locator}`)
  }
}

function validateReferenceArray(values, label, problems, visit, requireNonEmpty = true) {
  if (!isStringArray(values) || (requireNonEmpty && values.length === 0)) {
    problems.push(`${label} must be ${requireNonEmpty ? 'a non-empty' : 'an'} string array`)
    return
  }
  for (const duplicate of duplicates(values)) problems.push(`${label}: duplicate: ${duplicate}`)
  for (const value of values) visit(value)
}

function uniqueById(values, label, problems) {
  const byId = new Map()
  if (!Array.isArray(values)) {
    problems.push(`${label}: expected array`)
    return byId
  }
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || !isNonEmptyString(value.id)) {
      problems.push(`${label}[${index}]: id must be non-empty`)
      continue
    }
    if (byId.has(value.id)) problems.push(`${label}: duplicate id: ${value.id}`)
    else byId.set(value.id, value)
  }
  return new Map([...byId].sort(([left], [right]) => left.localeCompare(right)))
}

function parseArgs(argv) {
  const parsed = { manifest: DEFAULT_MANIFEST, mode: 'inventory', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg !== '--manifest' && arg !== '--mode') {
      throw new Error(`Unknown architecture-inventory-closure argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--manifest') parsed.manifest = resolve(value)
    else if (value === 'inventory' || value === 'enforce') parsed.mode = value
    else throw new Error(`Invalid architecture-inventory-closure mode: ${value}`)
    index += 1
  }
  return parsed
}

function printReport(report) {
  process.stdout.write(
    `Architecture inventory closure: actual-stages=${report.actualStageCount}, classified-stages=${report.classifiedStageCount}, mechanisms=${report.mechanismCount}, dimensions=${report.dimensionCount}, open-gaps=${report.openGapCount}.\n`,
  )
  if (report.gaps.length > 0) {
    process.stdout.write('Open closure gaps:\n')
    for (const gap of report.gaps) {
      process.stdout.write(`  ${gap.kind}:${gap.id}: ${gap.detail}\n`)
    }
  }
  if (report.problems.length > 0) {
    process.stderr.write(
      `Architecture inventory closure validation failed (${report.problems.length}):\n`,
    )
    for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
  } else if (report.mode === 'enforce' && report.gaps.length > 0) {
    process.stderr.write(
      `Architecture inventory closure enforcement failed: ${report.gaps.length} gaps remain.\n`,
    )
  }
}

function countBy(values, allowed) {
  const counts = Object.fromEntries([...allowed].map((value) => [value, 0]))
  for (const value of values) {
    if (Object.hasOwn(counts, value)) counts[value] += 1
  }
  return Object.freeze(counts)
}

function compareExact(label, expected, actual, problems) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  for (const value of expectedSet) {
    if (!actualSet.has(value)) problems.push(`${label}: missing ${value}`)
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) problems.push(`${label}: unclassified ${value}`)
  }
}

function sameStringArray(left, right) {
  return (
    isStringArray(left) &&
    isStringArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isExactRepoPath(value) {
  return (
    isNonEmptyString(value) &&
    !isAbsolute(value) &&
    value === posix.normalize(value) &&
    !value.startsWith('../') &&
    !value.includes('\\')
  )
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated].sort()
}

function compareIds(left, right) {
  return String(left.id).localeCompare(String(right.id))
}

function compareGaps(left, right) {
  return `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)
}

function format(value) {
  return JSON.stringify(value)
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const output = await auditArchitectureInventoryClosure({
    manifestPath: args.manifest,
    mode: args.mode,
  })
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  else printReport(output)
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
