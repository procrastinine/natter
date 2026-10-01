import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import ts from 'typescript'
import { ARCHITECTURE_COVERAGE } from './architecture-coverage-manifest.mjs'
import {
  createFilesystemLocalModuleSource,
  discoverLocalModulePaths,
  LOCAL_MODULE_ASSET_EXTENSIONS,
  reverseReachableLocalModules,
  scanLocalModuleGraph,
  scanReachableLocalModuleGraph,
} from './local-module-graph.mjs'
import { browserProjectsForFile, selectBrowserTasks } from './playwright-selection.mjs'
import {
  compileSliceVerificationStages,
  VERIFICATION_STAGES,
  verificationStageInputPaths,
} from './run-verification.mjs'
import { TEST_GUARANTEE_CLAIMS } from './test-evidence-manifest.mjs'
import {
  VERIFICATION_EXPLICIT_MODULE_EDGES,
  VERIFICATION_OBLIGATION_SCHEMA_VERSION,
  VERIFICATION_OBLIGATIONS,
  VERIFICATION_OPAQUE_MODULE_REFERENCE_DISPOSITIONS,
  VERIFICATION_PROOFS,
  VERIFICATION_STATIC_PROOF_IDS,
  verificationGlobalInputPaths,
} from './verification-obligation-manifest.mjs'
import { VERIFICATION_SNAPSHOT_SCHEMA_VERSION } from './verification-snapshot-schema.mjs'
import { isVitestSuitePath, parseVitestProjectSource, vitestProjects } from './vitest-projects.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const VITEST_PROJECT_PROVIDER_INPUTS = ['scripts/vitest-projects.mjs', 'vitest.config.ts']
let loadedProjectProviderInputs

export function verificationSnapshotInputPaths(options) {
  const source = options.source
  const globalInputs =
    options.globalInputs ?? verificationGlobalInputPaths({ allPaths: source.allPaths })
  return uniqueSorted([
    ...discoverLocalModulePaths({ source }),
    ...globalInputs,
    ...(options.stages ?? VERIFICATION_STAGES).flatMap((stage) =>
      verificationStageInputPaths(stage, source.allPaths),
    ),
  ]).filter((path) => source.allPaths.has(path))
}

export function buildVerificationSnapshot(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const initialGlobalInputs =
    options.globalInputs ??
    verificationGlobalInputPaths(options.source ? { allPaths: options.source.allPaths } : { root })
  const source =
    options.source ??
    createFilesystemLocalModuleSource({
      root,
      additionalPaths: [
        ...initialGlobalInputs,
        ...VERIFICATION_STAGES.flatMap((stage) => verificationStageInputPaths(stage)),
      ],
    })
  const globalInputs =
    options.globalInputs ?? verificationGlobalInputPaths({ allPaths: source.allPaths })
  const extraPaths = verificationSnapshotInputPaths({ source, globalInputs })
  const scannedFiles = new Map()
  const scan = scanLocalModuleGraph({
    source,
    supplementalPaths: extraPaths,
    parseSourceFile: options.parseSourceFile ?? parseVitestProjectSource,
    projectFile(file) {
      scannedFiles.set(file.path, file)
      return verificationFileRecord(file)
    },
  })
  let graph = withVerificationModuleEdges(
    scan.graph,
    options.explicitEdges ?? VERIFICATION_EXPLICIT_MODULE_EDGES,
  )
  const paths = uniqueSorted([...graph.paths, ...extraPaths])
  const files = {}
  for (const path of paths) {
    const projection = scan.projections.get(path)
    if (!projection) throw new Error(`VerificationSnapshotProjectionMissing:${path}`)
    files[path] = projection
  }
  const unitExecution = snapshotUnitExecution(source, files, {
    graph: scan.graph,
    files: scannedFiles,
  })
  if (unitExecution.status === 'owned') {
    graph = withVerificationModuleEdges(
      graph,
      unitExecution.projects.flatMap((project) =>
        project.files.flatMap((importer) =>
          project.setupFiles.map((dependency) => ({ importer, dependency })),
        ),
      ),
    )
  }
  const dependencies = Object.fromEntries(
    [...graph.dependencies]
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, values]) => [path, [...values]]),
  )
  const snapshotWithoutDigest = {
    schemaVersion: VERIFICATION_SNAPSHOT_SCHEMA_VERSION,
    obligationSchemaVersion: VERIFICATION_OBLIGATION_SCHEMA_VERSION,
    files,
    dependencies,
    unitExecution,
    graphDiagnostics: graph.diagnostics,
  }
  return Object.freeze({
    ...snapshotWithoutDigest,
    digest: digestJson(snapshotWithoutDigest),
  })
}

