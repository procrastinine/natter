import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, posix, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { auditProductionModuleInventory } from './audit-production-modules.mjs'
import { staticAuditState } from './audit-result-state.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_MODULE_INVENTORY = resolve(ROOT, 'scripts/production-module-inventory.json')
const DEFAULT_COVERAGE_MANIFEST = resolve(ROOT, 'scripts/architecture-coverage-manifest.mjs')
const VALID_STATUSES = new Set(['covered', 'gap', 'not-applicable'])
let manifestImportRevision = 0

export async function auditArchitectureCoverage(options = {}) {
  const root = options.root ?? ROOT
  const mode = options.mode ?? 'inventory'
  const moduleInventoryPath = options.inventory ?? DEFAULT_MODULE_INVENTORY
  const coverageManifestPath = options.manifest ?? DEFAULT_COVERAGE_MANIFEST
  const moduleAudit = auditProductionModuleInventory(root, moduleInventoryPath)
  const problems = moduleAudit.violations.map(
    (violation) => `canonical-module-inventory: ${violation.code}: ${violation.detail}`,
  )

  let canonicalInventory = null
  try {
    canonicalInventory = JSON.parse(readFileSync(moduleInventoryPath, 'utf8'))
  } catch (error) {
    problems.push(`canonical-module-inventory: ${errorText(error)}`)
  }

  let manifest = null
  try {
    manifestImportRevision += 1
    manifest = await import(
      `${pathToFileURL(coverageManifestPath).href}?audit=${manifestImportRevision}`
    )
    if (options.transformManifest) manifest = options.transformManifest(manifest)
  } catch (error) {
    problems.push(`coverage-manifest: ${errorText(error)}`)
  }

  const report = validateArchitectureCoverage({
    canonicalInventory,
    manifest,
    root,
    initialProblems: problems,
  })
  const enforcedGaps = mode === 'enforce' ? report.gaps : []
  const ok = report.problems.length === 0 && enforcedGaps.length === 0
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok,
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    sourceModuleCount: moduleAudit.moduleCount,
    classifiedModuleCount: moduleAudit.classificationCount,
    domainCount: report.domainCount,
    dimensionCount: report.dimensionCount,
    cellCount: report.cellCount,
    proofCount: report.proofCount,
    statusCounts: report.statusCounts,
    gaps: report.gaps,
    problems: report.problems,
  })
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const output = await auditArchitectureCoverage({
    mode: args.mode,
    ...(args.inventory ? { inventory: args.inventory } : {}),
    ...(args.manifest ? { manifest: args.manifest } : {}),
  })
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  else printReport(output)
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}

