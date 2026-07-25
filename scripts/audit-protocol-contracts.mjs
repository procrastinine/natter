import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { evaluateConfigurationProtocol } from './audit-configuration-protocol.mjs'
import { evaluateDurableCommandPipeline } from './audit-durable-command-pipeline.mjs'
import {
  buildProductionDiscriminatedUnionInventory,
  evaluateProductionDiscriminatedUnionInventory,
} from './audit-production-discriminated-unions.mjs'
import { evaluateProductionProtocol } from './audit-production-protocol.mjs'
import { evaluateProtocolStages } from './audit-protocol-stages.mjs'
import { staticAuditState } from './audit-result-state.mjs'
import { evaluateTabCrossTabLocality } from './audit-tab-cross-tab-locality.mjs'
import * as configurationInventory from './configuration-protocol-inventory.mjs'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import * as durableInventory from './durable-command-pipeline-inventory.mjs'
import { buildProductionProtocolFactBundle } from './production-protocol-fact-bundle.mjs'
import { createProductionTypeScriptProgram } from './production-typescript-source.mjs'
import { PROTOCOL_CONTRACT_REPORT_IDS } from './protocol-contract-descriptor.mjs'
import { PROTOCOL_STAGE_SWITCHES } from './protocol-stage-inventory.mjs'
import * as localityInventory from './tab-cross-tab-locality-inventory.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export function evaluateProtocolContractBundle(bundle, options = {}) {
  const mode = options.mode ?? 'inventory'
  const production = evaluateProductionProtocol(bundle.production)
  const unions = evaluateProductionDiscriminatedUnionInventory(
    buildProductionDiscriminatedUnionInventory({
      discovered: bundle.unionDiscovery,
      auditCapabilities: bundle.auditCapabilities,
    }),
    mode,
  )
  const stages = evaluateProtocolStages(
    options.protocolStageManifest ?? PROTOCOL_STAGE_SWITCHES,
    bundle.stages,
  )
  const configuration = evaluateConfigurationProtocol(
    options.configurationInventory ?? configurationInventory,
    mode,
    bundle.configuration,
  )
  const durable = evaluateDurableCommandPipeline(
    options.durableInventory ?? durableInventory,
    mode,
    options.durableOptions ?? {},
    bundle.durable,
  )
  const locality = evaluateTabCrossTabLocality(
    options.localityInventory ?? localityInventory,
    mode,
    false,
    bundle.locality,
  )
  const reports = Object.freeze({
    [PROTOCOL_CONTRACT_REPORT_IDS.unions]: unions,
    [PROTOCOL_CONTRACT_REPORT_IDS.production]: production,
    [PROTOCOL_CONTRACT_REPORT_IDS.configuration]: configuration,
    [PROTOCOL_CONTRACT_REPORT_IDS.durable]: durable,
    [PROTOCOL_CONTRACT_REPORT_IDS.stages]: stages,
    [PROTOCOL_CONTRACT_REPORT_IDS.locality]: locality,
  })
  const structurallyValid = Object.values(reports).every(
    (report) => (report.structurallyValid ?? report.ok) === true,
  )
  const gaps = Object.freeze([
    ...(unions.gapCount + unions.constructionGapCount === 0
      ? []
      : [
          Object.freeze({
            reportId: PROTOCOL_CONTRACT_REPORT_IDS.unions,
            coverageGaps: unions.gapCount,
            constructionGaps: unions.constructionGapCount,
          }),
        ]),
    ...configuration.gaps.map((gap) =>
      Object.freeze({ reportId: PROTOCOL_CONTRACT_REPORT_IDS.configuration, ...gap }),
    ),
    ...(durable.gapCells === 0
      ? []
      : [
          Object.freeze({
            reportId: PROTOCOL_CONTRACT_REPORT_IDS.durable,
            gapCells: durable.gapCells,
          }),
        ]),
    ...(locality.architectureGaps + locality.recordGaps + locality.siteGaps === 0
      ? []
      : [
          Object.freeze({
            reportId: PROTOCOL_CONTRACT_REPORT_IDS.locality,
            architectureGaps: locality.architectureGaps,
            recordGaps: locality.recordGaps,
            siteGaps: locality.siteGaps,
          }),
        ]),
  ])
  return Object.freeze({
    schemaVersion: 1,
    ok: Object.values(reports).every((report) => report.ok),
    mode,
    snapshot: bundle.snapshot,
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps }),
    gaps,
    reports,
  })
}