function snapshotUnitExecution(source, files, moduleScan) {
  if (!loadedProjectProviderInputs) {
    const providerSource = createFilesystemLocalModuleSource({
      root: DEFAULT_ROOT,
      directories: ['scripts'],
      files: ['vitest.config.ts', 'vite.config.ts'],
    })
    const scan = scanReachableLocalModuleGraph({
      source: providerSource,
      entryPaths: VITEST_PROJECT_PROVIDER_INPUTS,
      availablePaths: providerSource.allPaths,
      projectFile: ({ path }) => sha256(providerSource.readFileBytes(path)),
    })
    if (scan.graph.diagnostics.length > 0) {
      throw new Error('VerificationUnitProjectProviderGraphUnresolved')
    }
    loadedProjectProviderInputs = Object.freeze(
      Object.fromEntries([...scan.projections].sort(([left], [right]) => compareText(left, right))),
    )
  }
  const providerInputs = loadedProjectProviderInputs
  const mismatchedPaths = Object.keys(providerInputs).filter(
    (path) => files[path]?.sha256 !== providerInputs[path],
  )
  if (mismatchedPaths.length > 0) {
    return Object.freeze({
      status: 'unavailable',
      providerInputs,
      mismatchedPaths: Object.freeze(mismatchedPaths),
    })
  }
  const projects = vitestProjects({ source, moduleScan }).map((project) =>
    Object.freeze({
      project: project.project,
      files: Object.freeze([...project.files]),
      setupFiles: Object.freeze([...project.setupFiles]),
    }),
  )
  for (const project of projects) {
    for (const path of project.setupFiles) {
      if (!files[path]) throw new Error(`VerificationUnitSetupMissing:${project.project}:${path}`)
    }
  }
  return Object.freeze({ status: 'owned', providerInputs, projects: Object.freeze(projects) })
}

function compareUnitExecution(base, current) {
  if (
    base.unitExecution.status !== 'owned' ||
    current.unitExecution.status !== 'owned' ||
    JSON.stringify(base.unitExecution.providerInputs) !==
      JSON.stringify(current.unitExecution.providerInputs)
  ) {
    return { fullRunner: true, movedFiles: [] }
  }
  const ownership = (snapshot) =>
    new Map(
      snapshot.unitExecution.projects.flatMap((project) =>
        project.files.map((path) => [
          path,
          JSON.stringify({ project: project.project, setupFiles: project.setupFiles }),
        ]),
      ),
    )
  const before = ownership(base)
  const after = ownership(current)
  return {
    fullRunner: false,
    movedFiles: [...after.keys()].filter((path) => before.get(path) !== after.get(path)),
  }
}

export function diffVerificationSnapshots(base, current) {
  validateSnapshot(base, 'base')
  validateSnapshot(current, 'current')
  const basePaths = new Set(Object.keys(base.files))
  const currentPaths = new Set(Object.keys(current.files))
  const addedPaths = difference(currentPaths, basePaths)
  const deletedPaths = difference(basePaths, currentPaths)
  const modifiedPaths = intersection(basePaths, currentPaths).filter(
    (path) =>
      base.files[path].sha256 !== current.files[path].sha256 ||
      base.files[path].executable !== current.files[path].executable,
  )
  const changedPaths = uniqueSorted([...addedPaths, ...modifiedPaths, ...deletedPaths])
  const changedSymbols = []
  for (const path of changedPaths) {
    const before = new Map((base.files[path]?.symbols ?? []).map((symbol) => [symbol.id, symbol]))
    const after = new Map((current.files[path]?.symbols ?? []).map((symbol) => [symbol.id, symbol]))
    for (const id of uniqueSorted([...before.keys(), ...after.keys()])) {
      const previous = before.get(id)
      const next = after.get(id)
      if (previous?.sha256 === next?.sha256) continue
      changedSymbols.push(
        Object.freeze({
          id,
          path,
          change: previous ? (next ? 'modified' : 'deleted') : 'added',
        }),
      )
    }
  }
  return Object.freeze({
    addedPaths: Object.freeze(addedPaths),
    modifiedPaths: Object.freeze(modifiedPaths),
    deletedPaths: Object.freeze(deletedPaths),
    changedPaths: Object.freeze(changedPaths),
    changedSymbols: Object.freeze(changedSymbols.sort(compareChangedSymbol)),
  })
}

