import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { staticAuditState } from './audit-result-state.mjs'
import { buildProductionRuntimeEffectInventory } from './production-runtime-effects-inventory.mjs'

export function auditProductionRuntimeEffects(options = {}) {
  const mode = options.mode ?? 'inventory'
  const inventory = buildProductionRuntimeEffectInventory(options.root)
  return evaluateProductionRuntimeEffects(inventory, mode)
}

export function evaluateProductionRuntimeEffects(inventory, mode = 'inventory') {
  if (mode !== 'enforce' && mode !== 'inventory') {
    throw new Error(`ProductionRuntimeEffectsAuditModeInvalid:${mode}`)
  }
  const structuralProblems = validateInventory(inventory)
  const enforcementProblems = mode === 'enforce' ? inventory.gaps.map((gap) => gap.id) : []
  const problems = [...structuralProblems, ...enforcementProblems]
  const structurallyValid = structuralProblems.length === 0

  return Object.freeze({
    mode,
    ok: problems.length === 0,
    structurallyValid,
    structuralProblemCount: structuralProblems.length,
    ...staticAuditState({ structurallyValid, gaps: inventory.gaps }),
    ...inventory.counts,
    categoryCount: Object.keys(inventory.categoryCounts).length,
    domainCount: Object.keys(inventory.domainCounts).length,
    syntacticGapCount: inventory.syntacticGaps.length,
    dispositionCounts: inventory.dispositionCounts,
    gapCount: inventory.gaps.length,
    gaps: inventory.gaps,
    problems,
  })
}

function runCli() {
  const options = parseArguments(process.argv.slice(2))
  const summary = auditProductionRuntimeEffects({ mode: options.mode })
  process.stdout.write(
    options.summaryOnly
      ? `runtime-effects inventory=${summary.inventoryComplete} manifest=${summary.manifestFresh} closed=${summary.guaranteeClosed} sites=${summary.sites} gaps=${summary.gapCount} structuralProblems=${summary.structuralProblemCount}\n`
      : `${JSON.stringify(summary)}\n`,
  )
  if (!summary.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli()

function parseArguments(args) {
  let mode = 'inventory'
  let summaryOnly = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--summary') {
      summaryOnly = true
      continue
    }
    if (argument === '--mode' && ['enforce', 'inventory'].includes(args[index + 1])) {
      mode = args[index + 1]
      index += 1
      continue
    }
    throw new Error(`ProductionRuntimeEffectsAuditArgumentsInvalid:${args.join(' ')}`)
  }
  return { mode, summaryOnly }
}

function validateInventory(inventory) {
  const problems = []
  const ids = inventory.sites.map((site) => site.id)
  if (new Set(ids).size !== ids.length) problems.push('RuntimeEffectSiteIdsDuplicate')
  if (inventory.counts.sites !== inventory.sites.length) problems.push('RuntimeEffectCountMismatch')
  if (inventory.counts.missingReleaseEvidence !== inventory.syntacticGaps.length) {
    problems.push('RuntimeEffectSyntacticGapCountMismatch')
  }
  if (inventory.counts.reviewedArchitectureGaps !== inventory.gaps.length) {
    problems.push('RuntimeEffectReviewedGapCountMismatch')
  }
  problems.push(...inventory.reviewProblems)
  for (const site of inventory.sites) {
    if (!site.domain || !site.layer || !site.capability || !site.locality || !site.owner) {
      problems.push(`RuntimeEffectSiteClassificationMissing:${site.id}`)
    }
    if (
      site.requiresRelease &&
      !['candidate-only', 'delegated-to-caller', 'missing'].includes(site.releaseEvidence)
    ) {
      problems.push(`RuntimeEffectReleaseDispositionMissing:${site.id}`)
    }
  }
  return problems
}