export function buildProtocolContractMutationProof(baselineBundle) {
  const changedProgram = programWithSourceMutations({
    'src/store/workspace-protocol.ts': (source) =>
      source.replace(
        '  | OrganizationCommand\n\nexport type WorkspaceCommandResult',
        "  | OrganizationCommand\n  | { kind: 'audit.injected-workspace-command' }\n\nexport type WorkspaceCommandResult",
      ),
    'src/store/configuration-domain-contract.ts': (source) =>
      source.replace(
        '  | ConfigurationPromptDeleteCommand\n\nexport type ConfigurationDomainCommandKind',
        "  | ConfigurationPromptDeleteCommand\n  | { readonly kind: 'audit.injected-configuration-command' }\n\nexport type ConfigurationDomainCommandKind",
      ),
    'src/store/workspace-runtime-control.ts': (source) =>
      source.replace("  'import-export',\n  false,", "  'maintenance',\n  false,").concat(`
export const forgedRootAdmission = (() => undefined) as WorkspaceRootAdmissionCapability<
  () => void,
  { readonly fixedKind: 'chat-fork' }
>
forgedRootAdmission()
`),
  })
  const changedBundle = buildProductionProtocolFactBundle({ program: changedProgram })
  const changedReport = evaluateProtocolContractBundle(changedBundle)
  const unionIds = new Set([
    'src/store/workspace-protocol.ts#WorkspaceCommand|kind',
    'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind',
  ])
  return Object.freeze({
    schemaVersion: 1,
    baselineSnapshot: baselineBundle.snapshot,
    changedSnapshot: changedBundle.snapshot,
    construction: Object.freeze({ programCreations: 1, unionDiscoveries: 1 }),
    changedFacts: Object.freeze({
      workspaceCommandVariants: changedBundle.production.protocols.WorkspaceCommand.variants,
      configurationCommandVariants: changedBundle.configuration.commandUnion.variants,
      unionEntries: changedReport.reports[PROTOCOL_CONTRACT_REPORT_IDS.unions].entries.filter(
        (entry) => unionIds.has(entry.id),
      ),
    }),
    changedReport: Object.freeze({
      ok: changedReport.ok,
      productionProblems: changedReport.reports[PROTOCOL_CONTRACT_REPORT_IDS.production].problems,
      stageProblems: changedReport.reports[PROTOCOL_CONTRACT_REPORT_IDS.stages].problems,
      configurationProblems:
        changedReport.reports[PROTOCOL_CONTRACT_REPORT_IDS.configuration].problems,
      durableProblems: changedReport.reports[PROTOCOL_CONTRACT_REPORT_IDS.durable].problems,
      localityProblems: changedReport.reports[PROTOCOL_CONTRACT_REPORT_IDS.locality].problems,
    }),
  })
}

function parseArgs(argv) {
  const options = { mode: 'inventory', json: false, factsOutput: null, mutationOutput: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--facts-output') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --facts-output')
      options.factsOutput = resolve(ROOT, value)
      index += 1
      continue
    }
    if (arg === '--mutation-output') {
      const value = argv[index + 1]
      if (!value) throw new Error('Missing value for --mutation-output')
      options.mutationOutput = resolve(ROOT, value)
      index += 1
      continue
    }
    if (arg !== '--mode') throw new Error(`Unknown protocol-contract argument: ${arg}`)
    const value = argv[index + 1]
    if (value !== 'inventory' && value !== 'enforce') {
      throw new Error(`Invalid protocol-contract mode: ${value ?? '<missing>'}`)
    }
    options.mode = value
    index += 1
  }
  return options
}