export function planSliceVerification(options) {
  const root = options.root ?? DEFAULT_ROOT
  const base = options.base
  const current = options.current
  const impact = diffVerificationSnapshots(base, current)
  const obligations = options.obligations ?? VERIFICATION_OBLIGATIONS
  const proofs = options.proofs ?? VERIFICATION_PROOFS
  const stages = options.stages ?? VERIFICATION_STAGES
  const globalInputs = new Set(
    options.globalInputs ??
      verificationGlobalInputPaths({
        allPaths: new Set([...Object.keys(base.files), ...Object.keys(current.files)]),
      }),
  )
  const moduleInventory = options.moduleInventory ?? readModuleInventory(root)
  const manifestProblems = validateVerificationManifest({
    root,
    current,
    obligations,
    proofs,
  })
  const currentGraph = graphFromSnapshot(current)
  const baseGraph = graphFromSnapshot(base)
  const currentRoots = impact.changedPaths.filter((path) => currentGraph.paths.includes(path))
  const previousRoots = impact.changedPaths.filter((path) => baseGraph.paths.includes(path))
  const affectedPaths = uniqueSorted([
    ...reverseReachableLocalModules(currentGraph, currentRoots),
    ...reverseReachableLocalModules(baseGraph, previousRoots),
    ...impact.changedPaths,
  ])
  const affectedSet = new Set(affectedPaths)
  const changedSet = new Set(impact.changedPaths)
  const affectedGlobalInputs = [...globalInputs].filter((path) => affectedSet.has(path))
  const stageInputs = new Map(
    stages.map((stage) => [
      stage.id,
      verificationStageInputPaths(
        stage,
        new Set([...Object.keys(base.files), ...Object.keys(current.files)]),
      ),
    ]),
  )
  const impactedStageIds = new Set(
    stages
      .filter(
        (stage) =>
          affectedGlobalInputs.length > 0 ||
          (stage.impact === 'any-change' && impact.changedPaths.length > 0) ||
          stageInputs.get(stage.id).some((path) => affectedSet.has(path)),
      )
      .map((stage) => stage.id),
  )
  const unitOwnership = compareUnitExecution(base, current)
  if (unitOwnership.fullRunner && impact.changedPaths.some(isExecutableRepositoryPath)) {
    for (const stage of stages) if (stage.kind === 'vitest') impactedStageIds.add(stage.id)
  }
  const prerequisiteConsumers = new Set()
  let expanded = true
  while (expanded) {
    expanded = false
    for (const stage of stages) {
      for (const prerequisite of stage.prerequisites ?? []) {
        if (prerequisite.propagateImpact === false || !impactedStageIds.has(prerequisite.id))
          continue
        if (prerequisite.consumerModules) {
          for (const path of prerequisite.consumerModules) prerequisiteConsumers.add(path)
        } else if (!impactedStageIds.has(stage.id)) {
          impactedStageIds.add(stage.id)
          expanded = true
        }
      }
    }
  }
  const impactedRunners = new Set(
    stages.filter((stage) => impactedStageIds.has(stage.id)).map((stage) => stage.kind),
  )
  const prerequisiteConsumerTests = reverseReachableLocalModules(currentGraph, [
    ...prerequisiteConsumers,
  ])
  const affectedTestFiles = uniqueSorted([
    ...(affectedGlobalInputs.length > 0 ? Object.keys(current.files) : affectedPaths),
    ...prerequisiteConsumerTests,
    ...unitOwnership.movedFiles,
    ...Object.keys(current.files).filter((path) =>
      path.startsWith('tests/e2e/')
        ? impactedRunners.has('playwright')
        : impactedRunners.has('vitest'),
    ),
  ]).filter((path) => current.files[path] && isTestSuitePath(path))
  const impactedObligations = obligations.filter(
    (obligation) =>
      affectedGlobalInputs.length > 0 ||
      obligation.impactModules.some((path) => affectedSet.has(path)) ||
      (obligation.impactPrefixes ?? []).some((prefix) =>
        impact.changedPaths.some((path) => path.startsWith(prefix)),
      ),
  )
  const registeredImpactClosure = new Set([
    ...dependencyClosure(
      currentGraph,
      obligations.flatMap((obligation) => obligation.impactModules),
    ),
    ...dependencyClosure(
      baseGraph,
      obligations.flatMap((obligation) => obligation.impactModules),
    ),
  ])
  const registeredProofImpactClosure = new Set([
    ...dependencyClosure(currentGraph, [...proofs.flatMap(proofImpactPaths), ...affectedTestFiles]),
    ...dependencyClosure(baseGraph, [...proofs.flatMap(proofImpactPaths), ...affectedTestFiles]),
  ])
  const proofById = uniqueById(proofs)
  const affectedVitestFiles = affectedTestFiles.filter((path) => !path.startsWith('tests/e2e/'))
  const affectedBrowserFiles = affectedTestFiles.filter((path) => path.startsWith('tests/e2e/'))
  const unregisteredAffectedTests = []
  const affectedProofIds = proofs
    .filter((proof) => proofImpactPaths(proof).some((path) => affectedSet.has(path)))
    .map((proof) => proof.id)
  const selectedProofs = uniqueSorted([
    ...impactedObligations.flatMap((obligation) => obligation.proofIds),
    ...affectedProofIds,
  ]).flatMap((id) => (proofById.get(id) ? [proofById.get(id)] : []))
  const selectedVitestFiles = uniqueSorted([
    ...selectedProofs
      .filter((proof) => proof.execution.runner === 'vitest')
      .flatMap((proof) => proof.execution.files),
    ...affectedVitestFiles,
  ])
  const browserSelection = selectBrowserTasks(
    uniqueSorted([
      ...selectedProofs
        .filter((proof) => proof.execution.runner === 'playwright')
        .flatMap((proof) => proof.execution.files),
      ...affectedBrowserFiles,
    ]),
    Object.keys(current.files),
  )
  const selectedNodeProofs = selectedProofs
    .filter((proof) => proof.execution.runner === 'node')
    .map((proof) => Object.freeze({ id: proof.id, argv: proof.execution.argv }))
    .sort((left, right) => {
      const order = (id) => {
        const index = VERIFICATION_STATIC_PROOF_IDS.indexOf(id)
        return index < 0 ? VERIFICATION_STATIC_PROOF_IDS.length : index
      }
      return order(left.id) - order(right.id) || compareText(left.id, right.id)
    })
  const classifiedProduction = moduleClassificationByPath(moduleInventory)
  const changedProductionPaths = impact.changedPaths.filter((path) => path.startsWith('src/'))
  const productionDomains = new Map(
    changedProductionPaths.map((path) => {
      const owners = LOCAL_MODULE_ASSET_EXTENSIONS.includes(extname(path))
        ? uniqueSorted([
            ...reverseReachableLocalModules(currentGraph, [path]),
            ...reverseReachableLocalModules(baseGraph, [path]),
          ])
        : [path]
      return [
        path,
        uniqueSorted(owners.flatMap((owner) => classifiedProduction.get(owner)?.domain ?? [])),
      ]
    }),
  )
  const impactedDomains = uniqueSorted([...productionDomains.values()].flat())
  const structuralBlockers = [
    ...manifestProblems,
    ...browserSelection.problems,
    ...(current.unitExecution.status === 'owned'
      ? []
      : ['VerificationUnitExecutionUnowned:current']),
  ]

  for (const path of changedProductionPaths) {
    if (globalInputs.has(path)) continue
    if (!productionDomains.get(path).length && current.files[path]) {
      structuralBlockers.push(`VerificationChangedPathUnclassified:${path}`)
    }
    if (!registeredImpactClosure.has(path) && !registeredProofImpactClosure.has(path)) {
      structuralBlockers.push(`VerificationChangedPathWithoutObligation:${path}`)
    }
  }
  const recognizedChangedPaths = new Set([
    ...changedProductionPaths,
    ...impact.changedPaths.filter(isTestSuitePath),
    ...globalInputs,
    ...[...stageInputs.values()].flat(),
    ...dependencyClosure(currentGraph, [...stageInputs.values()].flat()),
    ...dependencyClosure(baseGraph, [...stageInputs.values()].flat()),
    ...dependencyClosure(currentGraph, [...globalInputs]),
    ...dependencyClosure(baseGraph, [...globalInputs]),
    ...dependencyClosure(currentGraph, affectedTestFiles),
    ...dependencyClosure(baseGraph, affectedTestFiles),
    ...obligations.flatMap((obligation) => obligation.impactModules),
    ...proofs.flatMap(proofFiles),
    ...registeredImpactClosure,
    ...registeredProofImpactClosure,
  ])
  for (const path of impact.changedPaths) {
    if (recognizedChangedPaths.has(path) || isNonExecutableDocumentation(path)) continue
    if (isExecutableRepositoryPath(path)) {
      structuralBlockers.push(`VerificationChangedPathUnclassified:${path}`)
    }
  }
  const opaqueDispositionProblems = validateOpaqueModuleDispositions(
    current.graphDiagnostics,
    options.opaqueDispositions ?? VERIFICATION_OPAQUE_MODULE_REFERENCE_DISPOSITIONS,
    current.files,
  )
  structuralBlockers.push(...opaqueDispositionProblems)
  const disposedOpaqueKeys = new Set(
    (options.opaqueDispositions ?? VERIFICATION_OPAQUE_MODULE_REFERENCE_DISPOSITIONS).map(
      (disposition) => `${disposition.path}|${disposition.code}`,
    ),
  )
  for (const diagnostic of [...base.graphDiagnostics, ...current.graphDiagnostics]) {
    if (extname(diagnostic.path) === '.css') {
      if (affectedSet.has(diagnostic.path)) {
        structuralBlockers.push(
          `VerificationImpactEdgeUnresolved:${diagnostic.path}:${diagnostic.line}:${diagnostic.code}`,
        )
      }
      continue
    }
    if (disposedOpaqueKeys.has(`${diagnostic.path}|${diagnostic.code}`)) continue
    if (affectedTestFiles.includes(diagnostic.path)) continue
    if (globalInputs.has(diagnostic.path)) continue
    if (changedSet.has(diagnostic.path) && registeredProofImpactClosure.has(diagnostic.path))
      continue
    if (affectedSet.has(diagnostic.path) || changedSet.has(diagnostic.path)) {
      structuralBlockers.push(
        `VerificationImpactEdgeUnresolved:${diagnostic.path}:${diagnostic.line}:${diagnostic.code}`,
      )
    }
  }

  const impactedGuarantees = TEST_GUARANTEE_CLAIMS.filter((claim) => {
    const evidencePaths = [...(claim.evidence ?? []), ...(claim.touchedBy ?? [])].map(
      (entry) => entry.path,
    )
    return evidencePaths.some((path) => affectedSet.has(path))
  }).map((claim) => Object.freeze({ id: claim.id, status: claim.status }))
  const openGuarantees = [
    ...impactedObligations
      .filter((obligation) => obligation.status !== 'covered')
      .map((obligation) => Object.freeze({ id: `obligation:${obligation.id}`, status: 'open' })),
    ...impactedGuarantees.filter((claim) => claim.status !== 'covered'),
    ...architectureGapsForDomains(impactedDomains),
  ]
  let tasks = Object.freeze({
    node: Object.freeze(selectedNodeProofs),
    vitest: Object.freeze(selectedVitestFiles),
    playwright: Object.freeze(browserSelection.tasks),
  })
  let executionStages = []
  try {
    executionStages = compileSliceVerificationStages(tasks, {
      catalog: stages,
      sourceFiles: Object.keys(current.files),
      stageIds: [...impactedStageIds],
      inputPaths: new Set(
        dependencyClosure(currentGraph, [
          ...selectedVitestFiles,
          ...browserSelection.tasks.flatMap((task) => task.files),
        ]),
      ),
    })
  } catch (error) {
    structuralBlockers.push(String(error instanceof Error ? error.message : error))
  }
  if (executionStages.length)
    tasks = Object.freeze({
      ...tasks,
      vitest: Object.freeze(
        uniqueSorted(executionStages.flatMap((stage) => stage.unitFiles ?? [])),
      ),
      playwright: Object.freeze(executionStages.flatMap((stage) => stage.browserTasks ?? [])),
    })
  const reportWithoutDigest = {
    schemaVersion: 2,
    baseDigest: base.digest,
    currentDigest: current.digest,
    impact,
    affectedPaths: Object.freeze(affectedPaths),
    impactedDomains: Object.freeze(impactedDomains),
    impactedObligations: Object.freeze(impactedObligations.map((obligation) => obligation.id)),
    impactedGuarantees: Object.freeze(impactedGuarantees),
    openGuarantees: Object.freeze(uniqueGuarantees(openGuarantees)),
    unregisteredAffectedTests: Object.freeze(unregisteredAffectedTests),
    tasks,
    stages: Object.freeze(executionStages),
    impactedStageIds: Object.freeze([...impactedStageIds].sort(compareText)),
    structuralBlockers: Object.freeze(uniqueSorted(structuralBlockers)),
  }
  return Object.freeze({
    ...reportWithoutDigest,
    executable: reportWithoutDigest.structuralBlockers.length === 0,
    closable:
      reportWithoutDigest.structuralBlockers.length === 0 &&
      reportWithoutDigest.openGuarantees.length === 0 &&
      reportWithoutDigest.unregisteredAffectedTests.length === 0,
    planDigest: digestJson(reportWithoutDigest),
  })
}

