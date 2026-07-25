import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { staticAuditState } from './audit-result-state.mjs'
import { buildProductionAsyncOwnershipInventory } from './production-async-ownership-inventory.mjs'

export function evaluateProductionAsyncOwnership(inventory, mode = 'inventory') {
  if (mode !== 'enforce' && mode !== 'inventory') {
    throw new Error(`ProductionAsyncOwnershipAuditModeInvalid:${mode}`)
  }
  const structuralProblems = validateProductionAsyncOwnershipInventory(inventory)
  const enforcementProblems = mode === 'enforce' ? inventory.gaps.map((gap) => gap.id) : []
  const problems = [...structuralProblems, ...enforcementProblems]
  const structurallyValid = structuralProblems.length === 0
  return Object.freeze({
    mode,
    ok: problems.length === 0,
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: inventory.gaps }),
    ...inventory.counts,
    errorStrategyCounts: inventory.errorStrategyCounts,
    detachedKindCounts: inventory.detachedKindCounts,
    domainCount: Object.keys(inventory.domainCounts).length,
    syntacticGapCount: inventory.syntacticGaps.length,
    dispositionCounts: inventory.dispositionCounts,
    structuralProblemCount: structuralProblems.length,
    gapCount: inventory.gaps.length,
    gaps: inventory.gaps,
    problems,
  })
}

export function formatProductionAsyncOwnershipReport(report, summaryOnly = false) {
  return summaryOnly
    ? `async-ownership inventory=${report.inventoryComplete} manifest=${report.manifestFresh} closed=${report.guaranteeClosed} functions=${report.functions} detached=${report.detachedSites} gaps=${report.gapCount} structuralProblems=${report.structuralProblemCount}\n`
    : `${JSON.stringify(report)}\n`
}

export function parseProductionAsyncOwnershipArguments(args) {
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
    throw new Error(`ProductionAsyncOwnershipAuditArgumentsInvalid:${args.join(' ')}`)
  }
  return { mode, summaryOnly }
}

export function validateProductionAsyncOwnershipInventory(inventory) {
  const problems = []
  for (const [label, entries] of [
    ['function', inventory.functions],
    ['detached', inventory.detached],
  ]) {
    const ids = entries.map((entry) => entry.id)
    if (new Set(ids).size !== ids.length) problems.push(`AsyncOwnership${label}IdsDuplicate`)
    for (const entry of entries) {
      if (!entry.path || !entry.owner || !entry.domain || !entry.layer) {
        problems.push(`AsyncOwnership${label}ClassificationMissing:${entry.id}`)
      }
    }
  }
  if (inventory.counts.functions !== inventory.functions.length) {
    problems.push('AsyncOwnershipFunctionCountMismatch')
  }
  if (inventory.counts.detachedSites !== inventory.detached.length) {
    problems.push('AsyncOwnershipDetachedCountMismatch')
  }
  if (inventory.counts.unprovedDetachedFailures !== inventory.syntacticGaps.length) {
    problems.push('AsyncOwnershipSyntacticGapCountMismatch')
  }
  if (inventory.counts.reviewedArchitectureGaps !== inventory.gaps.length) {
    problems.push('AsyncOwnershipReviewedGapCountMismatch')
  }
  problems.push(...inventory.reviewProblems)
  return problems
}

async function runCli() {
  const options = parseProductionAsyncOwnershipArguments(process.argv.slice(2))
  const inventory = buildProductionAsyncOwnershipInventory()
  const report = evaluateProductionAsyncOwnership(inventory, options.mode)
  process.stdout.write(formatProductionAsyncOwnershipReport(report, options.summaryOnly))
  if (!report.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
