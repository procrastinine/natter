import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { staticAuditState } from './audit-result-state.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_INVENTORY = resolve(ROOT, 'scripts/hidden-tab-visual-continuity-inventory.mjs')
const REQUIRED_SURFACE_IDS = Object.freeze([
  'profile-glyph-svg',
  'connection-provider-svg',
  'chat-settings-static-bundle',
  'global-settings-static-bundle',
  'retained-model-picker',
  'retained-provider-picker',
  'context-settings-body',
  'header-privacy-popover',
])
const REQUIRED_TRANSITION_IDS = Object.freeze([
  'live-stream-projection-foreground-refresh',
  'scroll-foreground-geometry-reconciliation',
  'composer-draft-hide-flush',
])
const REQUIRED_PROOF_IDS = Object.freeze([
  'visibility-live-workspace-and-first-gesture',
  'conversation-exact-paint-retention',
  'privacy-popover-retention',
  'provider-row-retention',
  'connection-header-retention',
  'active-stream-reload-first-gesture',
  'headed-native-visibility-project',
  'headed-native-visibility-xvfb',
  'headed-native-visibility-checkpoint-stage',
  'first-foreground-paint-fingerprints',
])
const REQUIRED_GAP_IDS = Object.freeze([])
const REQUIRED_ACCEPTANCE_IDS = Object.freeze([
  'paint-independent-of-resource-readiness',
  'capability-scoped-interaction',
  'first-gesture-preserved',
  'stateful-ui-continuity',
  'real-tab-first-frame-continuity',
  'active-stream-independent',
  'bounded-retained-presentation',
])
const VALID_IMPLEMENTATIONS = new Set([
  'inline-svg',
  'static-import',
  'retained-projection',
  'conditional-body',
  'local-ui-state',
])
const VALID_OWNERS = new Set(['stream-projection', 'viewport-continuity', 'draft-persistence'])
const VALID_PROOF_KINDS = new Set([
  'browser',
  'component',
  'controller',
  'memory',
  'multi-tab',
  'performance',
  'timing',
  'visual',
])

export function evaluateHiddenTabVisualContinuity(
  inventory,
  mode = 'inventory',
  root = ROOT,
  initialProblems = [],
) {
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`HiddenTabVisualContinuityAuditModeInvalid:${mode}`)
  }
  const report = auditHiddenTabVisualContinuity(root, inventory, initialProblems)
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || report.gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    surfaceCount: report.surfaceCount,
    transitionCount: report.transitionCount,
    proofCount: report.proofCount,
    gapCount: report.gaps.length,
    acceptanceCount: report.acceptanceCount,
    gaps: report.gaps,
    problems: report.problems,
  })
}

export function formatHiddenTabVisualContinuityReport(report, pretty = false) {
  return `${JSON.stringify(report, null, pretty ? 2 : 0)}\n`
}