export function validateVerificationManifest(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const current = options.current
  const obligations = options.obligations ?? VERIFICATION_OBLIGATIONS
  const proofs = options.proofs ?? VERIFICATION_PROOFS
  const problems = []
  const proofById = uniqueById(proofs, (id) => problems.push(`VerificationProofDuplicate:${id}`))
  const obligationById = uniqueById(obligations, (id) =>
    problems.push(`VerificationObligationDuplicate:${id}`),
  )
  const referencedProofs = new Set()
  for (const obligation of obligationById.values()) {
    if (!['covered', 'open'].includes(obligation.status)) {
      problems.push(`VerificationObligationStatusInvalid:${obligation.id}`)
    }
    if (obligation.impactModules.length === 0) {
      problems.push(`VerificationObligationImpactMissing:${obligation.id}`)
    }
    for (const path of obligation.impactModules) {
      if (!current.files[path])
        problems.push(`VerificationImpactRootMissing:${obligation.id}:${path}`)
    }
    for (const proofId of obligation.proofIds) {
      referencedProofs.add(proofId)
      if (!proofById.has(proofId)) {
        problems.push(`VerificationObligationProofMissing:${obligation.id}:${proofId}`)
      }
    }
  }
  for (const proof of proofById.values()) {
    if (!referencedProofs.has(proof.id)) problems.push(`VerificationProofOrphaned:${proof.id}`)
    validateProofExecution({ proof, root, problems })
  }
  return Object.freeze(uniqueSorted(problems))
}