function printHumanReport(report) {
  const unions = report.reports[PROTOCOL_CONTRACT_REPORT_IDS.unions]
  const production = report.reports[PROTOCOL_CONTRACT_REPORT_IDS.production]
  const configuration = report.reports[PROTOCOL_CONTRACT_REPORT_IDS.configuration]
  const durable = report.reports[PROTOCOL_CONTRACT_REPORT_IDS.durable]
  const stages = report.reports[PROTOCOL_CONTRACT_REPORT_IDS.stages]
  const locality = report.reports[PROTOCOL_CONTRACT_REPORT_IDS.locality]
  process.stdout.write(
    `Protocol contracts: snapshot=${report.snapshot.digest}, sources=${report.snapshot.sourceFiles}.\n`,
  )
  process.stdout.write(
    `  unions: discovered=${unions.discoveredCount}, control=${unions.controlProtocolCount}, dedicated=${unions.coverageCounts.dedicated ?? 0}, derived=${unions.coverageCounts.derived ?? 0}, gaps=${unions.gapCount}, construction-gaps=${unions.constructionGapCount}, problems=${unions.violations.length}.\n`,
  )
  process.stdout.write(
    `  production: queries=${production.protocols.WorkspaceQuery.variants.length}, commands=${production.protocols.WorkspaceCommand.variants.length}, admissions=${production.roots.finiteAdmissions}, problems=${production.problems.length}.\n`,
  )
  process.stdout.write(
    `  stages: switches=${stages.switches.length}, problems=${stages.problems.length}.\n`,
  )
  process.stdout.write(
    `  configuration: commands=${configuration.commandVariants}, reachable=${configuration.reachableCommands}, gaps=${configuration.gaps.length}, problems=${configuration.problems.length}.\n`,
  )
  process.stdout.write(
    `  durable: records=${durable.pipelineRecords}, cells=${durable.stageCells}, gaps=${durable.gapCells}, direct-transactions=${durable.directTransactionCalls}, problems=${durable.problems.length}.\n`,
  )
  process.stdout.write(
    `  locality: surfaces=${locality.surfaces}, records=${locality.records}, sites=${locality.constructorSites}, gaps=${locality.architectureGaps + locality.recordGaps + locality.siteGaps}, problems=${locality.problems.length}.\n`,
  )
}

async function persistFactBundle(path, bundle) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(bundle)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

function programWithSourceMutations(mutations) {
  const configPath = resolve(ROOT, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, (file) => readFileSync(file, 'utf8'))
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT, undefined, configPath)
  const changedByPath = new Map(
    Object.entries(mutations).map(([path, mutate]) => {
      const absolute = resolve(ROOT, path)
      const original = readFileSync(absolute, 'utf8')
      const changed = mutate(original)
      if (changed === original) throw new Error(`ProtocolAuditMutationDidNotChangeSource:${path}`)
      return [absolute, changed]
    }),
  )
  const host = ts.createCompilerHost(parsed.options)
  const load = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const changed = changedByPath.get(resolve(fileName))
    return changed === undefined
      ? load(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, changed, languageVersion, true)
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2))
  const program = createProductionTypeScriptProgram(ROOT)
  const discovered = discoverProductionDiscriminatedUnions(ROOT, { program })
  const bundle = buildProductionProtocolFactBundle({ program, discovered })
  const report = evaluateProtocolContractBundle(bundle, options)
  if (options.factsOutput) await persistFactBundle(options.factsOutput, bundle)
  if (options.mutationOutput) {
    await persistFactBundle(options.mutationOutput, buildProtocolContractMutationProof(bundle))
  }
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else printHumanReport(report)
  if (!report.ok) process.exitCode = 1
}