function parseArgs(argv) {
  const parsed = { inventory: null, manifest: null, mode: 'inventory', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (!['--inventory', '--manifest', '--mode'].includes(arg)) {
      throw new Error(`Unknown architecture-coverage argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--mode') {
      if (value !== 'inventory' && value !== 'enforce') {
        throw new Error(`Invalid architecture-coverage mode: ${value}`)
      }
      parsed.mode = value
    } else {
      parsed[arg === '--inventory' ? 'inventory' : 'manifest'] = resolve(value)
    }
    index += 1
  }
  return parsed
}

function validateArchitectureCoverage({ canonicalInventory, manifest, root, initialProblems }) {
  const problems = [...initialProblems]
  const canonicalDomains = canonicalDomainIds(canonicalInventory, problems)
  const dimensions = manifest?.ARCHITECTURE_DIMENSIONS
  const proofs = manifest?.ARCHITECTURE_PROOFS
  const coverage = manifest?.ARCHITECTURE_COVERAGE
  const dimensionById = validateDimensions(dimensions, problems)
  const proofById = validateProofs(proofs, canonicalDomains, dimensionById, root, problems)
  const gaps = []
  const referencedProofIds = new Set()
  let cellCount = 0

  if (!Array.isArray(coverage)) {
    problems.push('coverage: ARCHITECTURE_COVERAGE must be an array')
  } else {
    const coverageByDomain = uniqueById(coverage, 'domain', 'coverage domain', problems)
    for (const domain of difference(coverageByDomain.keys(), canonicalDomains)) {
      problems.push(`coverage: stale domain: ${domain}`)
    }
    for (const domain of difference(canonicalDomains, coverageByDomain.keys())) {
      problems.push(`coverage: missing domain: ${domain}`)
    }
    for (const domain of canonicalDomains) {
      const row = coverageByDomain.get(domain)
      if (!row) continue
      if (!isRecord(row.cells)) {
        problems.push(`coverage:${domain}: cells must be an object`)
        continue
      }
      for (const stale of difference(Object.keys(row.cells), dimensionById.keys())) {
        problems.push(`coverage:${domain}: stale dimension: ${stale}`)
      }
      for (const missing of difference(dimensionById.keys(), Object.keys(row.cells))) {
        problems.push(`coverage:${domain}: missing dimension: ${missing}`)
      }
      for (const dimensionId of dimensionById.keys()) {
        const cell = row.cells[dimensionId]
        if (!cell) continue
        cellCount += 1
        validateCell({
          cell,
          domain,
          dimensionId,
          dimension: dimensionById.get(dimensionId),
          proofById,
          referencedProofIds,
          gaps,
          problems,
        })
      }
    }
  }

  for (const proofId of proofById.keys()) {
    if (!referencedProofIds.has(proofId)) problems.push(`proofs: unreferenced proof: ${proofId}`)
  }

  gaps.sort(compareCoverageEntries)
  problems.sort()
  return {
    domainCount: canonicalDomains.size,
    dimensionCount: dimensionById.size,
    cellCount,
    proofCount: proofById.size,
    statusCounts: statusCounts(coverage),
    gaps,
    problems,
  }
}

function canonicalDomainIds(inventory, problems) {
  if (!isRecord(inventory) || !Array.isArray(inventory.classifications)) {
    problems.push('canonical-module-inventory: classifications must be an array')
    return new Set()
  }
  return new Set(
    inventory.classifications
      .map((classification) => classification?.domain)
      .filter(isNonEmptyString)
      .sort(),
  )
}

function validateDimensions(dimensions, problems) {
  if (!Array.isArray(dimensions)) {
    problems.push('dimensions: ARCHITECTURE_DIMENSIONS must be an array')
    return new Map()
  }
  const byId = uniqueById(dimensions, 'id', 'dimension', problems)
  for (const [id, dimension] of byId) {
    if (!isNonEmptyString(dimension.description)) {
      problems.push(`dimensions:${id}: description must be non-empty`)
    }
    if (!Array.isArray(dimension.allowedProofKinds) || dimension.allowedProofKinds.length === 0) {
      problems.push(`dimensions:${id}: allowedProofKinds must be a non-empty array`)
    } else {
      for (const duplicate of duplicates(dimension.allowedProofKinds)) {
        problems.push(`dimensions:${id}: duplicate allowed proof kind: ${duplicate}`)
      }
      for (const kind of dimension.allowedProofKinds) {
        if (!isNonEmptyString(kind)) problems.push(`dimensions:${id}: invalid proof kind`)
      }
    }
  }
  return byId
}

function validateProofs(proofs, canonicalDomains, dimensionById, root, problems) {
  if (!Array.isArray(proofs)) {
    problems.push('proofs: ARCHITECTURE_PROOFS must be an array')
    return new Map()
  }
  const byId = uniqueById(proofs, 'id', 'proof', problems)
  for (const [id, proof] of byId) {
    for (const field of ['kind', 'path', 'locator']) {
      if (!isNonEmptyString(proof[field])) problems.push(`proofs:${id}: ${field} must be non-empty`)
    }
    if (!isExactRepoPath(proof.path)) {
      problems.push(`proofs:${id}: path must be an exact normalized repository path: ${proof.path}`)
    } else {
      const absolutePath = resolve(root, proof.path)
      const relativePath = relative(root, absolutePath)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        problems.push(`proofs:${id}: path escapes repository root: ${proof.path}`)
      } else if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
        problems.push(`proofs:${id}: path does not exist: ${proof.path}`)
      } else if (
        isNonEmptyString(proof.locator) &&
        !readFileSync(absolutePath, 'utf8').includes(proof.locator)
      ) {
        problems.push(`proofs:${id}: locator is stale in ${proof.path}: ${proof.locator}`)
      }
    }
    validateScopeIds(proof.domains, canonicalDomains, `proofs:${id}: domain`, problems)
    validateScopeIds(proof.dimensions, dimensionById.keys(), `proofs:${id}: dimension`, problems)
  }
  return byId
}

function validateScopeIds(values, allowed, label, problems) {
  if (!Array.isArray(values) || values.length === 0) {
    problems.push(`${label} scope must be a non-empty array`)
    return
  }
  for (const duplicate of duplicates(values)) problems.push(`${label} duplicate: ${duplicate}`)
  const allowedSet = new Set(allowed)
  for (const value of values) {
    if (!allowedSet.has(value)) problems.push(`${label} is stale: ${value}`)
  }
}

function validateCell({
  cell,
  domain,
  dimensionId,
  dimension,
  proofById,
  referencedProofIds,
  gaps,
  problems,
}) {
  const prefix = `coverage:${domain}:${dimensionId}`
  if (!isRecord(cell)) {
    problems.push(`${prefix}: cell must be an object`)
    return
  }
  if (!VALID_STATUSES.has(cell.status)) problems.push(`${prefix}: invalid status: ${cell.status}`)
  if (!isNonEmptyString(cell.rationale))
    problems.push(`${prefix}: reviewer rationale must be non-empty`)
  if (!Array.isArray(cell.proofs)) {
    problems.push(`${prefix}: proofs must be an array`)
    return
  }
  for (const duplicate of duplicates(cell.proofs))
    problems.push(`${prefix}: duplicate proof: ${duplicate}`)

  if (cell.status === 'covered' && cell.proofs.length === 0) {
    problems.push(`${prefix}: covered cell needs exact proof references`)
  }
  if (cell.status !== 'covered' && cell.proofs.length > 0) {
    problems.push(`${prefix}: ${cell.status} cells cannot hide proof references`)
  }
  if (cell.status === 'gap') {
    gaps.push({ domain, dimension: dimensionId, rationale: cell.rationale })
  }
  for (const proofId of cell.proofs) {
    referencedProofIds.add(proofId)
    const proof = proofById.get(proofId)
    if (!proof) {
      problems.push(`${prefix}: unknown proof: ${proofId}`)
      continue
    }
    if (!proof.domains.includes(domain)) {
      problems.push(`${prefix}: proof ${proofId} does not declare domain ${domain}`)
    }
    if (!proof.dimensions.includes(dimensionId)) {
      problems.push(`${prefix}: proof ${proofId} does not declare dimension ${dimensionId}`)
    }
    if (!dimension?.allowedProofKinds?.includes(proof.kind)) {
      problems.push(
        `${prefix}: proof ${proofId} kind ${proof.kind} cannot satisfy this dimension; allowed=${dimension?.allowedProofKinds?.join(',') ?? '<none>'}`,
      )
    }
  }
}

function uniqueById(values, field, label, problems) {
  const result = new Map()
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || !isNonEmptyString(value[field])) {
      problems.push(`${label}[${index}]: ${field} must be non-empty`)
      continue
    }
    const id = value[field]
    if (result.has(id)) problems.push(`${label}: duplicate ${field}: ${id}`)
    else result.set(id, value)
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right)))
}

function statusCounts(coverage) {
  const counts = { covered: 0, gap: 0, 'not-applicable': 0 }
  if (!Array.isArray(coverage)) return counts
  for (const row of coverage) {
    if (!isRecord(row?.cells)) continue
    for (const cell of Object.values(row.cells)) {
      if (isRecord(cell) && cell.status in counts) counts[cell.status] += 1
    }
  }
  return counts
}

function printReport(report) {
  const summary = `Architecture coverage ${report.structurallyValid ? 'inventory' : 'validation'}: source-modules=${report.sourceModuleCount}, classified-modules=${report.classifiedModuleCount}, domains=${report.domainCount}, dimensions=${report.dimensionCount}, cells=${report.cellCount}, proofs=${report.proofCount}, covered=${report.statusCounts.covered}, gaps=${report.statusCounts.gap}, not-applicable=${report.statusCounts['not-applicable']}.`
  process.stdout.write(`${summary}\n`)
  if (report.gaps.length > 0) {
    process.stdout.write('Documented gaps:\n')
    for (const gap of report.gaps) {
      process.stdout.write(`  ${gap.domain} × ${gap.dimension}: ${gap.rationale}\n`)
    }
  }
  if (report.problems.length > 0) {
    process.stderr.write(`Architecture coverage validation failed (${report.problems.length}):\n`)
    for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
  } else if (report.mode === 'enforce' && report.gaps.length > 0) {
    process.stderr.write(
      `Architecture coverage enforcement failed: ${report.gaps.length} gaps remain.\n`,
    )
  }
}

function difference(left, right) {
  const rightSet = new Set(right)
  return [...left].filter((value) => !rightSet.has(value)).sort()
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    else seen.add(value)
  }
  return [...repeated].sort()
}

function isExactRepoPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('*') &&
    !value.startsWith('/') &&
    value === posix.normalize(value)
  )
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function compareCoverageEntries(left, right) {
  return left.domain.localeCompare(right.domain) || left.dimension.localeCompare(right.dimension)
}
