import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { buildProductionTimeInventory } from './audit-production-time.mjs'
import { staticAuditState } from './audit-result-state.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_MANIFEST = resolve(ROOT, 'scripts/production-time-semantics-inventory.mjs')
const SITE_KINDS = Object.freeze([
  'schedulers',
  'durations',
  'asyncRaces',
  'retryLoops',
  'maintenanceCommands',
])
const VALID_STATUSES = new Set(['covered', 'gap'])
const VALID_ELAPSED_ROLES = new Set([
  'none',
  'external-deadline',
  'freshness-policy',
  'failure-detection',
  'coalescing-policy',
  'presentation-policy',
  'yield-policy',
  'retention-policy',
])
const CRITICAL_OUTCOMES = new Set([
  'shell-clickability',
  'navigation',
  'painted-projection',
  'durable-correctness',
  'run-once-maintenance',
])
const REQUIRED_READINESS_PROOF_IDS = Object.freeze([
  'active-stream-reload-first-gesture-browser-proof',
])
const REQUIRED_READINESS_GAP_IDS = Object.freeze([])
const REQUIRED_LIMITATION_IDS = Object.freeze([
  'static-not-browser-proof',
  'operational-sites-not-every-timestamp',
  'manual-readiness-callgraph',
  'event-driven-recursion-boundary',
])

export function evaluateProductionTimeSemantics(
  baseInventory,
  inventoryModule,
  mode = 'inventory',
  initialProblems = [],
) {
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`ProductionTimeSemanticsAuditModeInvalid:${mode}`)
  }
  const report = auditProductionTimeSemantics(baseInventory, inventoryModule, initialProblems)
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || report.gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    baseCounts: report.baseCounts,
    semanticSiteCount: report.semanticSiteCount,
    groupCount: report.groupCount,
    statusCounts: report.statusCounts,
    readinessProofCount: report.readinessProofs.length,
    readinessGapCount: report.readinessGaps.length,
    criticalGapCount: report.gaps.filter((gap) => gap.criticalOutcomes.length > 0).length,
    sites: report.sites,
    readinessProofs: report.readinessProofs,
    readinessGaps: report.readinessGaps,
    limitations: report.limitations,
    gaps: report.gaps,
    problems: report.problems,
  })
}