export function assertSafeProofExecution(proof) {
  const problems = []
  validateProofExecution({ proof, root: DEFAULT_ROOT, problems, checkFiles: false })
  if (problems.length > 0) throw new Error(problems[0])
}

function validateProofExecution({ proof, root, problems, checkFiles = true }) {
  const execution = proof.execution
  if (execution.runner === 'node') {
    const entry = execution.argv[0]
    if (!entry) {
      problems.push(`VerificationProofCommandMissing:${proof.id}`)
    } else if (!/^scripts\/.*\.mjs$/u.test(entry)) {
      problems.push(`VerificationProofNodeEntryUnsafe:${proof.id}:${entry}`)
    } else if (checkFiles && !statSync(resolve(root, entry), { throwIfNoEntry: false })?.isFile()) {
      problems.push(`VerificationProofFileMissing:${proof.id}:${entry}`)
    }
    return
  }
  if (execution.runner === 'vitest') {
    for (const path of execution.files) {
      if (!isTestSuitePath(path) || path.startsWith('tests/e2e/')) {
        problems.push(`VerificationProofKindMismatch:${proof.id}:${path}`)
      }
      if (checkFiles && !statSync(resolve(root, path), { throwIfNoEntry: false })?.isFile()) {
        problems.push(`VerificationProofFileMissing:${path}`)
      }
    }
    return
  }
  if (execution.runner === 'playwright') {
    for (const path of execution.files) {
      if (!/^tests\/e2e\/[^:]+\.spec\.ts$/u.test(path)) {
        problems.push(`VerificationBrowserSelectorUnsafe:${proof.id}:${path}`)
      }
      if (browserProjectsForFile(path).length === 0) {
        problems.push(`VerificationBrowserFileUncollected:${proof.id}:${path}`)
      }
      if (checkFiles && !statSync(resolve(root, path), { throwIfNoEntry: false })?.isFile()) {
        problems.push(`VerificationProofFileMissing:${path}`)
      }
    }
  }
}