export function auditHiddenTabVisualContinuity(root, inventoryModule, initialProblems = []) {
  const problems = [...initialProblems]
  const surfaces = inventoryModule?.HIDDEN_TAB_PAINTED_SURFACES
  const transitions = inventoryModule?.HIDDEN_TAB_PRESENTATION_TRANSITIONS
  const proofs = inventoryModule?.HIDDEN_TAB_EXISTING_PROOFS
  const gaps = inventoryModule?.HIDDEN_TAB_VISUAL_CONTINUITY_GAPS
  const acceptance = inventoryModule?.HIDDEN_TAB_VISUAL_CONTINUITY_ACCEPTANCE

  validateExactIds(surfaces, REQUIRED_SURFACE_IDS, 'surfaces', problems)
  validateExactIds(transitions, REQUIRED_TRANSITION_IDS, 'transitions', problems)
  validateExactIds(proofs, REQUIRED_PROOF_IDS, 'proofs', problems)
  validateExactIds(gaps, REQUIRED_GAP_IDS, 'gaps', problems)
  validateExactIds(acceptance, REQUIRED_ACCEPTANCE_IDS, 'acceptance', problems)
  validateSourceLocators(surfaces, 'surfaces', root, problems)
  validateSourceLocators(transitions, 'transitions', root, problems)
  validateSourceLocators(proofs, 'proofs', root, problems)
  validateSourceLocators(gaps, 'gaps', root, problems)
  validateClassification(surfaces, 'implementation', VALID_IMPLEMENTATIONS, problems)
  validateClassification(transitions, 'owner', VALID_OWNERS, problems)
  validateAcceptance(acceptance, problems)
  validateStaticResidency(surfaces, problems)

  const normalizedGaps = Array.isArray(gaps)
    ? gaps
        .filter(isRecord)
        .map((gap) => ({ id: gap.id, path: gap.path, rationale: gap.rationale }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    : []
  problems.sort()
  return {
    surfaceCount: Array.isArray(surfaces) ? surfaces.length : 0,
    transitionCount: Array.isArray(transitions) ? transitions.length : 0,
    proofCount: Array.isArray(proofs) ? proofs.length : 0,
    acceptanceCount: Array.isArray(acceptance) ? acceptance.length : 0,
    gaps: normalizedGaps,
    problems,
  }
}

export function parseHiddenTabVisualContinuityArguments(argv) {
  const parsed = { inventory: DEFAULT_INVENTORY, mode: 'inventory', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg !== '--inventory' && arg !== '--mode') {
      throw new Error(`Unknown hidden-tab visual-continuity argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--inventory') parsed.inventory = resolve(value)
    else {
      if (value !== 'inventory' && value !== 'enforce') {
        throw new Error(`Invalid hidden-tab visual-continuity mode: ${value}`)
      }
      parsed.mode = value
    }
    index += 1
  }
  return parsed
}

async function runCli() {
  const args = parseHiddenTabVisualContinuityArguments(process.argv.slice(2))
  let inventory = null
  const importProblems = []
  try {
    inventory = await import(`${pathToFileURL(args.inventory).href}?audit=${Date.now()}`)
  } catch (error) {
    importProblems.push(`inventory: ${errorText(error)}`)
  }
  const report = evaluateHiddenTabVisualContinuity(inventory, args.mode, ROOT, importProblems)
  process.stdout.write(formatHiddenTabVisualContinuityReport(report, args.json))
  if (!report.ok) process.exitCode = 1
}

function validateExactIds(entries, expected, label, problems) {
  if (!Array.isArray(entries)) {
    problems.push(`${label}: must be an array`)
    return
  }
  const ids = entries.map((entry) => entry?.id)
  for (const duplicate of duplicates(ids)) problems.push(`${label}: duplicate id: ${duplicate}`)
  for (const stale of difference(ids, expected)) problems.push(`${label}: stale id: ${stale}`)
  for (const missing of difference(expected, ids)) problems.push(`${label}: missing id: ${missing}`)
  if (ids.join('\0') !== expected.join('\0')) problems.push(`${label}: canonical order changed`)
}

function validateSourceLocators(entries, label, root, problems) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue
    const prefix = `${label}:${entry.id}`
    if (!isNonEmptyString(entry.path) || !isExactRepoPath(entry.path)) {
      problems.push(`${prefix}: invalid exact source path: ${entry.path}`)
      continue
    }
    const absolute = resolve(root, entry.path)
    const relativePath = relative(root, absolute)
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || !existsSync(absolute)) {
      problems.push(`${prefix}: source path does not exist: ${entry.path}`)
      continue
    }
    if (!isNonEmptyString(entry.locator)) {
      problems.push(`${prefix}: locator must be non-empty`)
      continue
    }
    if (
      entry.requiredLocators !== undefined &&
      (!Array.isArray(entry.requiredLocators) ||
        entry.requiredLocators.some((locator) => !isNonEmptyString(locator)))
    ) {
      problems.push(`${prefix}: requiredLocators must contain only non-empty strings`)
      continue
    }
    const source = readFileSync(absolute, 'utf8')
    const locators = [entry.locator, ...(entry.requiredLocators ?? [])]
    for (const locator of locators) {
      const count = countOccurrences(source, locator)
      if (count !== 1) {
        problems.push(`${prefix}: locator occurrences=${count}; expected=1: ${locator}`)
      }
    }
  }
}

function validateClassification(entries, field, validValues, problems) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue
    if (!validValues.has(entry[field])) {
      problems.push(`${entry.id}: invalid ${field}: ${entry[field]}`)
    }
  }
}

function validateAcceptance(entries, problems) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue
    if (!isNonEmptyString(entry.invariant)) {
      problems.push(`acceptance:${entry.id}: invariant must be non-empty`)
    }
    if (!Array.isArray(entry.proofKinds) || entry.proofKinds.length === 0) {
      problems.push(`acceptance:${entry.id}: proofKinds must be non-empty`)
      continue
    }
    for (const kind of entry.proofKinds) {
      if (!VALID_PROOF_KINDS.has(kind)) {
        problems.push(`acceptance:${entry.id}: invalid proof kind: ${kind}`)
      }
    }
  }
}

function validateStaticResidency(surfaces, problems) {
  if (!Array.isArray(surfaces)) return
  for (const surface of surfaces) {
    if (!isRecord(surface) || surface.implementation !== 'static-import') continue
    if (String(surface.locator).includes('import(')) {
      problems.push(`surfaces:${surface.id}: resident surface uses a dynamic import`)
    }
  }
}

function duplicates(values) {
  const seen = new Set()
  const duplicateValues = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value)
    seen.add(value)
  }
  return [...duplicateValues].sort()
}

function difference(left, right) {
  const accepted = new Set(right)
  return [...new Set(left.filter((value) => !accepted.has(value)))].sort()
}

function countOccurrences(source, locator) {
  if (locator.length === 0) return 0
  let count = 0
  let index = 0
  while (true) {
    index = source.indexOf(locator, index)
    if (index < 0) return count
    count += 1
    index += locator.length
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isExactRepoPath(value) {
  return (
    typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('..')
  )
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