export function auditProductionTimeSemantics(baseInventory, inventoryModule, initialProblems = []) {
  const problems = [...initialProblems]
  if (!isRecord(baseInventory)) {
    problems.push('base-inventory: expected JSON object')
  }
  const baseFailures = Array.isArray(baseInventory?.failures) ? baseInventory.failures : []
  for (const failure of baseFailures) problems.push(`base-inventory: ${failure}`)

  const actualByKind = new Map()
  for (const kind of SITE_KINDS) {
    const rows = baseInventory?.[kind]
    if (!Array.isArray(rows)) {
      problems.push(`base-inventory:${kind}: expected array`)
      actualByKind.set(kind, new Map())
      continue
    }
    const byId = new Map()
    for (const row of rows) {
      if (!isRecord(row) || !nonEmpty(row.id)) {
        problems.push(`base-inventory:${kind}: row without exact id`)
        continue
      }
      if (byId.has(row.id)) problems.push(`base-inventory:${kind}: duplicate id: ${row.id}`)
      byId.set(row.id, row)
    }
    actualByKind.set(kind, byId)
  }

  const groups = inventoryModule?.TEMPORAL_SEMANTIC_GROUPS
  const readinessProofInventory = inventoryModule?.TEMPORAL_READINESS_PROOFS
  const readinessGapInventory = inventoryModule?.TEMPORAL_READINESS_GAPS
  const limitationInventory = inventoryModule?.TEMPORAL_SEMANTIC_LIMITATIONS
  const assigned = new Map(SITE_KINDS.map((kind) => [kind, new Map()]))
  const gaps = []
  const semanticSites = []
  const groupIds = new Set()
  let semanticSiteCount = 0

  if (!Array.isArray(groups)) {
    problems.push('manifest: TEMPORAL_SEMANTIC_GROUPS must be an array')
  } else {
    for (const group of groups) {
      if (!isRecord(group) || !nonEmpty(group.id)) {
        problems.push('groups: every group needs a non-empty id')
        continue
      }
      const prefix = `groups:${group.id}`
      if (groupIds.has(group.id)) problems.push(`${prefix}: duplicate group id`)
      groupIds.add(group.id)
      validateGroupMetadata(group, prefix, problems)
      if (!isRecord(group.sites)) {
        problems.push(`${prefix}: sites must be an object`)
        continue
      }
      let groupSiteCount = 0
      for (const staleKind of Object.keys(group.sites).filter(
        (kind) => !SITE_KINDS.includes(kind),
      )) {
        problems.push(`${prefix}: stale site kind: ${staleKind}`)
      }
      for (const kind of SITE_KINDS) {
        const ids = group.sites[kind] ?? []
        if (!Array.isArray(ids)) {
          problems.push(`${prefix}:${kind}: expected array`)
          continue
        }
        for (const id of ids) {
          groupSiteCount += 1
          semanticSiteCount += 1
          if (!nonEmpty(id)) {
            problems.push(`${prefix}:${kind}: site id must be non-empty`)
            continue
          }
          const actual = actualByKind.get(kind)?.get(id)
          if (!actual) problems.push(`${prefix}:${kind}: stale site: ${id}`)
          const existing = assigned.get(kind)?.get(id)
          if (existing)
            problems.push(`${prefix}:${kind}: duplicate assignment with ${existing}: ${id}`)
          assigned.get(kind)?.set(id, group.id)
          validateSiteSemantics(group, prefix, kind, id, actual, problems)
          if (actual) semanticSites.push(semanticSiteRecord(group, kind, actual))
          if (group.status === 'gap') {
            gaps.push({
              group: group.id,
              kind,
              id,
              source: actual ? `${actual.file}:${actual.line}` : null,
              criticalOutcomes: [...group.criticalOutcomes],
              rationale: group.gapRationale,
            })
          }
        }
      }
      if (groupSiteCount === 0) problems.push(`${prefix}: group owns no exact sites`)
    }
  }

  for (const kind of SITE_KINDS) {
    for (const id of actualByKind.get(kind)?.keys() ?? []) {
      if (!assigned.get(kind)?.has(id)) problems.push(`unclassified:${kind}: ${id}`)
    }
  }

  const statusCounts = { covered: 0, gap: 0 }
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!isRecord(group) || !VALID_STATUSES.has(group.status) || !isRecord(group.sites)) continue
      const count = SITE_KINDS.reduce(
        (total, kind) => total + (Array.isArray(group.sites[kind]) ? group.sites[kind].length : 0),
        0,
      )
      statusCounts[group.status] += count
    }
  }

  const readinessProofs = validateReadinessProofs(readinessProofInventory, problems)
  const readinessGaps = validateReadinessGaps(readinessGapInventory, problems)
  const limitations = validateLimitations(limitationInventory, problems)
  gaps.push(...readinessGaps)

  gaps.sort((left, right) => left.id.localeCompare(right.id))
  semanticSites.sort(
    (left, right) =>
      left.source.file.localeCompare(right.source.file) ||
      left.source.line - right.source.line ||
      left.kind.localeCompare(right.kind),
  )
  problems.sort()
  return {
    baseCounts: Object.fromEntries(
      SITE_KINDS.map((kind) => [kind, actualByKind.get(kind)?.size ?? 0]),
    ),
    semanticSiteCount,
    groupCount: groupIds.size,
    statusCounts,
    sites: semanticSites,
    readinessProofs,
    readinessGaps,
    limitations,
    gaps,
    problems,
  }
}

function validateReadinessProofs(entries, problems) {
  return validateReadinessEntries(
    entries,
    REQUIRED_READINESS_PROOF_IDS,
    'readiness-proofs',
    'source-closed-browser-proof-closed',
    problems,
  )
}

function validateReadinessGaps(entries, problems) {
  return validateReadinessEntries(
    entries,
    REQUIRED_READINESS_GAP_IDS,
    'readiness-gaps',
    'source-closed-browser-proof-open',
    problems,
  )
}

function validateReadinessEntries(entries, requiredIds, label, timerRelationship, problems) {
  if (!Array.isArray(entries)) {
    problems.push(`${label}: readiness inventory must be an array`)
    return []
  }
  validateExactIds(entries, requiredIds, label, problems)
  const normalized = []
  for (const entry of entries) {
    if (!isRecord(entry) || !nonEmpty(entry.id)) continue
    const prefix = `${label}:${entry.id}`
    if (entry.timerRelationship !== timerRelationship) {
      problems.push(`${prefix}: timerRelationship must be ${timerRelationship}`)
    }
    if (!nonEmpty(entry.rationale)) problems.push(`${prefix}: rationale must be non-empty`)
    validateCriticalOutcomes(entry.criticalOutcomes, prefix, problems)
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      problems.push(`${prefix}: evidence must be a non-empty array`)
    } else {
      for (const [index, item] of entry.evidence.entries()) {
        validateEvidence(item, `${prefix}:evidence:${index}`, problems, 'src/')
      }
    }
    if (!Array.isArray(entry.acceptanceEvidence) || entry.acceptanceEvidence.length === 0) {
      problems.push(`${prefix}: acceptanceEvidence must be a non-empty array`)
    } else {
      for (const [index, item] of entry.acceptanceEvidence.entries()) {
        validateEvidence(item, `${prefix}:acceptance-evidence:${index}`, problems, 'tests/e2e/')
      }
    }
    normalized.push({
      group: entry.id,
      kind: 'readiness-await-chain',
      id: entry.id,
      source: null,
      criticalOutcomes: Array.isArray(entry.criticalOutcomes) ? [...entry.criticalOutcomes] : [],
      rationale: entry.rationale,
      timerRelationship: entry.timerRelationship,
      evidence: Array.isArray(entry.evidence) ? entry.evidence.map((item) => ({ ...item })) : [],
      acceptanceEvidence: Array.isArray(entry.acceptanceEvidence)
        ? entry.acceptanceEvidence.map((item) => ({ ...item }))
        : [],
    })
  }
  return normalized
}