function verificationFileRecord(file) {
  return Object.freeze({
    sha256: sha256(file.bytes),
    executable: file.executable,
    symbols: Object.freeze(discoverTopLevelSymbols(file)),
  })
}

function discoverTopLevelSymbols(file) {
  if (file.kind === 'non-code') return Object.freeze([])
  const { path, sourceFile } = file
  const source = sourceFile.text
  const symbols = [symbolRecord(path, 'module', '<module>', source)]
  for (const statement of sourceFile.statements) {
    const kind = declarationKind(statement)
    if (!kind) continue
    const names = declarationNames(statement)
    for (const name of names) {
      symbols.push(symbolRecord(path, kind, name, statement.getText(sourceFile)))
    }
  }
  return symbols.sort((left, right) => compareText(left.id, right.id))
}

function declarationKind(statement) {
  if (ts.isFunctionDeclaration(statement)) return 'function'
  if (ts.isClassDeclaration(statement)) return 'class'
  if (ts.isInterfaceDeclaration(statement)) return 'interface'
  if (ts.isTypeAliasDeclaration(statement)) return 'type'
  if (ts.isEnumDeclaration(statement)) return 'enum'
  if (ts.isVariableStatement(statement)) return 'variable'
  return null
}

function declarationNames(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      ts.isIdentifier(declaration.name) ? [declaration.name.text] : [],
    )
  }
  return statement.name && ts.isIdentifier(statement.name) ? [statement.name.text] : ['default']
}

function symbolRecord(path, kind, name, source) {
  return Object.freeze({ id: `${path}#${kind}:${name}`, kind, name, sha256: sha256(source) })
}

function graphFromSnapshot(snapshot) {
  const dependencies = new Map(
    Object.entries(snapshot.dependencies).map(([path, values]) => [
      path,
      Object.freeze([...values]),
    ]),
  )
  const reverseDependencies = new Map(Object.keys(snapshot.dependencies).map((path) => [path, []]))
  for (const [importer, importedPaths] of dependencies) {
    for (const importedPath of importedPaths) reverseDependencies.get(importedPath)?.push(importer)
  }
  for (const [path, values] of reverseDependencies) {
    reverseDependencies.set(path, Object.freeze(uniqueSorted(values)))
  }
  return Object.freeze({
    paths: Object.freeze(uniqueSorted(Object.keys(snapshot.dependencies))),
    dependencies,
    reverseDependencies,
    edgeCount: [...dependencies.values()].reduce((sum, values) => sum + values.length, 0),
    diagnostics: snapshot.graphDiagnostics,
  })
}

function withVerificationModuleEdges(graph, explicitEdges) {
  const dependencies = new Map([...graph.dependencies].map(([path, values]) => [path, [...values]]))
  const diagnostics = [...graph.diagnostics]
  for (const [path, values] of dependencies) {
    const declaration = path.replace(/\.([mc]?)js$/u, '.d.$1ts')
    if (declaration !== path && dependencies.has(declaration)) values.push(declaration)
  }
  for (const edge of explicitEdges) {
    if (!dependencies.has(edge.importer) && !dependencies.has(edge.dependency)) continue
    if (!dependencies.has(edge.importer) || !dependencies.has(edge.dependency)) {
      diagnostics.push(
        Object.freeze({
          code: 'resolved-module-outside-graph',
          path: edge.importer,
          line: 1,
          detail: `explicit edge -> ${edge.dependency}`,
        }),
      )
      continue
    }
    dependencies.get(edge.importer).push(edge.dependency)
  }
  const reverseDependencies = new Map(graph.paths.map((path) => [path, []]))
  for (const [importer, values] of dependencies) {
    const exactValues = Object.freeze(uniqueSorted(values))
    dependencies.set(importer, exactValues)
    for (const dependency of exactValues) reverseDependencies.get(dependency)?.push(importer)
  }
  for (const [path, values] of reverseDependencies) {
    reverseDependencies.set(path, Object.freeze(uniqueSorted(values)))
  }
  return Object.freeze({
    paths: graph.paths,
    dependencies,
    reverseDependencies,
    edgeCount: [...dependencies.values()].reduce((sum, values) => sum + values.length, 0),
    diagnostics: Object.freeze(diagnostics),
  })
}

export function validateOpaqueModuleDispositions(diagnostics, dispositions, files) {
  const counts = new Map()
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.path}|${diagnostic.code}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const problems = []
  for (const disposition of dispositions) {
    if (!files[disposition.path]) continue
    const actual = counts.get(`${disposition.path}|${disposition.code}`) ?? 0
    if (actual !== disposition.expectedCount) {
      problems.push(
        `VerificationOpaqueDispositionDrift:${disposition.path}:${disposition.expectedCount}:${actual}`,
      )
    }
  }
  return problems
}