function validateLimitations(entries, problems) {
  if (!Array.isArray(entries)) {
    problems.push('limitations: TEMPORAL_SEMANTIC_LIMITATIONS must be an array')
    return []
  }
  validateExactIds(entries, REQUIRED_LIMITATION_IDS, 'limitations', problems)
  return entries.filter(isRecord).map((entry) => {
    if (!nonEmpty(entry.detail)) problems.push(`limitations:${entry.id}: detail must be non-empty`)
    return { id: entry.id, detail: entry.detail }
  })
}

function validateExactIds(entries, expected, label, problems) {
  const ids = entries.map((entry) => entry?.id)
  const seen = new Set()
  for (const id of ids) {
    if (seen.has(id)) problems.push(`${label}: duplicate id: ${id}`)
    seen.add(id)
  }
  for (const id of ids) if (!expected.includes(id)) problems.push(`${label}: stale id: ${id}`)
  for (const id of expected) if (!seen.has(id)) problems.push(`${label}: missing id: ${id}`)
}

function validateEvidence(item, prefix, problems, requiredPrefix) {
  if (!isRecord(item) || !nonEmpty(item.path) || !nonEmpty(item.locator)) {
    problems.push(`${prefix}: exact path and locator are required`)
    return
  }
  const absolute = resolve(ROOT, item.path)
  if (!item.path.startsWith(requiredPrefix) || !existsSync(absolute)) {
    problems.push(`${prefix}: source path does not exist: ${item.path}`)
    return
  }
  const count = countOccurrences(readFileSync(absolute, 'utf8'), item.locator)
  if (count !== 1) problems.push(`${prefix}: locator occurrences=${count}; expected=1`)
}

function semanticSiteRecord(group, kind, actual) {
  return Object.freeze({
    group: group.id,
    kind,
    id: actual.id,
    status: group.status,
    source: Object.freeze({
      file: actual.file,
      line: actual.line,
      ...(actual.owner ? { owner: actual.owner } : {}),
      ...(actual.scheduler ? { scheduler: actual.scheduler } : {}),
      ...(actual.delay ? { delay: actual.delay } : {}),
      ...(actual.name ? { name: actual.name } : {}),
      ...(actual.value ? { value: actual.value } : {}),
      ...(actual.loop ? { loop: actual.loop, unbounded: actual.unbounded } : {}),
      ...(actual.kind ? { asyncPrimitive: actual.kind } : {}),
      ...(actual.maintenanceKind ? { maintenanceKind: actual.maintenanceKind } : {}),
    }),
    correctnessBasis: group.correctnessBasis,
    readinessImpact: group.readinessImpact,
    scope: group.scope,
    lifecycleOwner: group.lifecycleOwner,
    cancellationCleanup: group.cancellationCleanup,
    boundInputShape: group.boundInputShape,
    progressEvidence: group.progressEvidence,
    elapsedTimeRole: group.elapsedTimeRole,
    correctnessFromElapsedTime: group.correctnessFromElapsedTime,
    criticalOutcomes: Object.freeze([...group.criticalOutcomes]),
    ...(group.gapRationale ? { gapRationale: group.gapRationale } : {}),
  })
}