function dependencyClosure(graph, roots) {
  const visited = new Set()
  const queue = [...new Set(roots)]
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]
    if (visited.has(path) || !graph.dependencies.has(path)) continue
    visited.add(path)
    for (const dependency of graph.dependencies.get(path) ?? []) {
      if (!visited.has(dependency)) queue.push(dependency)
    }
  }
  return visited
}

function readModuleInventory(root) {
  return JSON.parse(readFileSync(resolve(root, 'scripts/production-module-inventory.json'), 'utf8'))
}

function moduleClassificationByPath(inventory) {
  const byPath = new Map()
  for (const classification of inventory.classifications ?? []) {
    for (const path of classification.paths ?? []) byPath.set(path, classification)
  }
  return byPath
}

function architectureGapsForDomains(domains) {
  const domainSet = new Set(domains)
  return ARCHITECTURE_COVERAGE.filter((row) => domainSet.has(row.domain)).flatMap((row) =>
    Object.entries(row.cells)
      .filter(([, cell]) => cell.status === 'gap')
      .map(([dimension]) =>
        Object.freeze({ id: `architecture:${row.domain}:${dimension}`, status: 'gap' }),
      ),
  )
}

function proofFiles(proof) {
  return 'files' in proof.execution ? [...proof.execution.files] : []
}

function proofImpactPaths(proof) {
  if ('files' in proof.execution) return [...proof.execution.files]
  if (proof.execution.runner !== 'node') return []
  const entry = proof.execution.argv[0]
  return typeof entry === 'string' && /^scripts\/.*\.mjs$/u.test(entry) ? [entry] : []
}

function uniqueById(values, onDuplicate = () => {}) {
  const byId = new Map()
  for (const value of values) {
    if (byId.has(value.id)) onDuplicate(value.id)
    else byId.set(value.id, value)
  }
  return byId
}

function uniqueGuarantees(guarantees) {
  return [...new Map(guarantees.map((guarantee) => [guarantee.id, guarantee])).values()].sort(
    (left, right) => compareText(left.id, right.id),
  )
}

function isTestSuitePath(path) {
  return /^tests\/(?:unit|integration|live|e2e)\/.*\.(?:test|spec|setup)\.[cm]?[jt]sx?$/u.test(path)
}

function isExecutableRepositoryPath(path) {
  return (
    /^(?:src|scripts|tests|tools)\//u.test(path) || /\.(?:[cm]?[jt]sx?|json|ya?ml)$/u.test(path)
  )
}

function isNonExecutableDocumentation(path) {
  return /\.(?:md|txt)$/u.test(path) || path.startsWith('plan/')
}

function validateSnapshot(snapshot, label) {
  if (!snapshot || snapshot.schemaVersion !== VERIFICATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`VerificationSnapshotInvalid:${label}`)
  }
  const execution = snapshot.unitExecution
  if (execution?.status === 'unavailable') {
    if (!Array.isArray(execution.mismatchedPaths) || execution.mismatchedPaths.length === 0) {
      throw new Error(`VerificationUnitExecutionInvalid:${label}`)
    }
    return
  }
  if (execution?.status !== 'owned' || !Array.isArray(execution.projects)) {
    throw new Error(`VerificationUnitExecutionInvalid:${label}`)
  }
  const owners = new Set()
  const selected = []
  for (const project of execution.projects) {
    if (owners.has(project.project)) throw new Error(`VerificationUnitProjectDuplicate:${label}`)
    owners.add(project.project)
    for (const file of project.files) {
      if (!snapshot.files[file] || !isVitestSuitePath(file)) {
        throw new Error(`VerificationUnitProjectFileInvalid:${label}:${file}`)
      }
      selected.push(file)
      for (const setup of project.setupFiles) {
        if (!snapshot.files[setup] || !snapshot.dependencies[file]?.includes(setup)) {
          throw new Error(`VerificationUnitSetupEdgeMissing:${label}:${file}:${setup}`)
        }
      }
    }
  }
  if (
    JSON.stringify(selected.sort()) !==
    JSON.stringify(Object.keys(snapshot.files).filter(isVitestSuitePath).sort())
  ) {
    throw new Error(`VerificationUnitProjectPopulationMismatch:${label}`)
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digestJson(value) {
  return sha256(JSON.stringify(value))
}

function difference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort(compareText)
}

function intersection(left, right) {
  return [...left].filter((value) => right.has(value)).sort(compareText)
}

function compareChangedSymbol(left, right) {
  return compareText(left.id, right.id) || compareText(left.change, right.change)
}

function compareText(left, right) {
  return left.localeCompare(right)
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText)
}