function validateGroupMetadata(group, prefix, problems) {
  for (const field of [
    'correctnessBasis',
    'readinessImpact',
    'scope',
    'lifecycleOwner',
    'cancellationCleanup',
    'boundInputShape',
    'progressEvidence',
  ]) {
    if (!nonEmpty(group[field])) problems.push(`${prefix}: ${field} must be non-empty`)
  }
  if (!VALID_ELAPSED_ROLES.has(group.elapsedTimeRole)) {
    problems.push(`${prefix}: invalid elapsedTimeRole: ${group.elapsedTimeRole}`)
  }
  if (!VALID_STATUSES.has(group.status)) problems.push(`${prefix}: invalid status: ${group.status}`)
  if (group.correctnessFromElapsedTime !== false) {
    problems.push(`${prefix}: elapsed time may not establish correctness`)
  }
  validateCriticalOutcomes(group.criticalOutcomes, prefix, problems)
  if (Array.isArray(group.criticalOutcomes)) {
    if (group.criticalOutcomes.length > 0 && group.status !== 'gap') {
      problems.push(`${prefix}: critical temporal path must remain an explicit gap`)
    }
  }
  if (group.status === 'gap') {
    if (!nonEmpty(group.gapRationale)) problems.push(`${prefix}: gapRationale must be non-empty`)
  } else if (group.gapRationale !== undefined) {
    problems.push(`${prefix}: covered group may not carry gapRationale`)
  }
}

function validateCriticalOutcomes(outcomes, prefix, problems) {
  if (!Array.isArray(outcomes)) {
    problems.push(`${prefix}: criticalOutcomes must be an array`)
    return
  }
  for (const outcome of outcomes) {
    if (!CRITICAL_OUTCOMES.has(outcome)) {
      problems.push(`${prefix}: invalid critical outcome: ${outcome}`)
    }
  }
}

function validateSiteSemantics(group, prefix, kind, id, actual, problems) {
  if (kind === 'schedulers') {
    if (/^(?:unknown|none|not-applicable)$/iu.test(group.cancellationCleanup)) {
      problems.push(`${prefix}:${kind}: scheduler lacks cancellation/cleanup evidence: ${id}`)
    }
    if (
      actual &&
      (actual.scheduler === 'setTimeout' || actual.scheduler === 'setInterval') &&
      group.elapsedTimeRole === 'none'
    ) {
      problems.push(`${prefix}:${kind}: timer needs an explicit elapsed-time policy: ${id}`)
    }
  }
  if (kind === 'retryLoops' && actual?.unbounded && !nonEmpty(group.progressEvidence)) {
    problems.push(`${prefix}:${kind}: unbounded loop lacks progress evidence: ${id}`)
  }
  if (
    kind === 'maintenanceCommands' &&
    !/(?:version|marker|keyset|deadline|index)/iu.test(group.boundInputShape)
  ) {
    problems.push(`${prefix}:${kind}: maintenance needs run-once or indexed bound evidence: ${id}`)
  }
  if (
    kind === 'durations' &&
    !/(?:consumer|constant|policy|deadline|ttl|age|interval)/iu.test(group.boundInputShape)
  ) {
    problems.push(`${prefix}:${kind}: duration lacks consumer/input-shape evidence: ${id}`)
  }
}

export function parseProductionTimeSemanticsArguments(argv) {
  const parsed = { manifest: DEFAULT_MANIFEST, mode: 'inventory', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg !== '--manifest' && arg !== '--mode') {
      throw new Error(`Unknown production-time-semantics argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--manifest') parsed.manifest = resolve(value)
    else {
      if (value !== 'inventory' && value !== 'enforce') {
        throw new Error(`Invalid production-time-semantics mode: ${value}`)
      }
      parsed.mode = value
    }
    index += 1
  }
  return parsed
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error) {
  return error instanceof Error ? `${error.name}:${error.message}` : String(error)
}

function countOccurrences(source, locator) {
  let count = 0
  let offset = 0
  while (true) {
    const index = source.indexOf(locator, offset)
    if (index < 0) return count
    count += 1
    offset = index + locator.length
  }
}

async function runCli() {
  const args = parseProductionTimeSemanticsArguments(process.argv.slice(2))
  let manifest = null
  const importProblems = []
  try {
    manifest = await import(pathToFileURL(args.manifest).href)
  } catch (error) {
    importProblems.push(`manifest: ${errorText(error)}`)
  }
  const output = evaluateProductionTimeSemantics(
    buildProductionTimeInventory(),
    manifest,
    args.mode,
    importProblems,
  )
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Production temporal semantics inventory: sites=${output.semanticSiteCount}, groups=${output.groupCount}, schedulers=${output.baseCounts.schedulers}, durations=${output.baseCounts.durations}, async-races=${output.baseCounts.asyncRaces}, retry-loops=${output.baseCounts.retryLoops}, maintenance=${output.baseCounts.maintenanceCommands}, covered-sites=${output.statusCounts.covered}, site-gaps=${output.statusCounts.gap}, readiness-proofs=${output.readinessProofCount}, readiness-gaps=${output.readinessGapCount}, structural-problems=${output.problems.length}.\n`,
    )
    const gapGroups = [...new Set(output.gaps.map((gap) => gap.group))]
    if (gapGroups.length > 0) {
      process.stdout.write(`Temporal gap groups: ${gapGroups.join(', ')}.\n`)
    }
  }
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
