import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  FORBIDDEN_INTERACTION_GATES,
  INTERACTION_CAPABILITIES,
  INTERACTION_CLASSIFICATION_CLOSURE_CRITERIA,
  INTERACTION_CLASSIFICATION_EXCEPTIONS,
  INTERACTION_CLASSIFICATION_RULES,
  INTERACTION_CONTINUITY_OBLIGATIONS,
  INTERACTION_OUTCOME_CONTRACTS,
  INTERACTION_REVIEW_BASELINE,
  INTERACTION_SCANNER_LIMITATIONS,
  INTERACTION_SOURCE_CONTRACTS,
  KNOWN_INTERACTION_GATES,
} from './interaction-capability-manifest.mjs'
import { sourceFingerprint } from './source-site-identity.mjs'
import { buildTestEvidenceInventory } from './test-evidence-inventory.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const PRESENTATION_SOURCE_CONTRACT = INTERACTION_SOURCE_CONTRACTS.find(
  (contract) => contract.id === 'presentation-total-v1',
)
if (!PRESENTATION_SOURCE_CONTRACT) throw new Error('PresentationSourceContractMissing')
const PRESENTATION_INTERACTION_CONTRACT_ID = PRESENTATION_SOURCE_CONTRACT.id
const LOCAL_GATE_ATTRIBUTES = new Set(['aria-disabled', 'disabled', 'inert', 'readOnly'])
const SEMANTIC_ATTRIBUTES = new Set([
  'aria-label',
  'data-control',
  'data-role',
  'data-ui',
  'download',
  'href',
  'role',
  'target',
  'type',
])

export function buildInteractionCapabilityInventory(root = DEFAULT_ROOT) {
  const evidenceInventory = buildTestEvidenceInventory(root)
  const baseSites = evidenceInventory.interactionEvidence.sites
  const baseById = new Map(baseSites.map((site) => [site.id, site]))
  const exceptionsBySite = new Map(
    INTERACTION_CLASSIFICATION_EXCEPTIONS.map((exception) => [exception.siteId, exception]),
  )
  const paths = [...new Set(baseSites.map((site) => site.path))].sort()
  const typedSourceModel = buildTypedInteractionSourceModel(root, paths)
  const discovered = paths.flatMap((path) => discoverSourceInteractions(path, typedSourceModel))
  const classifiedSites = discovered.map((sourceSite) => {
    const base = baseById.get(sourceSite.id)
    const site = { ...base, ...sourceSite }
    const matchedRules = INTERACTION_CLASSIFICATION_RULES.filter((rule) =>
      interactionRuleMatches(rule, sourceSite.path),
    )
    const rule = matchedRules.length === 1 ? matchedRules[0] : null
    const exception = exceptionsBySite.get(sourceSite.id)
    const derived = classifyInteraction(site, rule)
    const classification = exception ? applyException(derived, exception) : derived
    const presentationProof = sourceSite.source.presentationInteraction.totalOwnership
      ? Object.freeze({
          id: `source-contract:${sourceSite.id}`,
          kind: 'source-resolved-run-lifecycle',
          contractId: PRESENTATION_INTERACTION_CONTRACT_ID,
          capabilityIds: sourceSite.source.presentationInteraction.capabilityIds,
          invocationIds: sourceSite.source.presentationInteraction.invocationIds,
        })
      : null
    const classificationGaps = buildClassificationGaps(classification, matchedRules, exception)
    const architectureGaps = buildArchitectureGaps(classification)
    return Object.freeze({
      ...base,
      source: sourceSite.source,
      semanticIdentity: classification.semanticIdentity,
      architecturalCluster: classification.architecturalCluster,
      scope: classification.scope,
      requiredCapabilities: classification.requiredCapabilities,
      effects: classification.effects,
      gates: classification.gates,
      asyncOwnership: classification.asyncOwnership,
      errorOwnership: classification.errorOwnership,
      continuityObligations: classification.continuityObligations,
      classificationDisposition: exception ? 'reviewed-exception' : 'reviewed-rule',
      reviewDisposition: Object.freeze({
        ruleIds: Object.freeze(matchedRules.map((matched) => matched.id)),
        exceptionId: exception?.id ?? null,
        exactLocator: sourceSite.id,
        rationale: exception?.rationale ?? rule?.rationale ?? 'No unique classification rule.',
      }),
      lifecycleEvidence: Object.freeze({
        status: presentationProof ? 'claimed-source-contract' : 'none',
        proofs: Object.freeze(presentationProof ? [presentationProof] : []),
        scope:
          'The total source contract begins at run invocation; it does not prove synchronous pre-entry gesture work.',
      }),
      classificationGaps: Object.freeze(classificationGaps),
      architectureGaps: Object.freeze(architectureGaps),
      reviewGaps: Object.freeze(classificationGaps),
    })
  })
  const outcomeGraph = buildInteractionOutcomeGraph(root, typedSourceModel, classifiedSites)
  const outcomesBySite = new Map(outcomeGraph.outcomes.map((outcome) => [outcome.siteId, outcome]))
  const sites = classifiedSites.map((site) => {
    const outcome = outcomesBySite.get(site.id)
    const outcomeGaps = outcome?.gapReasons ?? ['callback-graph-site-missing']
    const proofs =
      outcome && outcomeGaps.length === 0
        ? [
            Object.freeze({
              id: `generated-outcome:${site.id}`,
              contractId: outcome.contractId,
              terminalRootIds: outcome.terminalRootIds,
              carrierRootIds: outcome.carrierRootIds,
              settlementRootIds: outcome.settlementRootIds,
              deliveryPath: outcome.deliveryPath,
              graphDigest: outcomeGraph.digest,
            }),
          ]
        : []
    return Object.freeze({
      ...site,
      outcomeEvidence: Object.freeze({
        status: proofs.length > 0 ? 'claimed-exact-proof' : 'gap',
        proofs: Object.freeze(proofs),
        sourceLevelCandidates: Object.freeze([...(baseById.get(site.id)?.candidateTests ?? [])]),
        candidateDisposition:
          'Source-level candidate tests are discovery hints only and never prove this exact site.',
      }),
      outcomeGaps: Object.freeze(outcomeGaps),
    })
  })
  const siteIds = new Set(sites.map((site) => site.id))
  const missingSourceMetadata = baseSites
    .filter((site) => !siteIds.has(site.id))
    .map((site) => site.id)
    .sort()
  const extraSourceMetadata = sites
    .filter((site) => !baseById.has(site.id))
    .map((site) => site.id)
    .sort()
  const classificationGapQueue = sites
    .filter((site) => site.classificationGaps.length > 0)
    .map((site) =>
      Object.freeze({
        siteId: site.id,
        path: site.path,
        line: site.line,
        semanticIdentity: site.semanticIdentity.value,
        cluster: site.architecturalCluster,
        missing: site.classificationGaps,
      }),
    )
  const architectureGapQueue = sites
    .filter((site) => site.architectureGaps.length > 0)
    .map((site) =>
      Object.freeze({
        siteId: site.id,
        path: site.path,
        line: site.line,
        semanticIdentity: site.semanticIdentity.value,
        cluster: site.architecturalCluster,
        gaps: site.architectureGaps,
      }),
    )
  const behavioralOutcomeQueue = sites
    .filter((site) => site.outcomeGaps.length > 0)
    .map((site) =>
      Object.freeze({
        siteId: site.id,
        path: site.path,
        line: site.line,
        semanticIdentity: site.semanticIdentity.value,
        cluster: site.architecturalCluster,
        missing: site.outcomeGaps,
        candidates: site.outcomeEvidence.sourceLevelCandidates,
      }),
    )
  const digests = interactionSiteDigests(sites)
  const presentationDefinitionSha256 = presentationDefinitionDigest(typedSourceModel.definitions)
  return Object.freeze({
    schemaVersion: 5,
    generatedFrom: Object.freeze({
      exactSites: 'scripts/test-evidence-inventory.mjs#interactionEvidence.sites',
      classificationManifest: 'scripts/interaction-capability-manifest.mjs',
      sourceRoots: Object.freeze(['src/app', 'src/ui']),
    }),
    classificationDisposition:
      'Every exact site is pinned to one reviewed cluster rule and an optional explicit exception. Static classification is an obligation inventory, never behavioral outcome proof.',
    taxonomies: Object.freeze({
      capabilities: INTERACTION_CAPABILITIES,
      continuityObligations: INTERACTION_CONTINUITY_OBLIGATIONS,
      knownGates: KNOWN_INTERACTION_GATES,
      forbiddenGates: FORBIDDEN_INTERACTION_GATES,
    }),
    reviewBaseline: INTERACTION_REVIEW_BASELINE,
    classificationRules: INTERACTION_CLASSIFICATION_RULES,
    classificationExceptions: INTERACTION_CLASSIFICATION_EXCEPTIONS,
    scannerLimitations: INTERACTION_SCANNER_LIMITATIONS,
    classificationClosureCriteria: INTERACTION_CLASSIFICATION_CLOSURE_CRITERIA,
    sourceContracts: finalizeTypedSourceContracts(typedSourceModel, sites),
    outcomeContracts: INTERACTION_OUTCOME_CONTRACTS,
    outcomeGraph,
    sites: Object.freeze(sites),
    classificationGapQueue: Object.freeze(classificationGapQueue),
    architectureGapQueue: Object.freeze(architectureGapQueue),
    behavioralOutcomeQueue: Object.freeze(behavioralOutcomeQueue),
    gapQueue: Object.freeze(classificationGapQueue),
    sourceParity: Object.freeze({
      baseSiteCount: baseSites.length,
      discoveredSiteCount: sites.length,
      missingSourceMetadata: Object.freeze(missingSourceMetadata),
      extraSourceMetadata: Object.freeze(extraSourceMetadata),
      exactSiteIdSha256: digests.exactSiteIdSha256,
      sourceFactSha256: digests.sourceFactSha256,
      presentationDefinitionSha256,
      interactionOutcomeSha256: outcomeGraph.digest,
    }),
  })
}

function discoverSourceInteractions(path, typedSourceModel) {
  const sourceFile = typedSourceModel.sourceFilesByPath.get(path)
  if (!sourceFile) throw new Error(`TypedInteractionSourceMissing:${path}`)
  return inventoryInteractionSitesInAst(path, sourceFile, typedSourceModel)
}

function buildTypedInteractionSourceModel(root, interactionPaths) {
  const configPath = resolve(root, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(formatTypescriptDiagnostic(config.error))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configPath)
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatTypescriptDiagnostic).join('\n'))
  }
  const canonicalPaths = [
    PRESENTATION_SOURCE_CONTRACT.factory.path,
    PRESENTATION_SOURCE_CONTRACT.hook.path,
    PRESENTATION_SOURCE_CONTRACT.execution.path,
    'src/hooks/useConfigurationCatalog.ts',
  ]
  const rootNames = uniqueSorted([...interactionPaths, ...canonicalPaths]).map((path) =>
    resolve(root, path),
  )
  const program = ts.createProgram({ rootNames, options: parsed.options })
  const checker = program.getTypeChecker()
  const scannedPaths = new Set([...interactionPaths, ...canonicalPaths])
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => {
    const path = productionSourcePath(root, sourceFile)
    return path !== null && scannedPaths.has(path)
  })
  const defineDeclaration = requireNamedDeclaration(
    program,
    root,
    PRESENTATION_SOURCE_CONTRACT.factory.path,
    PRESENTATION_SOURCE_CONTRACT.factory.name,
    ts.isFunctionDeclaration,
  )
  const hookDeclaration = requireNamedDeclaration(
    program,
    root,
    PRESENTATION_SOURCE_CONTRACT.hook.path,
    PRESENTATION_SOURCE_CONTRACT.hook.name,
    ts.isFunctionDeclaration,
  )
  const runDeclaration = requireNamedDeclaration(
    program,
    root,
    PRESENTATION_SOURCE_CONTRACT.hook.path,
    PRESENTATION_SOURCE_CONTRACT.hook.runMember.split('.').at(-1),
    ts.isMethodSignature,
  )
  const startDeclaration = requireNamedDeclaration(
    program,
    root,
    PRESENTATION_SOURCE_CONTRACT.execution.path,
    PRESENTATION_SOURCE_CONTRACT.execution.name,
    ts.isFunctionDeclaration,
  )
  const controllerStartDeclaration = requireNamedDeclaration(
    program,
    root,
    PRESENTATION_SOURCE_CONTRACT.factory.path,
    PRESENTATION_SOURCE_CONTRACT.factory.startMember.split('.').at(-1),
    ts.isMethodDeclaration,
  )
  const totalPromiseBrandDeclaration = requireNamedDeclaration(
    program,
    root,
    PRESENTATION_SOURCE_CONTRACT.factory.path,
    'totalPresentationInteractionPromiseBrand',
    ts.isVariableDeclaration,
  )
  const totalPromiseBrandSymbol = canonicalSymbol(
    checker,
    checker.getSymbolAtLocation(totalPromiseBrandDeclaration.name),
  )
  if (
    !totalPromiseBrandSymbol ||
    (checker.getTypeAtLocation(totalPromiseBrandDeclaration.name).flags &
      ts.TypeFlags.UniqueESSymbol) ===
      0
  ) {
    throw new Error('TotalPresentationInteractionPromiseBrandInvalid')
  }
  const totalPromiseAliasDeclaration = requireNamedDeclaration(
    program,
    root,
    PRESENTATION_SOURCE_CONTRACT.factory.path,
    'TotalPresentationInteractionPromise',
    ts.isTypeAliasDeclaration,
  )
  if (
    !typeHasTotalPresentationPromiseBrand(
      checker.getTypeAtLocation(totalPromiseAliasDeclaration.name),
      checker,
      totalPromiseBrandSymbol,
    )
  ) {
    throw new Error('TotalPresentationInteractionPromiseContractInvalid')
  }
  const configurationDemandDeclarations = new Map(
    ['demandAfter', 'demandBefore'].map((name) => [
      name,
      requireNamedDeclaration(
        program,
        root,
        'src/hooks/useConfigurationCatalog.ts',
        name,
        ts.isPropertySignature,
      ),
    ]),
  )
  const definitionBySymbol = new Map()
  const handleBySymbol = new Map()
  const runAliasBySymbol = new Map()
  const definitions = []
  const hooks = []
  const invocations = []
  const aliases = []
  const directStarts = []
  const directControllerStarts = []
  const configurationDemands = []
  const problems = []

  validateTotalPromiseConstructionBoundary({
    root,
    sourceFiles: program
      .getSourceFiles()
      .filter((sourceFile) => productionSourcePath(root, sourceFile) !== null),
    checker,
    totalPromiseBrandSymbol,
    problems,
  })

  for (const sourceFile of sourceFiles) {
    const path = productionSourcePath(root, sourceFile)
    if (!path) continue
    walkSourceFile(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return
      if (!callResolvesTo(checker, node, defineDeclaration)) return
      const variable = node.parent
      const object = node.arguments[0]
      if (
        !ts.isVariableDeclaration(variable) ||
        variable.initializer !== node ||
        !ts.isIdentifier(variable.name)
      ) {
        problems.push(
          `definition:${sourceLocation(path, sourceFile, node)}: module constant required`,
        )
        return
      }
      const moduleScoped = variableDeclarationIsModuleScoped(variable)
      const constant = (variable.parent.flags & ts.NodeFlags.Const) !== 0
      const id = objectLiteralStringProperty(object, 'id')
      const concurrency = objectLiteralStringProperty(object, 'concurrency')
      const lifetime = objectLiteralStringProperty(object, 'lifetime')
      if (!moduleScoped) {
        problems.push(`definition:${path}#${variable.name.text}: must be module scoped`)
      }
      if (!constant) problems.push(`definition:${path}#${variable.name.text}: const required`)
      if (!id) problems.push(`definition:${path}#${variable.name.text}: literal id required`)
      if (!['reject', 'replace'].includes(concurrency ?? '')) {
        problems.push(
          `definition:${path}#${variable.name.text}: literal reject/replace concurrency required`,
        )
      }
      if (!['presenter', 'workspace-tab'].includes(lifetime ?? '')) {
        problems.push(
          `definition:${path}#${variable.name.text}: literal presenter/workspace-tab lifetime required`,
        )
      }
      const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(variable.name))
      if (!symbol) {
        problems.push(`definition:${path}#${variable.name.text}: symbol unresolved`)
        return
      }
      const record = {
        id: `capability:${path}#${variable.name.text}`,
        capabilityId: id ?? '<invalid>',
        concurrency: concurrency ?? '<invalid>',
        lifetime: lifetime ?? '<invalid>',
        name: variable.name.text,
        path,
        ...nodePosition(sourceFile, node),
      }
      definitions.push(record)
      definitionBySymbol.set(symbol, record)
    })
  }

  const definitionsByCapabilityId = groupBy(definitions, (definition) => definition.capabilityId)
  for (const [capabilityId, matching] of definitionsByCapabilityId) {
    if (capabilityId !== '<invalid>' && matching.length > 1) {
      problems.push(`definition:${capabilityId}: duplicate capability id (${matching.length})`)
    }
  }

  const capabilityIdsForExpression = (expression) => {
    const candidate = unwrapExpression(expression)
    if (!candidate) return []
    if (ts.isConditionalExpression(candidate)) {
      return uniqueSorted([
        ...capabilityIdsForExpression(candidate.whenTrue),
        ...capabilityIdsForExpression(candidate.whenFalse),
      ])
    }
    const symbol = canonicalSymbol(checker, symbolAtExpression(checker, candidate))
    const definition = symbol ? definitionBySymbol.get(symbol) : undefined
    return definition ? [definition.capabilityId] : []
  }

  for (const sourceFile of sourceFiles) {
    const path = productionSourcePath(root, sourceFile)
    if (!path) continue
    walkSourceFile(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !callResolvesTo(checker, node, hookDeclaration)) return
      const capabilityIds = capabilityIdsForExpression(node.arguments[0])
      const variable = node.parent
      if (!ts.isVariableDeclaration(variable) || variable.initializer !== node) {
        problems.push(`hook:${sourceLocation(path, sourceFile, node)}: named binding required`)
        return
      }
      const directName = ts.isIdentifier(variable.name) ? variable.name : null
      const directRunBinding = ts.isObjectBindingPattern(variable.name)
        ? variable.name.elements.find((element) => {
            const propertyName = element.propertyName ?? element.name
            return ts.isIdentifier(propertyName) && propertyName.text === 'run'
          })
        : undefined
      const binding =
        directName ??
        (directRunBinding && ts.isIdentifier(directRunBinding.name) ? directRunBinding.name : null)
      if (!binding) {
        problems.push(`hook:${sourceLocation(path, sourceFile, node)}: named binding required`)
        return
      }
      const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(binding))
      if (!symbol) {
        problems.push(`hook:${path}#${binding.text}: symbol unresolved`)
        return
      }
      const record = {
        id: `hook:${path}#${binding.text}:${node.getStart(sourceFile)}:${sourceFingerprint(node.getText(sourceFile))}`,
        name: binding.text,
        path,
        capabilityIds: Object.freeze(capabilityIds),
        ...nodePosition(sourceFile, node),
      }
      hooks.push(record)
      const ownership = {
        capabilityIds,
        hookIds: [record.id],
      }
      if (directName) {
        handleBySymbol.set(symbol, ownership)
      } else {
        const alias = {
          id: `alias:${path}#${binding.text}:${directRunBinding.getStart(sourceFile)}:${sourceFingerprint(directRunBinding.getText(sourceFile))}`,
          name: binding.text,
          path,
          capabilityIds: Object.freeze(capabilityIds),
          hookIds: Object.freeze(ownership.hookIds),
          ...nodePosition(sourceFile, directRunBinding),
        }
        aliases.push(alias)
        runAliasBySymbol.set(symbol, { ...ownership, aliasIds: [alias.id] })
      }
      if (capabilityIds.length === 0) {
        problems.push(`hook:${record.id}: capability definition unresolved`)
      }
    })
  }

  for (const sourceFile of sourceFiles) {
    const path = productionSourcePath(root, sourceFile)
    if (!path) continue
    walkSourceFile(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return
      if (ts.isIdentifier(node.name)) {
        const initializer = unwrapExpression(node.initializer)
        if (
          !initializer ||
          !ts.isPropertyAccessExpression(initializer) ||
          initializer.name.text !== 'run'
        ) {
          return
        }
        const handle = handleForExpression(checker, initializer.expression, handleBySymbol)
        const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node.name))
        if (handle && symbol) {
          const record = {
            id: `alias:${path}#${node.name.text}:${node.getStart(sourceFile)}:${sourceFingerprint(initializer.getText(sourceFile))}`,
            name: node.name.text,
            path,
            capabilityIds: Object.freeze(handle.capabilityIds),
            hookIds: Object.freeze(handle.hookIds),
            ...nodePosition(sourceFile, node),
          }
          aliases.push(record)
          runAliasBySymbol.set(symbol, { ...handle, aliasIds: [record.id] })
        }
        return
      }
      if (!ts.isObjectBindingPattern(node.name)) return
      const initializer = unwrapExpression(node.initializer)
      const handle = initializer
        ? handleForExpression(checker, initializer, handleBySymbol)
        : undefined
      if (!handle) return
      for (const element of node.name.elements) {
        const propertyName = element.propertyName ?? element.name
        if (!ts.isIdentifier(propertyName) || propertyName.text !== 'run') continue
        if (!ts.isIdentifier(element.name)) continue
        const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(element.name))
        if (symbol) {
          const record = {
            id: `alias:${path}#${element.name.text}:${element.getStart(sourceFile)}:${sourceFingerprint(element.getText(sourceFile))}`,
            name: element.name.text,
            path,
            capabilityIds: Object.freeze(handle.capabilityIds),
            hookIds: Object.freeze(handle.hookIds),
            ...nodePosition(sourceFile, element),
          }
          aliases.push(record)
          runAliasBySymbol.set(symbol, { ...handle, aliasIds: [record.id] })
        }
      }
    })
  }

  for (const sourceFile of sourceFiles) {
    const path = productionSourcePath(root, sourceFile)
    if (!path) continue
    walkSourceFile(sourceFile, (node) => {
      if (ts.isCallExpression(node) && callResolvesTo(checker, node, runDeclaration)) {
        const handle = invocationHandle(checker, node.expression, handleBySymbol, runAliasBySymbol)
        const semantics = interactionRunSemantics(node, checker, sourceFile)
        const record = {
          id: '',
          path,
          capabilityIds: Object.freeze(handle?.capabilityIds ?? []),
          hookIds: Object.freeze(handle?.hookIds ?? []),
          aliasIds: Object.freeze(handle?.aliasIds ?? []),
          actionRanges: Object.freeze(semantics.actionRanges),
          backgroundOwner: reactEffectOwner(node, checker, sourceFile),
          fingerprint: sourceFingerprint(node.getText(sourceFile)),
          ...nodePosition(sourceFile, node),
        }
        invocations.push(record)
        if (!handle || record.capabilityIds.length === 0 || record.hookIds.length === 0) {
          problems.push(
            `invocation:${sourceLocation(path, sourceFile, node)}: hook binding unresolved`,
          )
        }
        if (record.actionRanges.length === 0) {
          problems.push(
            `invocation:${sourceLocation(path, sourceFile, node)}: action callback unresolved`,
          )
        }
        if (semantics.asyncCommit) {
          problems.push(
            `invocation:${sourceLocation(path, sourceFile, node)}: async commit forbidden`,
          )
        }
        if (semantics.unresolvedCommit) {
          problems.push(
            `invocation:${sourceLocation(path, sourceFile, node)}: commit callback unresolved`,
          )
        }
        if (semantics.opaqueSpread) {
          problems.push(
            `invocation:${sourceLocation(path, sourceFile, node)}: spread input obscures action or commit ownership`,
          )
        }
        if (semantics.duplicateInput) {
          problems.push(
            `invocation:${sourceLocation(path, sourceFile, node)}: duplicate action or commit property`,
          )
        }
      }
      if (ts.isCallExpression(node) && callResolvesTo(checker, node, startDeclaration)) {
        const record = {
          id: `start:${path}#${sourceFingerprint(node.getText(sourceFile))}`,
          path,
          ...nodePosition(sourceFile, node),
        }
        directStarts.push(record)
        if (path !== PRESENTATION_SOURCE_CONTRACT.hook.path) {
          problems.push(`start:${sourceLocation(path, sourceFile, node)}: direct execution bypass`)
        }
      }
      if (ts.isCallExpression(node) && callResolvesTo(checker, node, controllerStartDeclaration)) {
        const record = {
          id: `controller-start:${path}#${sourceFingerprint(node.getText(sourceFile))}`,
          path,
          ...nodePosition(sourceFile, node),
        }
        directControllerStarts.push(record)
        if (path !== PRESENTATION_SOURCE_CONTRACT.execution.path) {
          problems.push(
            `controller-start:${sourceLocation(path, sourceFile, node)}: direct controller bypass`,
          )
        }
      }
      if (!ts.isPropertyAccessExpression(node)) return
      const declaration = configurationDemandDeclarations.get(node.name.text)
      if (!declaration || !symbolResolvesTo(checker, node.name, declaration)) return
      configurationDemands.push({
        id: '',
        path,
        property: node.name.text,
        fingerprint: sourceFingerprint(node.getText(sourceFile)),
        ...nodePosition(sourceFile, node),
      })
    })
  }

  assignStableFactIds(
    invocations,
    (entry) => `run:${entry.path}#${entry.capabilityIds.join('+')}:${entry.fingerprint}`,
  )
  assignStableFactIds(
    configurationDemands,
    (entry) => `configuration-demand:${entry.path}#${entry.property}:${entry.fingerprint}`,
  )

  validateInteractionReferenceClosure({
    root,
    sourceFiles,
    checker,
    handleBySymbol,
    runAliasBySymbol,
    problems,
  })

  const invocationIdsByHook = groupValues(
    invocations.flatMap((invocation) =>
      invocation.hookIds.map((hookId) => ({ key: hookId, value: invocation.id })),
    ),
  )
  for (const hook of hooks) {
    if ((invocationIdsByHook.get(hook.id)?.length ?? 0) === 0) {
      problems.push(`hook:${hook.id}: no typed run invocation`)
    }
  }
  const hookedCapabilityIds = new Set(hooks.flatMap((hook) => hook.capabilityIds))
  for (const definition of definitions) {
    if (!hookedCapabilityIds.has(definition.capabilityId)) {
      problems.push(`definition:${definition.capabilityId}: no hook binding`)
    }
  }
  if (directStarts.length !== 1) {
    problems.push(`start: canonical hook calls=${directStarts.length}; expected=1`)
  }
  if (directControllerStarts.length !== 1) {
    problems.push(
      `controller-start: canonical application calls=${directControllerStarts.length}; expected=1`,
    )
  }

  return {
    contractId: PRESENTATION_INTERACTION_CONTRACT_ID,
    root,
    program,
    checker,
    totalPromiseBrandSymbol,
    sourceFilesByPath: new Map(
      sourceFiles.map((sourceFile) => [productionSourcePath(root, sourceFile), sourceFile]),
    ),
    definitions,
    hooks,
    aliases,
    invocations,
    configurationDemands,
    directStarts,
    directControllerStarts,
    presentationInvocationsByPath: groupBy(invocations, (entry) => entry.path),
    configurationDemandsByPath: groupBy(configurationDemands, (entry) => entry.path),
    problems: uniqueSorted(problems),
  }
}

function buildInteractionOutcomeGraph(root, model, sites) {
  const checker = model.checker
  const registry = buildInteractionComponentRegistry(root, model)
  const astSites = collectInteractionAstSites(model, sites)
  const vertices = new Map()
  const edges = new Map()
  const terminals = new Map()
  const vertexGaps = new Map()
  const deferredSettlementGaps = new Map()
  const work = {
    vertexDiscoveryVisits: 0,
    edgeDiscoveryVisits: 0,
    sccVertexVisits: 0,
    sccEdgeVisits: 0,
    terminalPropagationEdgeVisits: 0,
  }

  const addVertex = (record) => {
    if (!vertices.has(record.id)) {
      vertices.set(record.id, Object.freeze(record))
      work.vertexDiscoveryVisits += 1
    }
    return record.id
  }
  const addEdge = (from, to, kind) => {
    const id = `${kind}:${from}->${to}`
    if (!edges.has(id)) {
      edges.set(id, Object.freeze({ id, from, to, kind }))
      work.edgeDiscoveryVisits += 1
    }
  }
  const addGap = (vertexId, reason) => {
    const reasons = vertexGaps.get(vertexId) ?? new Set()
    reasons.add(reason)
    vertexGaps.set(vertexId, reasons)
  }
  const addTerminal = (record) => {
    const terminal = Object.freeze(record)
    if (vertices.has(record.id)) vertices.set(record.id, terminal)
    else addVertex(terminal)
    terminals.set(record.id, terminal)
  }
  const addSlot = (component, event) => {
    const id = callbackSlotId(component, event)
    addVertex({
      id,
      kind: 'callback-slot',
      path: component.path,
      component: component.name,
      event,
      element: component.name,
      synthetic: false,
    })
    return id
  }

  for (const site of sites) {
    const astSite = astSites.get(site.id)
    addVertex({
      id: site.id,
      kind: 'interaction-site',
      path: site.path,
      component: site.source.owner,
      event: site.event,
      element: site.element,
      synthetic: false,
    })
    if (!astSite) {
      addGap(site.id, 'callback-graph-source-site-missing')
      continue
    }
    const intrinsic = site.kind === 'dom-listener' || jsxElementIsIntrinsic(site.element)
    const settlement = handlerSettlementDisposition(
      astSite.handler,
      site,
      checker,
      astSite.opening,
      model,
    )
    if (settlement.kind === 'closed') {
      const settlementId = `settlement:${site.id}`
      addTerminal({
        id: settlementId,
        kind: 'handler-settlement',
        role: 'settlement',
        path: site.path,
        component: site.source.owner,
        event: site.event,
        element: site.element,
        synthetic: true,
      })
      addEdge(site.id, settlementId, 'handler-settles')
    } else if (intrinsic) {
      addGap(site.id, settlement.reason)
    } else {
      deferredSettlementGaps.set(site.id, settlement.reason)
    }
    if (intrinsic) {
      addTerminal({
        id: site.id,
        kind: 'interaction-site',
        role: 'carrier',
        path: site.path,
        component: site.source.owner,
        event: site.event,
        element: site.element,
        synthetic: false,
      })
    } else {
      const destination = componentForJsxTag(root, astSite.opening.tagName, checker, registry)
      if (!destination) {
        addGap(site.id, 'callback-destination-component-unresolved')
      } else if (!destination.callableProps.has(site.event)) {
        addGap(site.id, 'callback-destination-prop-missing')
      } else {
        const destinationSlot = addSlot(destination, site.event)
        addEdge(site.id, destinationSlot, 'explicit-prop-forward')
      }
    }

    const owner = enclosingInteractionComponent(astSite.opening, registry)
    if (!owner || !astSite.handler) continue
    const referencedSlots = sourceSlotsForHandler(astSite.handler, owner, checker, registry)
    for (const slot of referencedSlots) {
      addSlot(slot.component, slot.event)
      addEdge(callbackSlotId(slot.component, slot.event), site.id, 'prop-invokes-site')
    }
  }

  const forwardingNodes = []
  for (const component of registry.components) {
    discoverComponentCallbackAliases(component, checker, registry, addSlot, addGap)
    walkSourceFile(component.declaration, (node) => {
      if (enclosingInteractionComponent(node, registry)?.id !== component.id) return
      if (ts.isCallExpression(node)) {
        const slot = sourceSlotForNode(node.expression, component, checker, registry)
        if (slot) {
          const sourceId = addSlot(slot.component, slot.event)
          const position = nodePosition(node.getSourceFile(), node)
          const terminalId = `terminal:${slot.component.id}:invoke:${position.start}`
          addTerminal({
            id: terminalId,
            kind: 'callback-invocation',
            role: 'carrier',
            path: slot.component.path,
            component: slot.component.name,
            event: slot.event,
            element: 'call-expression',
            synthetic: true,
          })
          addEdge(sourceId, terminalId, 'callback-invoke')
          const settlement = callbackInvocationSettlementDisposition(node, checker, root, model)
          if (settlement.kind === 'closed') {
            const settlementId = `settlement:${slot.component.id}:invoke:${position.start}`
            addTerminal({
              id: settlementId,
              kind: 'callback-settlement',
              role: 'settlement',
              path: slot.component.path,
              component: slot.component.name,
              event: slot.event,
              element: 'call-expression',
              synthetic: true,
            })
            addEdge(sourceId, settlementId, 'callback-settles')
          }
        }
      }
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
      forwardingNodes.push({ component, node })
    })
  }

  let forwardingChanged = true
  while (forwardingChanged) {
    const verticesBefore = vertices.size
    const edgesBefore = edges.size
    const terminalsBefore = terminals.size
    for (const { component, node } of forwardingNodes) {
      const destinationIntrinsic = jsxElementIsIntrinsic(node.tagName.getText(node.getSourceFile()))
      const destination = destinationIntrinsic
        ? null
        : componentForJsxTag(root, node.tagName, checker, registry)
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue
        const destinationEvent = attribute.name.getText(node.getSourceFile())
        if (/^on[A-Z]/u.test(destinationEvent)) continue
        const expression = jsxAttributeExpression(attribute)
        if (!expression) continue
        const sourceSlots = sourceSlotsForHandler(expression, component, checker, registry)
        if (sourceSlots.length === 0) continue
        for (const sourceSlot of sourceSlots) {
          const sourceId = addSlot(sourceSlot.component, sourceSlot.event)
          if (!destination || !destination.callableProps.has(destinationEvent)) {
            addGap(sourceId, 'renamed-callback-destination-unresolved')
            continue
          }
          addEdge(sourceId, addSlot(destination, destinationEvent), 'renamed-prop-forward')
        }
      }
      for (const spread of node.attributes.properties.filter(ts.isJsxSpreadAttribute)) {
        const source = spreadCallbackSource(spread.expression, component, checker, registry)
        if (source.kind === 'none') continue
        const demandedMappings = source.mappings.filter((mapping) =>
          vertices.has(callbackSlotId(mapping.source.component, mapping.source.event)),
        )
        if (source.kind === 'gap') {
          for (const mapping of demandedMappings) {
            const slotId = addSlot(mapping.source.component, mapping.source.event)
            addGap(slotId, source.reason)
          }
          continue
        }
        for (const mapping of demandedMappings) {
          const sourceSlot = mapping.source
          const destinationEvent = mapping.destinationEvent
          const sourceId = addSlot(sourceSlot.component, sourceSlot.event)
          if (spreadEventOverridden(node, spread, destinationEvent)) continue
          if (destinationIntrinsic) {
            const terminalId = `terminal:${sourceSlot.component.id}:${node.getStart()}:${node.tagName.getText(node.getSourceFile())}.${destinationEvent}`
            addTerminal({
              id: terminalId,
              kind: 'intrinsic-carrier',
              role: 'carrier',
              path: sourceSlot.component.path,
              component: sourceSlot.component.name,
              event: destinationEvent,
              element: node.tagName.getText(node.getSourceFile()),
              synthetic: true,
            })
            addEdge(sourceId, terminalId, 'typed-rest-forward')
            continue
          }
          if (!destination) {
            addGap(sourceId, 'callback-destination-component-unresolved')
            continue
          }
          if (!destination.callableProps.has(destinationEvent)) {
            addGap(sourceId, 'callback-destination-prop-missing')
            continue
          }
          const destinationId = addSlot(destination, destinationEvent)
          addEdge(sourceId, destinationId, 'typed-rest-forward')
        }
      }
    }
    forwardingChanged =
      vertices.size !== verticesBefore ||
      edges.size !== edgesBefore ||
      terminals.size !== terminalsBefore
  }

  const graph = condenseInteractionGraph(vertices, edges, terminals, vertexGaps, work)
  const contractIds = new Set(INTERACTION_OUTCOME_CONTRACTS.map((contract) => contract.id))
  const outcomes = sites.map((site) => {
    const componentId = graph.componentByVertex.get(site.id)
    const terminalRootIds = uniqueSorted(
      componentId === undefined ? [] : [...(graph.terminalIdsByComponent.get(componentId) ?? [])],
    )
    const carrierRootIds = terminalRootIds.filter(
      (terminalId) => terminals.get(terminalId)?.role === 'carrier',
    )
    const settlementRootIds = terminalRootIds.filter(
      (terminalId) => terminals.get(terminalId)?.role === 'settlement',
    )
    const graphGaps = uniqueSorted(
      componentId === undefined ? [] : [...(graph.gapReasonsByComponent.get(componentId) ?? [])],
    )
    const localGapReasons = []
    if (settlementRootIds.length === 0) {
      const deferredGap = deferredSettlementGaps.get(site.id)
      if (deferredGap && !graphGaps.includes(deferredGap)) localGapReasons.push(deferredGap)
    }
    const contractId = interactionOutcomeContractId(site)
    if (!contractId || !contractIds.has(contractId))
      throw new Error('InteractionOutcomeContractMissing')
    return Object.freeze({
      siteId: site.id,
      contractId: contractId ?? '<unresolved>',
      terminalRootIds: Object.freeze(terminalRootIds),
      carrierRootIds: Object.freeze(carrierRootIds),
      settlementRootIds: Object.freeze(settlementRootIds),
      deliveryPath: Object.freeze(firstCarrierDeliveryPath(site.id, graph.adjacency, terminals)),
      localGapReasons: Object.freeze(uniqueSorted(localGapReasons)),
      gapReasons: Object.freeze(uniqueSorted([...graphGaps, ...localGapReasons])),
    })
  })
  const serializedVertices = Object.freeze([...vertices.values()].sort(compareById))
  const serializedEdges = Object.freeze([...edges.values()].sort(compareById))
  const serializedTerminals = Object.freeze([...terminals.values()].sort(compareById))
  const serializedComponents = Object.freeze(
    graph.components.map((component, id) =>
      Object.freeze({
        id,
        vertexIds: Object.freeze([...component.vertexIds].sort()),
        cyclic: component.cyclic,
        terminalIds: Object.freeze([...(graph.terminalIdsByComponent.get(id) ?? [])].sort()),
        gapReasons: Object.freeze([...(graph.gapReasonsByComponent.get(id) ?? [])].sort()),
      }),
    ),
  )
  const digest = interactionOutcomeGraphDigest({
    schemaVersion: 2,
    vertices: serializedVertices,
    edges: serializedEdges,
    terminals: serializedTerminals,
    components: serializedComponents,
    outcomes,
    problems: registry.problems,
  })
  return Object.freeze({
    schemaVersion: 2,
    digest,
    vertices: serializedVertices,
    edges: serializedEdges,
    terminals: serializedTerminals,
    components: serializedComponents,
    outcomes: Object.freeze(outcomes),
    problems: Object.freeze(uniqueSorted(registry.problems)),
    counts: Object.freeze({
      vertices: serializedVertices.length,
      edges: serializedEdges.length,
      callbackSlots: serializedVertices.filter((entry) => entry.kind === 'callback-slot').length,
      terminals: serializedTerminals.length,
      condensedComponents: serializedComponents.length,
      condensedEdges: graph.condensedEdgeCount,
    }),
    work: Object.freeze(work),
  })
}

function buildInteractionComponentRegistry(root, model) {
  const checker = model.checker
  const byDeclaration = new Map()
  const components = []
  const problems = []
  const bindingSlots = new Map()
  const wholeProps = new Map()
  const componentOrdinals = new Map()

  const register = (declaration) => {
    const key = declarationIdentity(declaration)
    const existing = byDeclaration.get(key)
    if (existing) return existing
    const path = productionSourcePath(root, declaration.getSourceFile())
    const name = callableDeclarationName(declaration)
    if (!path || !name) return null
    const parameter = declaration.parameters?.[0]
    const props = parameter ? checker.getTypeAtLocation(parameter).getProperties() : []
    const propNames = new Set(props.map((property) => property.name))
    const callableProps = new Set(
      parameter
        ? props
            .filter((property) =>
              typeCanBeCalled(checker.getTypeOfSymbolAtLocation(property, parameter)),
            )
            .map((property) => property.name)
        : [],
    )
    const componentBase = `${path}#${name}:${sourceFingerprint(declaration.getText(declaration.getSourceFile()))}`
    const ordinal = (componentOrdinals.get(componentBase) ?? 0) + 1
    componentOrdinals.set(componentBase, ordinal)
    const component = {
      id: `component:${componentBase}:${ordinal}`,
      path,
      name,
      declaration,
      propNames,
      callableProps,
    }
    byDeclaration.set(key, component)
    components.push(component)
    if (!parameter) return component
    registerPropsBinding(parameter.name, component, new Set(), checker, bindingSlots, wholeProps)
    discoverDerivedPropsBindings(declaration, component, checker, bindingSlots, wholeProps)
    return component
  }

  for (const sourceFile of model.program.getSourceFiles()) {
    if (!productionSourcePath(root, sourceFile)) continue
    walkSourceFile(sourceFile, (node) => {
      if (!isCallableDeclaration(node)) return
      const name = callableDeclarationName(node)
      if (name && /^[A-Z]/u.test(name)) register(node)
    })
  }
  return {
    components,
    byDeclaration,
    bindingSlots,
    wholeProps,
    problems,
    register,
  }
}

function typeCanBeCalled(type) {
  if (type.getCallSignatures().length > 0) return true
  return type.isUnionOrIntersection?.() && type.types.some(typeCanBeCalled)
}

function registerPropsBinding(name, component, excluded, checker, bindingSlots, wholeProps) {
  if (ts.isIdentifier(name)) {
    const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(name))
    if (symbol) wholeProps.set(symbol, { component, excluded: new Set(excluded) })
    return
  }
  if (!ts.isObjectBindingPattern(name)) return
  const explicitlyBound = new Set(
    name.elements
      .filter((element) => !element.dotDotDotToken)
      .map((element) => propertyNameText(element.propertyName ?? element.name))
      .filter(Boolean),
  )
  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) continue
    const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(element.name))
    if (!symbol) continue
    if (element.dotDotDotToken) {
      wholeProps.set(symbol, {
        component,
        excluded: new Set([...excluded, ...explicitlyBound]),
      })
      continue
    }
    const event = propertyNameText(element.propertyName ?? element.name)
    if (event && component.callableProps.has(event)) {
      bindingSlots.set(symbol, { component, event })
    }
  }
}

function discoverDerivedPropsBindings(declaration, component, checker, bindingSlots, wholeProps) {
  let changed = true
  while (changed) {
    changed = false
    walkSourceFile(declaration, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return
      const source = wholePropsForExpression(node.initializer, checker, wholeProps)
      if (!source || source.component.id !== component.id) return
      const before = bindingSlots.size + wholeProps.size
      registerPropsBinding(node.name, component, source.excluded, checker, bindingSlots, wholeProps)
      if (bindingSlots.size + wholeProps.size > before) changed = true
    })
  }
}

function collectInteractionAstSites(model, sites) {
  const expectedPaths = new Set(sites.map((site) => site.path))
  const records = new Map()
  for (const path of expectedPaths) {
    const sourceFile = model.sourceFilesByPath.get(path)
    if (!sourceFile) continue
    const raw = []
    walkSourceFile(sourceFile, (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue
          const event = attribute.name.getText(sourceFile)
          if (!/^on[A-Z]/u.test(event)) continue
          const handler = jsxAttributeExpression(attribute)
          raw.push({
            path,
            kind: 'jsx-handler',
            event,
            element: node.tagName.getText(sourceFile),
            opening: node,
            handler,
            owner: findEnclosingOwner(node, sourceFile),
            fingerprint: sourceFingerprint(handler?.getText(sourceFile) ?? ''),
          })
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'addEventListener'
      ) {
        const event = node.arguments[0]
        if (!event || !ts.isStringLiteralLike(event)) return
        const handler = node.arguments[1]
        raw.push({
          path,
          kind: 'dom-listener',
          event: event.text,
          element: node.expression.expression.getText(sourceFile),
          opening: node,
          handler,
          owner: findEnclosingOwner(node, sourceFile),
          fingerprint: sourceFingerprint(handler?.getText(sourceFile) ?? ''),
        })
      }
    })
    const ordinals = new Map()
    for (const record of raw) {
      const base = `${record.path}#${record.owner}|${record.kind}|${record.event}|${record.element}|${record.fingerprint}`
      const ordinal = (ordinals.get(base) ?? 0) + 1
      ordinals.set(base, ordinal)
      records.set(`${base}:${ordinal}`, record)
    }
  }
  return records
}

function handlerSettlementDisposition(handler, site, checker, opening, model) {
  if (!handler) return { kind: 'gap', reason: 'handler-missing' }
  const type = checker.getTypeAtLocation(handler)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
    return { kind: 'gap', reason: 'handler-type-opaque' }
  }
  if (
    type.isUnion?.() &&
    type.types.some(
      (member) =>
        (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) !== 0,
    )
  ) {
    const absentBranchIsOwned =
      (interactionOutcomeContractId(site) === 'continuous-observer-v1' &&
        site.effects.length === 1 &&
        site.effects[0] === 'visual') ||
      ((ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening)) &&
        optionalCallbackAbsenceIsGated(handler, opening))
    if (!absentBranchIsOwned) {
      return { kind: 'gap', reason: 'conditional-callback-delivery' }
    }
    return optionalCallableMembersOwnAsyncFailures(type, checker, model.totalPromiseBrandSymbol)
      ? { kind: 'closed' }
      : { kind: 'gap', reason: 'async-error-owner-not-proven' }
  }
  if (site.source.presentationInteraction.totalOwnership) return { kind: 'closed' }
  const callableSettlement = callableReturnSettlementFacts(
    type,
    checker,
    model.totalPromiseBrandSymbol,
  )
  if (callableSettlement.onlySynchronousOrTotal && callableSettlement.hasTotal) {
    return { kind: 'closed' }
  }
  if (callableOwnsAsyncFailures(handler, checker, model.totalPromiseBrandSymbol)) {
    return { kind: 'closed' }
  }
  if (site.errorOwnership.reviewDisposition === 'reviewed-static-non-proof') {
    return { kind: 'gap', reason: 'async-error-owner-not-proven' }
  }
  const candidate = unwrapExpression(handler)
  if (
    candidate &&
    (ts.isIdentifier(candidate) ||
      ts.isPropertyAccessExpression(candidate) ||
      ts.isElementAccessExpression(candidate)) &&
    typeCanBeCalled(type) &&
    callableTypeIsSynchronous(type, checker)
  ) {
    return { kind: 'closed' }
  }
  const nodes = [
    handler,
    ...resolveHandlerNodesWithChecker(handler, checker, handler.getSourceFile()).nodes,
  ]
  let hasControlledOutcome = false
  for (const node of nodes) {
    walkSourceFile(node, (entry) => {
      if (
        ts.isCallExpression(entry) ||
        ts.isNewExpression(entry) ||
        (ts.isBinaryExpression(entry) &&
          entry.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          entry.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        (ts.isPrefixUnaryExpression(entry) &&
          (entry.operator === ts.SyntaxKind.PlusPlusToken ||
            entry.operator === ts.SyntaxKind.MinusMinusToken)) ||
        ts.isPostfixUnaryExpression(entry)
      ) {
        hasControlledOutcome = true
      }
    })
  }
  return hasControlledOutcome
    ? { kind: 'closed' }
    : { kind: 'gap', reason: 'handler-controlled-outcome-missing' }
}

function optionalCallableMembersOwnAsyncFailures(type, checker, totalPromiseBrandSymbol) {
  const members = type.isUnion?.()
    ? type.types.filter(
        (member) =>
          (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) === 0,
      )
    : [type]
  return (
    members.length > 0 &&
    members.every((member) => {
      const signatures = member.getCallSignatures()
      return (
        signatures.length > 0 &&
        signatures.every((signature) =>
          typeHasOnlySynchronousOrTotalMembers(
            checker.getReturnTypeOfSignature(signature),
            checker,
            totalPromiseBrandSymbol,
          ),
        )
      )
    })
  )
}

function optionalCallbackAbsenceIsGated(handler, opening) {
  const availability = optionalValueAvailability(handler)
  if (!availability) return false
  const sourceFile = opening.getSourceFile()
  for (const attribute of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue
    const name = attribute.name.getText(sourceFile)
    const expression = jsxAttributeExpression(attribute)
    if (!expression) continue
    if (name === 'disabled' || name === 'aria-disabled' || name === 'inert') {
      const disabled = booleanFact(expression)
      if (disabled && booleanFactsAreOpposed(availability, disabled)) return true
    }
    if (name === 'href') {
      const hrefAvailability = optionalValueAvailability(expression)
      if (hrefAvailability && booleanFactsAreEqual(availability, hrefAvailability)) return true
    }
  }
  return false
}

function optionalValueAvailability(expression) {
  const candidate = unwrapExpression(expression)
  if (!candidate || !ts.isConditionalExpression(candidate)) return null
  const trueMissing = expressionIsNullish(candidate.whenTrue)
  const falseMissing = expressionIsNullish(candidate.whenFalse)
  if (trueMissing === falseMissing) return null
  const condition = booleanFact(candidate.condition)
  if (!condition) return null
  return trueMissing ? invertBooleanFact(condition) : condition
}

function booleanFact(expression) {
  const candidate = unwrapExpression(expression)
  if (!candidate) return null
  if (
    ts.isPrefixUnaryExpression(candidate) &&
    candidate.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const operand = booleanFact(candidate.operand)
    return operand ? invertBooleanFact(operand) : null
  }
  if (
    ts.isBinaryExpression(candidate) &&
    (candidate.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    if (expressionIsNullish(candidate.right)) return booleanFact(candidate.left)
    if (expressionIsNullish(candidate.left)) return booleanFact(candidate.right)
  }
  if (
    ts.isIdentifier(candidate) ||
    ts.isPropertyAccessExpression(candidate) ||
    ts.isElementAccessExpression(candidate)
  ) {
    return { atom: candidate.getText(candidate.getSourceFile()), truthy: true }
  }
  return null
}

function expressionIsNullish(expression) {
  const candidate = unwrapExpression(expression)
  return (
    candidate !== undefined &&
    (candidate.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(candidate) && candidate.text === 'undefined'))
  )
}

function invertBooleanFact(fact) {
  return { atom: fact.atom, truthy: !fact.truthy }
}

function booleanFactsAreEqual(left, right) {
  return left.atom === right.atom && left.truthy === right.truthy
}

function booleanFactsAreOpposed(left, right) {
  return left.atom === right.atom && left.truthy !== right.truthy
}

function callableTypeIsSynchronous(type, checker) {
  if (type.isUnionOrIntersection?.()) {
    return type.types.every((member) => callableTypeIsSynchronous(member, checker))
  }
  const signatures = type.getCallSignatures()
  return (
    signatures.length > 0 &&
    signatures.every(
      (signature) => !typeIsPromiseLike(checker.getReturnTypeOfSignature(signature), checker),
    )
  )
}

function callableOwnsAsyncFailures(handler, checker, totalPromiseBrandSymbol) {
  const candidate = unwrapExpression(handler)
  if (!candidate) return false
  const implementation =
    ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)
      ? candidate
      : callableDeclarationForExpression(candidate, checker, handler.getSourceFile())
  return implementation
    ? callableImplementationOwnsAsyncFailures(
        implementation,
        checker,
        totalPromiseBrandSymbol,
        new Map(),
      )
    : false
}

function callableImplementationOwnsAsyncFailures(
  implementation,
  checker,
  totalPromiseBrandSymbol,
  states,
) {
  const key = `${implementation.getSourceFile().fileName}:${implementation.getStart()}:${implementation.getEnd()}`
  const prior = states.get(key)
  if (prior === 'closed') return true
  if (prior === 'open' || prior === 'visiting') return false
  states.set(key, 'visiting')
  let sawAsync = false
  let unowned = false
  const visit = (node) => {
    if (unowned) return
    if (node !== implementation && isCallableDeclaration(node)) return
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const resultType = checker.getTypeAtLocation(node)
      if (!typeIsPromiseLike(resultType, checker)) {
        ts.forEachChild(node, visit)
        return
      }
      sawAsync = true
      if (
        !typeHasOnlySynchronousOrTotalMembers(resultType, checker, totalPromiseBrandSymbol) &&
        !promiseResultHasRejectionOwner(node, checker) &&
        !promiseExpressionIsInfallible(node) &&
        !calledImplementationOwnsAsyncFailures(node, checker, totalPromiseBrandSymbol, states)
      ) {
        unowned = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(implementation)
  const closed = sawAsync && !unowned
  states.set(key, closed ? 'closed' : 'open')
  return closed
}

function calledImplementationOwnsAsyncFailures(call, checker, totalPromiseBrandSymbol, states) {
  const implementation = callableDeclarationForExpression(
    call.expression,
    checker,
    call.getSourceFile(),
  )
  return implementation
    ? callableImplementationOwnsAsyncFailures(
        implementation,
        checker,
        totalPromiseBrandSymbol,
        states,
      )
    : false
}

function promiseExpressionIsInfallible(expression) {
  return (
    ts.isCallExpression(expression) &&
    expression.arguments.length === 0 &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'Promise' &&
    expression.expression.name.text === 'resolve'
  )
}

function callbackInvocationSettlementDisposition(call, checker, root, model) {
  const path = productionSourcePath(root, call.getSourceFile())
  if (
    path &&
    model.invocations.some(
      (invocation) =>
        invocation.path === path &&
        invocation.actionRanges.some(
          (range) => call.getStart() >= range.start && call.getEnd() <= range.end,
        ),
    )
  ) {
    return { kind: 'closed' }
  }
  const resultType = checker.getTypeAtLocation(call)
  if (typeHasOnlySynchronousOrTotalMembers(resultType, checker, model.totalPromiseBrandSymbol)) {
    return { kind: 'closed' }
  }
  const semantics = observableAsyncTypeSemantics(resultType, checker)
  if (semantics === 'sync') return { kind: 'closed' }
  if (semantics === 'unknown') return { kind: 'gap', reason: 'callback-result-opaque' }
  return promiseResultHasRejectionOwner(call, checker) ||
    promiseResultHasHigherOrderRejectionOwner(call, checker)
    ? { kind: 'closed' }
    : { kind: 'gap', reason: 'async-error-owner-not-proven' }
}

function promiseResultHasHigherOrderRejectionOwner(call, checker) {
  let callback = call.parent
  while (callback) {
    if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) break
    if (
      ts.isFunctionDeclaration(callback) ||
      ts.isMethodDeclaration(callback) ||
      ts.isSourceFile(callback)
    ) {
      return false
    }
    callback = callback.parent
  }
  if (!callback || !ts.isCallExpression(callback.parent)) return false
  const higherOrderCall = callback.parent
  const argumentIndex = higherOrderCall.arguments.indexOf(callback)
  if (argumentIndex < 0) return false
  const implementation = callableDeclarationForExpression(
    higherOrderCall.expression,
    checker,
    higherOrderCall.getSourceFile(),
  )
  const parameter = implementation?.parameters?.[argumentIndex]
  if (!implementation || !parameter || !ts.isIdentifier(parameter.name)) return false
  const parameterSymbol = canonicalSymbol(checker, checker.getSymbolAtLocation(parameter.name))
  if (!parameterSymbol) return false
  const invocations = []
  const visit = (node) => {
    if (node !== implementation && isCallableDeclaration(node)) return
    if (ts.isCallExpression(node)) {
      const called = canonicalSymbol(checker, symbolAtExpression(checker, node.expression))
      if (called === parameterSymbol) invocations.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(implementation)
  return (
    invocations.length > 0 &&
    invocations.every(
      (invocation) =>
        promiseResultHasRejectionOwner(invocation, checker) ||
        (expressionReturnsFromCallable(invocation, implementation) &&
          promiseResultHasRejectionOwner(higherOrderCall, checker)),
    )
  )
}

function expressionReturnsFromCallable(expression, implementation) {
  let current = expression
  while (current.parent && current.parent !== implementation) {
    const parent = current.parent
    if (ts.isReturnStatement(parent)) return true
    if (ts.isArrowFunction(parent) && parent.body === current) return true
    if (isCallableDeclaration(parent)) return false
    current = parent
  }
  return false
}

function promiseResultHasRejectionOwner(expression, checker) {
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const method = expression.expression.name.text
    if (
      method === 'then' &&
      expression.arguments.length >= 2 &&
      expression.arguments
        .slice(0, 2)
        .every((argument) => promiseContinuationIsSynchronous(argument, checker))
    ) {
      return true
    }
    if (
      method === 'catch' &&
      expression.arguments.length >= 1 &&
      promiseContinuationIsSynchronous(expression.arguments[0], checker)
    ) {
      return true
    }
  }
  let current = expression
  while (current.parent) {
    const parent = current.parent
    if (ts.isVoidExpression(parent)) return false
    if (ts.isAwaitExpression(parent)) {
      return awaitExpressionHasCatch(parent)
    }
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      expressionContainsNode(parent.expression.expression, expression)
    ) {
      if (
        parent.expression.name.text === 'catch' &&
        parent.arguments.length >= 1 &&
        promiseContinuationIsSynchronous(parent.arguments[0], checker)
      ) {
        return true
      }
      if (
        parent.expression.name.text === 'then' &&
        parent.arguments.length >= 2 &&
        parent.arguments
          .slice(0, 2)
          .every((argument) => promiseContinuationIsSynchronous(argument, checker))
      ) {
        return true
      }
    }
    if (
      ts.isArrowFunction(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isMethodDeclaration(parent)
    ) {
      return false
    }
    current = parent
  }
  return false
}

function promiseContinuationIsSynchronous(expression, checker) {
  const candidate = unwrapExpression(expression)
  if (!candidate) return false
  const type = checker.getTypeAtLocation(candidate)
  if (!callableTypeIsSynchronous(type, checker)) return false
  let throws = false
  walkSourceFile(candidate, (node) => {
    if (ts.isThrowStatement(node)) throws = true
  })
  return !throws
}

function awaitExpressionHasCatch(awaitExpression) {
  let current = awaitExpression.parent
  while (current) {
    if (ts.isTryStatement(current)) {
      return (
        current.catchClause !== undefined &&
        catchClauseSettles(current.catchClause) &&
        awaitExpression.getStart() >= current.tryBlock.getStart() &&
        awaitExpression.getEnd() <= current.tryBlock.getEnd()
      )
    }
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current)
    ) {
      return false
    }
    current = current.parent
  }
  return false
}

function catchClauseSettles(catchClause) {
  let rethrows = false
  const visit = (node) => {
    if (rethrows) return
    if (node !== catchClause && isCallableDeclaration(node)) return
    if (ts.isThrowStatement(node)) {
      rethrows = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(catchClause)
  return !rethrows
}

function expressionContainsNode(container, target) {
  return target.getStart() >= container.getStart() && target.getEnd() <= container.getEnd()
}

function sourceSlotsForHandler(handler, component, checker, registry) {
  const nodes = [handler]
  const candidate = unwrapExpression(handler)
  const declaration = candidate
    ? callableDeclarationForExpression(candidate, checker, handler.getSourceFile())
    : null
  if (declaration) nodes.push(declaration)
  const seen = new Set()
  const slots = new Map()
  while (nodes.length > 0) {
    const node = nodes.shift()
    const key = `${node.getSourceFile().fileName}:${node.getStart()}:${node.getEnd()}`
    if (seen.has(key)) continue
    seen.add(key)
    const direct = sourceSlotForNode(node, component, checker, registry)
    if (direct) slots.set(callbackSlotId(direct.component, direct.event), direct)
    walkSourceFile(node, (candidate) => {
      if (!ts.isCallExpression(candidate) && !ts.isNewExpression(candidate)) return
      const slot = sourceSlotForNode(candidate.expression, component, checker, registry)
      if (slot) slots.set(callbackSlotId(slot.component, slot.event), slot)
      const declaration = callableDeclarationForExpression(
        candidate.expression,
        checker,
        candidate.getSourceFile(),
      )
      if (declaration) nodes.push(declaration)
    })
  }
  return [...slots.values()]
}

function sourceSlotForNode(node, component, checker, registry) {
  const candidate = unwrapExpression(node)
  if (!candidate) return null
  if (ts.isIdentifier(candidate)) {
    const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(candidate))
    const slot = symbol ? registry.bindingSlots.get(symbol) : undefined
    return slot?.component.id === component.id ? slot : null
  }
  if (!ts.isPropertyAccessExpression(candidate)) return null
  const whole = wholePropsForExpression(candidate.expression, checker, registry.wholeProps)
  if (!whole || whole.component.id !== component.id || whole.excluded.has(candidate.name.text))
    return null
  return whole.component.callableProps.has(candidate.name.text)
    ? { component: whole.component, event: candidate.name.text }
    : null
}

function spreadCallbackSource(expression, component, checker, registry) {
  const candidate = unwrapExpression(expression)
  if (!candidate) return { kind: 'none', mappings: [] }
  if (ts.isConditionalExpression(candidate)) {
    const whenTrue = spreadCallbackSource(candidate.whenTrue, component, checker, registry)
    const whenFalse = spreadCallbackSource(candidate.whenFalse, component, checker, registry)
    const mappings = uniqueCallbackMappings([...whenTrue.mappings, ...whenFalse.mappings])
    if (whenTrue.kind === 'gap' || whenFalse.kind === 'gap') {
      return { kind: 'gap', reason: 'conditional-callback-delivery', mappings }
    }
    const trueKeys = callbackMappingKeys(whenTrue.mappings)
    const falseKeys = callbackMappingKeys(whenFalse.mappings)
    if (sameStringSet(trueKeys, falseKeys)) return { kind: 'mappings', mappings }
    const guarded = sourceSlotsReferencedInExpression(
      candidate.condition,
      component,
      checker,
      registry,
    )
    const guardedIds = new Set(guarded.map((slot) => callbackSlotId(slot.component, slot.event)))
    const nonempty = whenTrue.mappings.length > 0 ? whenTrue : whenFalse
    const empty = nonempty === whenTrue ? whenFalse : whenTrue
    if (
      empty.mappings.length === 0 &&
      nonempty.mappings.every((mapping) =>
        guardedIds.has(callbackSlotId(mapping.source.component, mapping.source.event)),
      )
    ) {
      return { kind: 'mappings', mappings }
    }
    return { kind: 'gap', reason: 'conditional-callback-delivery', mappings }
  }
  if (ts.isObjectLiteralExpression(candidate)) {
    const mappings = []
    for (const property of candidate.properties) {
      if (ts.isSpreadAssignment(property)) {
        const nested = spreadCallbackSource(property.expression, component, checker, registry)
        if (nested.kind === 'gap') return nested
        mappings.push(...nested.mappings)
        continue
      }
      const destinationEvent = propertyNameText(property.name)
      if (!destinationEvent) continue
      const value = ts.isShorthandPropertyAssignment(property)
        ? property.name
        : ts.isPropertyAssignment(property)
          ? property.initializer
          : ts.isMethodDeclaration(property)
            ? property
            : null
      if (!value) continue
      for (const source of sourceSlotsForHandler(value, component, checker, registry)) {
        mappings.push({ source, destinationEvent })
      }
    }
    return mappings.length === 0
      ? { kind: 'none', mappings: [] }
      : { kind: 'mappings', mappings: uniqueCallbackMappings(mappings) }
  }
  const whole = wholePropsForExpression(expression, checker, registry.wholeProps)
  if (whole && whole.component.id === component.id) {
    return {
      kind: 'mappings',
      mappings: callbackEventsForComponent(whole.component)
        .filter((event) => !whole.excluded.has(event))
        .map((event) => ({
          source: { component: whole.component, event },
          destinationEvent: event,
        })),
    }
  }
  const type = checker.getTypeAtLocation(expression)
  const callbackNames = type
    .getProperties()
    .map((property) => property.name)
    .filter((name) => /^on[A-Z]/u.test(name))
  const slots = sourceSlotsForHandler(expression, component, checker, registry)
  const mappings = slots.map((source) => ({ source, destinationEvent: source.event }))
  if (callbackNames.length === 0 && slots.length === 0) return { kind: 'none', mappings: [] }
  const anyLike = (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  return {
    kind: 'gap',
    reason: anyLike ? 'any-callback-spread' : 'opaque-callback-spread',
    mappings,
  }
}

function sourceSlotsReferencedInExpression(expression, component, checker, registry) {
  const slots = new Map()
  walkSourceFile(expression, (node) => {
    const slot = sourceSlotForNode(node, component, checker, registry)
    if (slot) slots.set(callbackSlotId(slot.component, slot.event), slot)
  })
  return [...slots.values()]
}

function uniqueCallbackMappings(mappings) {
  return [
    ...new Map(
      mappings.map((mapping) => [
        `${callbackSlotId(mapping.source.component, mapping.source.event)}->${mapping.destinationEvent}`,
        mapping,
      ]),
    ).values(),
  ]
}

function callbackMappingKeys(mappings) {
  return uniqueCallbackMappings(mappings)
    .map(
      (mapping) =>
        `${callbackSlotId(mapping.source.component, mapping.source.event)}->${mapping.destinationEvent}`,
    )
    .sort()
}

function spreadEventOverridden(opening, spread, event) {
  const attributes = opening.attributes.properties
  const index = attributes.indexOf(spread)
  return attributes
    .slice(index + 1)
    .some(
      (attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(opening.getSourceFile()) === event,
    )
}

function discoverComponentCallbackAliases(component, checker, registry, addSlot, addGap) {
  const handlerSymbols = new Set()
  walkSourceFile(component.declaration, (node) => {
    if (!ts.isJsxAttribute(node) || !/^on[A-Z]/u.test(node.name.getText(node.getSourceFile()))) {
      return
    }
    const expression = jsxAttributeExpression(node)
    const candidate = unwrapExpression(expression)
    const symbol = candidate
      ? canonicalSymbol(checker, symbolAtExpression(checker, candidate))
      : null
    if (symbol) handlerSymbols.add(symbol)
  })
  walkSourceFile(component.declaration, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (!ts.isPropertyAccessExpression(node.left) && !ts.isElementAccessExpression(node.left)) {
        return
      }
      for (const slot of sourceSlotsForHandler(node.right, component, checker, registry)) {
        addGap(addSlot(slot.component, slot.event), 'runtime-callback-storage')
      }
      return
    }
    if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isIdentifier(node.name)) return
    const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node.name))
    if (!symbol || !handlerSymbols.has(symbol)) return
    const initializer = unwrapExpression(node.initializer)
    if (!initializer || !ts.isCallExpression(initializer)) return
    const leaf = initializer.expression.getText(node.getSourceFile()).split('.').at(-1)
    if (leaf === 'useCallback' || leaf === 'useMemo') return
    for (const slot of sourceSlotsForHandler(initializer, component, checker, registry)) {
      addGap(addSlot(slot.component, slot.event), 'callback-alias-unresolved')
    }
  })
}

function condenseInteractionGraph(vertices, edges, terminals, vertexGaps, work) {
  const adjacency = new Map([...vertices.keys()].map((id) => [id, []]))
  const reverseAdjacency = new Map([...vertices.keys()].map((id) => [id, []]))
  for (const edge of edges.values()) {
    adjacency.get(edge.from)?.push(edge.to)
    reverseAdjacency.get(edge.to)?.push(edge.from)
  }
  for (const values of adjacency.values()) values.sort()
  for (const values of reverseAdjacency.values()) values.sort()
  const visited = new Set()
  const finishOrder = []
  for (const start of [...vertices.keys()].sort()) {
    if (visited.has(start)) continue
    visited.add(start)
    work.sccVertexVisits += 1
    const stack = [{ vertex: start, next: 0 }]
    while (stack.length > 0) {
      const frame = stack.at(-1)
      const targets = adjacency.get(frame.vertex) ?? []
      if (frame.next < targets.length) {
        const target = targets[frame.next]
        frame.next += 1
        work.sccEdgeVisits += 1
        if (visited.has(target)) continue
        visited.add(target)
        work.sccVertexVisits += 1
        stack.push({ vertex: target, next: 0 })
        continue
      }
      finishOrder.push(frame.vertex)
      stack.pop()
    }
  }
  const assigned = new Set()
  const components = []
  for (const start of finishOrder.reverse()) {
    if (assigned.has(start)) continue
    assigned.add(start)
    const vertexIds = []
    const stack = [start]
    while (stack.length > 0) {
      const vertex = stack.pop()
      vertexIds.push(vertex)
      for (const target of reverseAdjacency.get(vertex) ?? []) {
        if (assigned.has(target)) continue
        assigned.add(target)
        stack.push(target)
      }
    }
    vertexIds.sort()
    components.push({
      vertexIds: new Set(vertexIds),
      cyclic:
        vertexIds.length > 1 ||
        vertexIds.some((member) => (adjacency.get(member) ?? []).includes(member)),
    })
  }
  const componentByVertex = new Map()
  components.forEach((component, id) => {
    for (const vertex of component.vertexIds) componentByVertex.set(vertex, id)
  })
  const outgoing = new Map(components.map((_component, id) => [id, new Set()]))
  for (const edge of edges.values()) {
    const from = componentByVertex.get(edge.from)
    const to = componentByVertex.get(edge.to)
    if (from !== undefined && to !== undefined && from !== to) outgoing.get(from).add(to)
  }
  const ownTerminals = new Map(components.map((_component, id) => [id, new Set()]))
  const ownGaps = new Map(components.map((_component, id) => [id, new Set()]))
  for (const terminal of terminals.keys())
    ownTerminals.get(componentByVertex.get(terminal))?.add(terminal)
  for (const [vertex, gaps] of vertexGaps) {
    const id = componentByVertex.get(vertex)
    if (id === undefined) continue
    for (const gap of gaps) ownGaps.get(id).add(gap)
  }
  for (let id = 0; id < components.length; id += 1) {
    if (ownTerminals.get(id).size > 0 || outgoing.get(id).size > 0) continue
    ownGaps
      .get(id)
      .add(components[id].cyclic ? 'callback-cycle-without-terminal' : 'callback-terminal-missing')
  }
  const indegree = new Map(components.map((_component, id) => [id, 0]))
  for (const targets of outgoing.values()) {
    for (const target of targets) indegree.set(target, indegree.get(target) + 1)
  }
  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort((left, right) => left - right)
  const topological = []
  for (let index = 0; index < ready.length; index += 1) {
    const id = ready[index]
    topological.push(id)
    for (const target of [...outgoing.get(id)].sort((left, right) => left - right)) {
      const degree = indegree.get(target) - 1
      indegree.set(target, degree)
      if (degree === 0) ready.push(target)
    }
  }
  const terminalIdsByComponent = new Map()
  const gapReasonsByComponent = new Map()
  for (const id of topological.reverse()) {
    const resolvedTerminals = new Set(ownTerminals.get(id))
    const resolvedGaps = new Set(ownGaps.get(id))
    for (const target of [...outgoing.get(id)].sort((left, right) => left - right)) {
      work.terminalPropagationEdgeVisits += 1
      for (const terminal of terminalIdsByComponent.get(target) ?? []) {
        resolvedTerminals.add(terminal)
      }
      for (const gap of gapReasonsByComponent.get(target) ?? []) resolvedGaps.add(gap)
    }
    if (
      components[id].cyclic &&
      ![...resolvedTerminals].some((terminalId) => terminals.get(terminalId)?.role === 'carrier')
    ) {
      resolvedGaps.add('callback-cycle-without-terminal')
    }
    terminalIdsByComponent.set(id, resolvedTerminals)
    gapReasonsByComponent.set(id, resolvedGaps)
  }
  for (let id = 0; id < components.length; id += 1) {
    const resolvedTerminals = terminalIdsByComponent.get(id) ?? new Set()
    const resolvedGaps = gapReasonsByComponent.get(id) ?? new Set()
    if (
      ![...resolvedTerminals].some((terminalId) => terminals.get(terminalId)?.role === 'carrier') &&
      !resolvedGaps.has('callback-cycle-without-terminal')
    ) {
      resolvedGaps.add('callback-terminal-missing')
    }
    if (
      ![...resolvedTerminals].some((terminalId) => terminals.get(terminalId)?.role === 'settlement')
    ) {
      resolvedGaps.add('outcome-settlement-missing')
    }
    gapReasonsByComponent.set(id, resolvedGaps)
  }
  return {
    adjacency,
    components,
    componentByVertex,
    terminalIdsByComponent,
    gapReasonsByComponent,
    condensedEdgeCount: [...outgoing.values()].reduce((sum, targets) => sum + targets.size, 0),
  }
}

function firstCarrierDeliveryPath(start, adjacency, terminals) {
  const queue = [[start]]
  const seen = new Set([start])
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index]
    const current = path.at(-1)
    if (terminals.get(current)?.role === 'carrier') return path
    for (const target of adjacency.get(current) ?? []) {
      if (seen.has(target)) continue
      seen.add(target)
      queue.push([...path, target])
    }
  }
  return [start]
}

function interactionOutcomeContractId(site) {
  if (site.source.presentationInteraction.totalOwnership) return 'presentation-total-v1'
  if (site.effects.includes('browser-io')) return 'browser-default-io-v1'
  if (site.effects.includes('navigation')) return 'route-navigation-v1'
  if (
    site.kind === 'dom-listener' ||
    /scroll|wheel|pointer|mouse|touch|focus|blur|resize|selectionchange/u.test(
      site.event.toLowerCase(),
    )
  ) {
    return 'continuous-observer-v1'
  }
  return 'synchronous-controlled-v1'
}

export function interactionOutcomeGraphDigest(graph) {
  return sha256(
    JSON.stringify({
      schemaVersion: graph.schemaVersion ?? 1,
      contracts: [...INTERACTION_OUTCOME_CONTRACTS].sort(compareById),
      vertices: [...graph.vertices].sort(compareById),
      edges: [...graph.edges].sort(compareById),
      terminals: [...graph.terminals].sort(compareById),
      components: [...graph.components]
        .map((component) => ({
          vertexIds: [...component.vertexIds].sort(),
          cyclic: component.cyclic,
          terminalIds: [...component.terminalIds].sort(),
          gapReasons: [...component.gapReasons].sort(),
        }))
        .sort((left, right) => left.vertexIds.join('\n').localeCompare(right.vertexIds.join('\n'))),
      outcomes: [...graph.outcomes]
        .map((outcome) => ({
          siteId: outcome.siteId,
          contractId: outcome.contractId,
          terminalRootIds: [...outcome.terminalRootIds].sort(),
          carrierRootIds: [...outcome.carrierRootIds].sort(),
          settlementRootIds: [...outcome.settlementRootIds].sort(),
          deliveryPath: outcome.deliveryPath,
          gapReasons: [...outcome.gapReasons].sort(),
        }))
        .sort((left, right) => left.siteId.localeCompare(right.siteId)),
      problems: [...(graph.problems ?? [])].sort(),
    }),
  )
}

function callbackEventsForComponent(component) {
  return [...component.propNames].filter((name) => /^on[A-Z]/u.test(name)).sort()
}

function callbackSlotId(component, event) {
  return `slot:${component.id}.${event}`
}

function componentForJsxTag(root, tag, checker, registry) {
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(tag))
  for (const declaration of symbol?.declarations ?? []) {
    const callable = componentCallableFromDeclaration(declaration)
    if (!callable) continue
    const registered = registry.register(callable)
    if (registered) return registered
  }
  const pendingTypes = [checker.getTypeAtLocation(tag)]
  const seenTypes = new Set()
  while (pendingTypes.length > 0) {
    const type = pendingTypes.shift()
    if (!type || seenTypes.has(type)) continue
    seenTypes.add(type)
    for (const typeSymbol of [type.symbol, type.aliasSymbol]) {
      for (const declaration of typeSymbol?.declarations ?? []) {
        const callable = componentCallableFromDeclaration(declaration)
        if (!callable) continue
        const registered = registry.register(callable)
        if (registered) return registered
      }
    }
    if (type.isUnionOrIntersection?.()) pendingTypes.push(...type.types)
    for (const propertyName of ['type', '_result']) {
      const property = type.getProperty?.(propertyName)
      if (property) pendingTypes.push(checker.getTypeOfSymbolAtLocation(property, tag))
    }
    if ((type.objectFlags & ts.ObjectFlags.Reference) !== 0) {
      pendingTypes.push(...checker.getTypeArguments(type))
    }
  }
  return null
}

function componentCallableFromDeclaration(declaration) {
  if (isCallableDeclaration(declaration)) return declaration
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return null
  return callableFromComponentInitializer(declaration.initializer)
}

function callableFromComponentInitializer(initializer) {
  const candidate = unwrapExpression(initializer)
  if (!candidate) return null
  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) return candidate
  if (!ts.isCallExpression(candidate)) return null
  const callee = unwrapExpression(candidate.expression)
  const leaf = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ''
  if (leaf !== 'memo' && leaf !== 'forwardRef') return null
  for (const argument of candidate.arguments) {
    const callable = callableFromComponentInitializer(argument)
    if (callable) return callable
  }
  return null
}

function enclosingInteractionComponent(node, registry) {
  let current = node
  while (current) {
    if (isCallableDeclaration(current)) {
      const component = registry.byDeclaration.get(declarationIdentity(current))
      if (component) return component
    }
    current = current.parent
  }
  return null
}

function isCallableDeclaration(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  )
}

function callableDeclarationName(declaration) {
  if (declaration.name && ts.isIdentifier(declaration.name)) return declaration.name.text
  let current = declaration.parent
  while (current) {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    if (isCallableDeclaration(current)) return null
    current = current.parent
  }
  return null
}

function declarationIdentity(declaration) {
  return `${declaration.getSourceFile().fileName}:${declaration.getStart()}:${declaration.getEnd()}`
}

function wholePropsForExpression(expression, checker, wholeProps) {
  const candidate = unwrapExpression(expression)
  if (!candidate) return null
  const symbol = canonicalSymbol(checker, symbolAtExpression(checker, candidate))
  return symbol ? (wholeProps.get(symbol) ?? null) : null
}

function jsxElementIsIntrinsic(element) {
  return /^[a-z]/u.test(element) || element.includes('-')
}

function compareById(left, right) {
  return left.id.localeCompare(right.id)
}

function validateInteractionReferenceClosure({
  root,
  sourceFiles,
  checker,
  handleBySymbol,
  runAliasBySymbol,
  problems,
}) {
  for (const sourceFile of sourceFiles) {
    const path = productionSourcePath(root, sourceFile)
    if (!path) continue
    walkSourceFile(sourceFile, (node) => {
      if (!ts.isIdentifier(node)) return
      const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node))
      if (!symbol) return
      if (handleBySymbol.has(symbol)) {
        if (identifierIsDeclarationName(node)) return
        const parent = node.parent
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          (parent.name.text === 'run' || parent.name.text === 'isPending')
        ) {
          if (interactionMemberReferenceIsOwned(parent)) return
        }
        if (
          ts.isVariableDeclaration(parent) &&
          parent.initializer === node &&
          ts.isObjectBindingPattern(parent.name) &&
          parent.name.elements.every((element) => {
            const name = element.propertyName ?? element.name
            return ts.isIdentifier(name) && name.text === 'run'
          })
        ) {
          return
        }
        problems.push(
          `hook-reference:${sourceLocation(path, sourceFile, node)}: interaction handle escapes the typed run/isPending boundary`,
        )
        return
      }
      if (!runAliasBySymbol.has(symbol) || identifierIsDeclarationName(node)) return
      const parent = node.parent
      if (ts.isCallExpression(parent) && parent.expression === node) return
      if (aliasIsOwnedReactDependency(node, symbol, checker)) return
      problems.push(
        `alias-reference:${sourceLocation(path, sourceFile, node)}: run alias escapes direct invocation`,
      )
    })
  }
}

function aliasIsOwnedReactDependency(identifier, aliasSymbol, checker) {
  const dependencies = identifier.parent
  if (!ts.isArrayLiteralExpression(dependencies)) return false
  const call = dependencies.parent
  if (
    !ts.isCallExpression(call) ||
    call.arguments[1] !== dependencies ||
    !reactHookCall(
      call,
      checker,
      new Set(['useCallback', 'useEffect', 'useLayoutEffect', 'useMemo']),
    )
  ) {
    return false
  }
  const callback = call.arguments[0]
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return false
  }
  return collectCallExpressions(callback).some((expression) => {
    const candidate = unwrapExpression(expression)
    if (!candidate || !ts.isIdentifier(candidate)) return false
    return canonicalSymbol(checker, checker.getSymbolAtLocation(candidate)) === aliasSymbol
  })
}

function reactHookCall(call, checker, allowedNames) {
  const declaration = checker.getResolvedSignature(call)?.declaration
  const name = declaration?.name?.getText(declaration.getSourceFile()) ?? ''
  const path = declaration?.getSourceFile().fileName.replaceAll('\\', '/') ?? ''
  return allowedNames.has(name) && path.includes('/node_modules/@types/react/')
}

function interactionMemberReferenceIsOwned(access) {
  const parent = access.parent
  if (ts.isCallExpression(parent) && parent.expression === access) return true
  return (
    access.name.text === 'run' &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === access &&
    ts.isIdentifier(parent.name)
  )
}

function identifierIsDeclarationName(identifier) {
  const parent = identifier.parent
  return (
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier)
  )
}

function finalizeTypedSourceContracts(model, sites) {
  const siteIdsByInvocation = groupValues(
    sites.flatMap((site) =>
      site.source.presentationInteraction.invocationIds.map((invocationId) => ({
        key: invocationId,
        value: site.id,
      })),
    ),
  )
  const invocationIdsByHook = groupValues(
    model.invocations.flatMap((invocation) =>
      invocation.hookIds.map((hookId) => ({ key: hookId, value: invocation.id })),
    ),
  )
  const hookIdsByCapability = groupValues(
    model.hooks.flatMap((hook) =>
      hook.capabilityIds.map((capabilityId) => ({ key: capabilityId, value: hook.id })),
    ),
  )
  const invocationIdsByAlias = groupValues(
    model.invocations.flatMap((invocation) =>
      invocation.aliasIds.map((aliasId) => ({ key: aliasId, value: invocation.id })),
    ),
  )
  const siteIdsByConfigurationDemand = groupValues(
    sites.flatMap((site) =>
      site.source.configurationDemands.map((demand) => ({ key: demand.id, value: site.id })),
    ),
  )
  return Object.freeze({
    contractId: model.contractId,
    manifest: INTERACTION_SOURCE_CONTRACTS,
    definitions: Object.freeze(
      model.definitions.map((definition) =>
        Object.freeze({
          ...definition,
          hookIds: Object.freeze(
            uniqueSorted(hookIdsByCapability.get(definition.capabilityId) ?? []),
          ),
        }),
      ),
    ),
    hooks: Object.freeze(
      model.hooks.map((hook) =>
        Object.freeze({
          ...hook,
          invocationIds: Object.freeze(uniqueSorted(invocationIdsByHook.get(hook.id) ?? [])),
        }),
      ),
    ),
    aliases: Object.freeze(
      model.aliases.map((alias) =>
        Object.freeze({
          ...alias,
          invocationIds: Object.freeze(uniqueSorted(invocationIdsByAlias.get(alias.id) ?? [])),
        }),
      ),
    ),
    invocations: Object.freeze(
      model.invocations.map((invocation) =>
        Object.freeze({
          ...invocation,
          siteIds: Object.freeze(uniqueSorted(siteIdsByInvocation.get(invocation.id) ?? [])),
          surface:
            (siteIdsByInvocation.get(invocation.id)?.length ?? 0) > 0
              ? 'interaction-site'
              : invocation.backgroundOwner?.kind === 'react-effect'
                ? 'react-effect'
                : 'unowned-non-gesture',
        }),
      ),
    ),
    configurationDemands: Object.freeze(
      model.configurationDemands.map((entry) =>
        Object.freeze({
          ...entry,
          siteIds: Object.freeze(uniqueSorted(siteIdsByConfigurationDemand.get(entry.id) ?? [])),
        }),
      ),
    ),
    directStarts: Object.freeze(model.directStarts.map((entry) => Object.freeze(entry))),
    directControllerStarts: Object.freeze(
      model.directControllerStarts.map((entry) => Object.freeze(entry)),
    ),
    problems: Object.freeze(model.problems),
  })
}

function sourceFactsInRanges(facts = [], ranges = []) {
  const matched = new Map()
  for (const fact of facts) {
    if (ranges.some((range) => fact.start >= range.start && fact.end <= range.end)) {
      matched.set(fact.id, fact)
    }
  }
  return [...matched.values()]
}

function productionSourcePath(root, sourceFile) {
  if (sourceFile.isDeclarationFile) return null
  const path = relative(root, sourceFile.fileName).replaceAll('\\', '/')
  return path.startsWith('src/') ? path : null
}

function requireNamedDeclaration(program, root, expectedPath, name, predicate) {
  const matches = []
  for (const sourceFile of program.getSourceFiles()) {
    if (productionSourcePath(root, sourceFile) !== expectedPath) continue
    walkSourceFile(sourceFile, (node) => {
      if (!predicate(node) || !node.name || node.name.getText(sourceFile) !== name) return
      matches.push(node)
    })
  }
  if (matches.length === 1) return matches[0]
  const implementations = matches.filter((match) => 'body' in match && match.body)
  if (implementations.length === 1) return implementations[0]
  throw new Error(`TypedInteractionDeclarationCount:${expectedPath}#${name}:${matches.length}`)
}

function callResolvesTo(checker, call, declaration) {
  const resolved = checker.getResolvedSignature(call)?.declaration
  if (sameDeclaration(resolved, declaration)) return true
  const resolvedName = resolved && 'name' in resolved ? resolved.name : undefined
  const declarationName = 'name' in declaration ? declaration.name : undefined
  if (!resolvedName || !declarationName) return false
  const resolvedSymbol = canonicalSymbol(checker, checker.getSymbolAtLocation(resolvedName))
  const declarationSymbol = canonicalSymbol(checker, checker.getSymbolAtLocation(declarationName))
  return resolvedSymbol !== undefined && resolvedSymbol === declarationSymbol
}

function symbolResolvesTo(checker, node, declaration) {
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(node))
  return symbol?.declarations?.some((candidate) => sameDeclaration(candidate, declaration)) ?? false
}

function sameDeclaration(left, right) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.getSourceFile().fileName === right.getSourceFile().fileName &&
    left.getStart(left.getSourceFile()) === right.getStart(right.getSourceFile())
  )
}

function canonicalSymbol(checker, symbol) {
  let current = symbol
  const seen = new Set()
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current)
    current = checker.getAliasedSymbol(current)
  }
  return current
}

function symbolAtExpression(checker, expression) {
  if (ts.isPropertyAccessExpression(expression)) {
    return checker.getSymbolAtLocation(expression.name) ?? checker.getSymbolAtLocation(expression)
  }
  return checker.getSymbolAtLocation(expression)
}

function handleForExpression(checker, expression, handleBySymbol) {
  const candidate = unwrapExpression(expression)
  if (!candidate) return undefined
  const symbol = canonicalSymbol(checker, symbolAtExpression(checker, candidate))
  return symbol ? handleBySymbol.get(symbol) : undefined
}

function invocationHandle(checker, expression, handleBySymbol, runAliasBySymbol) {
  const candidate = unwrapExpression(expression)
  if (!candidate) return undefined
  if (ts.isPropertyAccessExpression(candidate) && candidate.name.text === 'run') {
    return handleForExpression(checker, candidate.expression, handleBySymbol)
  }
  const symbol = canonicalSymbol(checker, symbolAtExpression(checker, candidate))
  return symbol ? runAliasBySymbol.get(symbol) : undefined
}

function interactionRunSemantics(call, checker, sourceFile) {
  const object = unwrapExpression(call.arguments[0])
  if (!object || !ts.isObjectLiteralExpression(object)) {
    return {
      actionRanges: [],
      asyncCommit: false,
      unresolvedCommit: false,
      opaqueSpread: false,
      duplicateInput: false,
    }
  }
  const actionProperties = objectLiteralNamedProperties(object, 'action')
  const commitProperties = objectLiteralNamedProperties(object, 'commit')
  const action =
    actionProperties.length === 1
      ? objectLiteralCallableProperty(actionProperties[0], checker, sourceFile)
      : null
  const commit =
    commitProperties.length === 1 ? objectLiteralCallableValue(commitProperties[0]) : null
  const commitSemantics =
    commitProperties.length === 0
      ? 'absent'
      : commit
        ? callableReturnSemantics(commit, checker)
        : 'unresolved'
  return {
    actionRanges: action ? [{ start: action.getStart(sourceFile), end: action.getEnd() }] : [],
    asyncCommit: commitSemantics === 'async',
    unresolvedCommit:
      commitProperties.length > 1 ||
      commitSemantics === 'unresolved' ||
      commitSemantics === 'invalid',
    opaqueSpread: object.properties.some(ts.isSpreadAssignment),
    duplicateInput: actionProperties.length > 1 || commitProperties.length > 1,
  }
}

function objectLiteralNamedProperties(object, name) {
  return object.properties.filter((entry) => propertyNameText(entry.name) === name)
}

function objectLiteralCallableValue(property) {
  if (ts.isMethodDeclaration(property)) return property
  if (ts.isShorthandPropertyAssignment(property)) return property.name
  if (ts.isPropertyAssignment(property)) return unwrapExpression(property.initializer)
  return null
}

function objectLiteralCallableProperty(property, checker, sourceFile) {
  if (ts.isMethodDeclaration(property)) return property
  if (ts.isShorthandPropertyAssignment(property)) {
    const symbol = canonicalSymbol(checker, checker.getShorthandAssignmentValueSymbol(property))
    const declaration = callableDeclarationForSymbol(symbol, sourceFile)
    if (declaration) return declaration
    return (
      symbol?.declarations?.find(
        (candidate) =>
          candidate.getSourceFile() === sourceFile &&
          ts.isParameter(candidate) &&
          typeCanBeCalled(checker.getTypeAtLocation(candidate)),
      ) ?? null
    )
  }
  if (!ts.isPropertyAssignment(property)) return null
  const initializer = unwrapExpression(property.initializer)
  if (!initializer) return null
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer
  return callableDeclarationForExpression(initializer, checker, sourceFile)
}

function callableReturnSemantics(callable, checker) {
  const candidates = collectCallableCandidates(callable, checker)
  let resolved = false
  let invalidReturn = false
  for (const candidate of candidates) {
    if (callableContainsPromiseWork(candidate, checker)) return 'async'
    const signatures = checker.getTypeAtLocation(candidate).getCallSignatures()
    if (signatures.length === 0) continue
    resolved = true
    for (const signature of signatures) {
      const returnType = checker.getReturnTypeOfSignature(signature)
      if (typeIsPromiseLike(returnType, checker)) return 'async'
      if (!typeIsDefinitelySynchronousCommitResult(returnType)) invalidReturn = true
    }
  }
  if (!resolved) return 'unresolved'
  return invalidReturn ? 'invalid' : 'sync'
}

function collectCallableCandidates(callable, checker) {
  const candidates = []
  const queue = [callable]
  const seen = new Set()
  while (queue.length > 0 && candidates.length < 32) {
    const candidate = queue.shift()
    if (!candidate) continue
    const sourceFile = candidate.getSourceFile()
    const key = `${sourceFile.fileName}:${candidate.getStart(sourceFile)}:${candidate.getEnd()}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
    const symbol = canonicalSymbol(checker, symbolAtExpression(checker, candidate))
    for (const declaration of symbol?.declarations ?? []) {
      queue.push(declaration)
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const initializer = unwrapExpression(declaration.initializer)
        if (initializer) queue.push(initializer)
      }
    }
  }
  return candidates
}

function typeIsDefinitelySynchronousCommitResult(type) {
  if (type.isUnion?.()) {
    return type.types.every(typeIsDefinitelySynchronousCommitResult)
  }
  return (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never)) !== 0
}

function callableContainsPromiseWork(callable, checker) {
  const queue = [callable]
  const seen = new Set()
  while (queue.length > 0 && seen.size < 32) {
    const root = queue.shift()
    if (!root) continue
    const sourceFile = root.getSourceFile()
    const key = `${sourceFile.fileName}:${root.getStart(sourceFile)}:${root.getEnd()}`
    if (seen.has(key)) continue
    seen.add(key)
    let containsPromiseWork = false
    const visit = (node) => {
      if (containsPromiseWork) return
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const signature = checker.getResolvedSignature(node)
        if (signature && typeIsPromiseLike(checker.getReturnTypeOfSignature(signature), checker)) {
          containsPromiseWork = true
          return
        }
        if (
          node.arguments?.some(
            (argument) =>
              (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) &&
              ts
                .getModifiers(argument)
                ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
          )
        ) {
          containsPromiseWork = true
          return
        }
        const called = unwrapExpression(node.expression)
        const symbol = called
          ? canonicalSymbol(checker, symbolAtExpression(checker, called))
          : undefined
        for (const declaration of callableImplementationNodesForSymbol(symbol)) {
          if (!declaration.getSourceFile().isDeclarationFile) queue.push(declaration)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
    if (containsPromiseWork) return true
  }
  return false
}

function callableImplementationNodesForSymbol(symbol) {
  const implementations = []
  for (const declaration of symbol?.declarations ?? []) {
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)
    ) {
      implementations.push(declaration)
      continue
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const callable = localCallableInitializer(declaration.initializer)
      if (callable) implementations.push(callable)
    }
  }
  return implementations
}

function typeIsPromiseLike(type, checker) {
  if (checker.getPropertyOfType(type, 'then')) return true
  return type.isUnionOrIntersection?.()
    ? type.types.some((entry) => typeIsPromiseLike(entry, checker))
    : false
}

function typeHasOnlySynchronousOrTotalMembers(type, checker, totalPromiseBrandSymbol) {
  if (type.isUnion?.()) {
    return type.types.every((member) =>
      typeHasOnlySynchronousOrTotalMembers(member, checker, totalPromiseBrandSymbol),
    )
  }
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint
      ? typeHasOnlySynchronousOrTotalMembers(constraint, checker, totalPromiseBrandSymbol)
      : false
  }
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false
  if (!typeIsPromiseLike(type, checker)) return true
  return typeHasTotalPresentationPromiseBrand(type, checker, totalPromiseBrandSymbol)
}

function typeContainsTotalPresentationPromise(type, checker, totalPromiseBrandSymbol) {
  if (type.isUnion?.()) {
    return type.types.some((member) =>
      typeContainsTotalPresentationPromise(member, checker, totalPromiseBrandSymbol),
    )
  }
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type)
    return constraint
      ? typeContainsTotalPresentationPromise(constraint, checker, totalPromiseBrandSymbol)
      : false
  }
  return typeHasTotalPresentationPromiseBrand(type, checker, totalPromiseBrandSymbol)
}

function callableReturnSettlementFacts(type, checker, totalPromiseBrandSymbol) {
  const signatures = type.getCallSignatures()
  if (signatures.length === 0) {
    return {
      callable: false,
      onlySynchronousOrTotal: false,
      hasTotal: false,
      hasPotentiallyRejectingAsync: false,
    }
  }
  const returnTypes = signatures.map((signature) => checker.getReturnTypeOfSignature(signature))
  return {
    callable: true,
    onlySynchronousOrTotal: returnTypes.every((returnType) =>
      typeHasOnlySynchronousOrTotalMembers(returnType, checker, totalPromiseBrandSymbol),
    ),
    hasTotal: returnTypes.some((returnType) =>
      typeContainsTotalPresentationPromise(returnType, checker, totalPromiseBrandSymbol),
    ),
    hasPotentiallyRejectingAsync: returnTypes.some(
      (returnType) =>
        typeIsPromiseLike(returnType, checker) &&
        !typeHasOnlySynchronousOrTotalMembers(returnType, checker, totalPromiseBrandSymbol),
    ),
  }
}

function typeHasTotalPresentationPromiseBrand(type, checker, totalPromiseBrandSymbol) {
  if (!typeIsPromiseLike(type, checker)) return false
  return checker.getPropertiesOfType(type).some((property) => {
    if ((property.flags & ts.SymbolFlags.Optional) !== 0) return false
    const checkFlags = ts.getCheckFlags(property)
    if ((checkFlags & ts.CheckFlags.Mapped) !== 0 && (checkFlags & ts.CheckFlags.Readonly) === 0) {
      return false
    }
    return (property.declarations ?? []).some((declaration) => {
      if (
        !ts.isPropertySignature(declaration) ||
        declaration.questionToken ||
        !declaration.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        ) ||
        !ts.isComputedPropertyName(declaration.name)
      ) {
        return false
      }
      const brand = canonicalSymbol(
        checker,
        checker.getSymbolAtLocation(declaration.name.expression),
      )
      if (brand !== totalPromiseBrandSymbol) return false
      const value = checker.getTypeOfSymbolAtLocation(property, declaration)
      return (value.flags & ts.TypeFlags.BooleanLiteral) !== 0 && value === checker.getTrueType()
    })
  })
}

function validateTotalPromiseConstructionBoundary({
  root,
  sourceFiles,
  checker,
  totalPromiseBrandSymbol,
  problems,
}) {
  const constructions = []
  for (const sourceFile of sourceFiles) {
    const path = productionSourcePath(root, sourceFile)
    if (!path) continue
    walkSourceFile(sourceFile, (node) => {
      if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return
      const assertedType = checker.getTypeFromTypeNode(node.type)
      if (!typeHasTotalPresentationPromiseBrand(assertedType, checker, totalPromiseBrandSymbol)) {
        return
      }
      constructions.push({ path, sourceFile, node })
    })
  }
  if (constructions.length !== 2) {
    problems.push(`total-promise-construction: sites=${constructions.length}; expected=2`)
  }
  for (const construction of constructions) {
    const location = sourceLocation(construction.path, construction.sourceFile, construction.node)
    if (construction.path !== PRESENTATION_SOURCE_CONTRACT.factory.path) {
      problems.push(`total-promise-construction:${location}: controller boundary required`)
      continue
    }
    if (!promiseConstructionIsResolveOnly(construction.node.expression)) {
      problems.push(`total-promise-construction:${location}: resolve-only promise required`)
    }
  }
}

function promiseConstructionIsResolveOnly(expression) {
  const candidate = unwrapExpression(expression)
  if (
    candidate &&
    ts.isNewExpression(candidate) &&
    ts.isIdentifier(candidate.expression) &&
    candidate.expression.text === 'Promise' &&
    candidate.arguments?.length === 1
  ) {
    const executor = unwrapExpression(candidate.arguments[0])
    return (
      Boolean(executor) &&
      (ts.isArrowFunction(executor) || ts.isFunctionExpression(executor)) &&
      executor.parameters.length === 1
    )
  }
  return (
    Boolean(candidate) &&
    ts.isCallExpression(candidate) &&
    candidate.arguments.length === 1 &&
    ts.isPropertyAccessExpression(candidate.expression) &&
    ts.isIdentifier(candidate.expression.expression) &&
    candidate.expression.expression.text === 'Promise' &&
    candidate.expression.name.text === 'resolve'
  )
}

function propertyNameText(name) {
  if (!name) return null
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null
}

function reactEffectOwner(node, checker, sourceFile) {
  let current = node
  while (current.parent) {
    const parent = current.parent
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(parent) &&
      parent.arguments.includes(current)
    ) {
      const declaration = checker.getResolvedSignature(parent)?.declaration
      const leaf = declaration?.name?.getText(declaration.getSourceFile()) ?? ''
      const declarationPath = declaration?.getSourceFile().fileName.replaceAll('\\', '/') ?? ''
      if (
        (leaf === 'useEffect' || leaf === 'useLayoutEffect') &&
        declarationPath.includes('/node_modules/@types/react/')
      ) {
        return Object.freeze({
          kind: 'react-effect',
          hook: leaf,
          line: sourceFile.getLineAndCharacterOfPosition(parent.getStart(sourceFile)).line + 1,
        })
      }
    }
    current = parent
  }
  return null
}

function unwrapExpression(expression) {
  let current = expression
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression
  }
  return current
}

function variableDeclarationIsModuleScoped(declaration) {
  return declaration.parent?.parent?.parent && ts.isSourceFile(declaration.parent.parent.parent)
}

function objectLiteralStringProperty(expression, name) {
  const candidate = unwrapExpression(expression)
  if (!candidate || !ts.isObjectLiteralExpression(candidate)) return null
  const property = candidate.properties.find(
    (entry) => ts.isPropertyAssignment(entry) && propertyNameText(entry.name) === name,
  )
  if (!property || !ts.isPropertyAssignment(property)) return null
  const value = unwrapExpression(property.initializer)
  return value && ts.isStringLiteralLike(value) ? value.text : null
}

function nodePosition(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {
    line: position.line + 1,
    column: position.character + 1,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  }
}

function sourceLocation(path, sourceFile, node) {
  const { line, column } = nodePosition(sourceFile, node)
  return `${path}:${line}:${column}`
}

function assignStableFactIds(entries, keyFor) {
  const ordinals = new Map()
  for (const entry of [...entries].sort(
    (left, right) => left.path.localeCompare(right.path) || left.start - right.start,
  )) {
    const key = keyFor(entry)
    const ordinal = (ordinals.get(key) ?? 0) + 1
    ordinals.set(key, ordinal)
    entry.id = `${key}:${ordinal}`
  }
}

function groupValues(entries) {
  const groups = new Map()
  for (const entry of entries) {
    const values = groups.get(entry.key) ?? []
    values.push(entry.value)
    groups.set(entry.key, values)
  }
  return groups
}

function walkSourceFile(sourceFile, visitor) {
  const visit = (node) => {
    visitor(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function formatTypescriptDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

export function inventoryInteractionSitesInSource(path, source, typedSourceModel) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  return inventoryInteractionSitesInAst(path, sourceFile, typedSourceModel)
}

export function inspectPresentationRunFixtures(files, entryPath = 'entry.ts') {
  const { checker, program, virtualRoot } = buildVirtualInteractionProgram(
    files,
    '.interaction-audit-fixture',
  )
  const absoluteEntry = resolve(virtualRoot, entryPath).replaceAll('\\', '/')
  const sourceFile = program
    .getSourceFiles()
    .find((candidate) => candidate.fileName.replaceAll('\\', '/') === absoluteEntry)
  if (!sourceFile) throw new Error(`InteractionAuditFixtureEntryMissing:${entryPath}`)
  const results = []
  walkSourceFile(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return
    const expression = unwrapExpression(node.expression)
    const name = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ''
    if (name !== 'run') return
    const semantics = interactionRunSemantics(node, checker, sourceFile)
    results.push(
      Object.freeze({
        line: nodePosition(sourceFile, node).line,
        actionResolved: semantics.actionRanges.length > 0,
        asyncCommit: semantics.asyncCommit,
        unresolvedCommit: semantics.unresolvedCommit,
        opaqueSpread: semantics.opaqueSpread,
        duplicateInput: semantics.duplicateInput,
      }),
    )
  })
  return Object.freeze(results)
}

export function inspectInteractionCallbackGraphFixtures(files) {
  const { checker, program, totalPromiseBrandSymbol } = buildVirtualInteractionProgram(
    files,
    '.interaction-callback-graph-fixture',
  )
  const sourceFilesByPath = new Map()
  const model = {
    checker,
    program,
    totalPromiseBrandSymbol,
    sourceFilesByPath,
    invocations: [],
    presentationInvocationsByPath: new Map(),
    configurationDemandsByPath: new Map(),
  }
  const sites = []
  for (const sourceFile of program.getSourceFiles()) {
    const path = productionSourcePath(DEFAULT_ROOT, sourceFile)
    if (!path?.startsWith('src/.interaction-callback-graph-fixture/')) continue
    sourceFilesByPath.set(path, sourceFile)
    for (const sourceSite of inventoryInteractionSitesInAst(path, sourceFile, model)) {
      sites.push(Object.freeze({ ...sourceSite, ...classifyInteraction(sourceSite, null) }))
    }
  }
  return buildInteractionOutcomeGraph(DEFAULT_ROOT, model, sites)
}

export function inspectTotalPromiseConstructionBoundaryFixtures(files = {}) {
  const { checker, program, totalPromiseBrandSymbol } = buildVirtualInteractionProgram(
    files,
    '.interaction-total-promise-construction-fixture',
  )
  const problems = []
  validateTotalPromiseConstructionBoundary({
    root: DEFAULT_ROOT,
    sourceFiles: program
      .getSourceFiles()
      .filter((sourceFile) => productionSourcePath(DEFAULT_ROOT, sourceFile) !== null),
    checker,
    totalPromiseBrandSymbol,
    problems,
  })
  return Object.freeze(problems)
}

export function inspectInteractionGraphAlgorithmFixture(vertexCount) {
  if (!Number.isInteger(vertexCount) || vertexCount < 2) {
    throw new Error('InteractionGraphFixtureVertexCountInvalid')
  }
  const vertices = new Map()
  const edges = new Map()
  for (let index = 0; index < vertexCount; index += 1) {
    const id = `fixture:${index}`
    vertices.set(id, {
      id,
      kind: index === 0 ? 'interaction-site' : 'callback-slot',
      path: 'src/.interaction-graph-algorithm-fixture.tsx',
      component: `C${index}`,
      event: 'onAct',
      element: `C${index}`,
      synthetic: index !== 0,
    })
    if (index === 0) continue
    const from = `fixture:${index - 1}`
    const edgeId = `fixture-forward:${from}->${id}`
    edges.set(edgeId, { id: edgeId, from, to: id, kind: 'fixture-forward' })
  }
  const terminalId = `fixture:${vertexCount - 1}`
  const terminal = { ...vertices.get(terminalId), role: 'carrier' }
  vertices.set(terminalId, terminal)
  const terminals = new Map([[terminalId, terminal]])
  const work = {
    vertexDiscoveryVisits: vertices.size,
    edgeDiscoveryVisits: edges.size,
    sccVertexVisits: 0,
    sccEdgeVisits: 0,
    terminalPropagationEdgeVisits: 0,
  }
  const graph = condenseInteractionGraph(vertices, edges, terminals, new Map(), work)
  const rootComponent = graph.componentByVertex.get('fixture:0')
  return Object.freeze({
    counts: Object.freeze({
      vertices: vertices.size,
      edges: edges.size,
      condensedComponents: graph.components.length,
      condensedEdges: graph.condensedEdgeCount,
    }),
    work: Object.freeze(work),
    terminalRootIds: Object.freeze([...(graph.terminalIdsByComponent.get(rootComponent) ?? [])]),
    gapReasons: Object.freeze([...(graph.gapReasonsByComponent.get(rootComponent) ?? [])]),
  })
}

function buildVirtualInteractionProgram(files, directory) {
  const virtualRoot = resolve(DEFAULT_ROOT, `src/${directory}`)
  const virtualFiles = new Map(
    Object.entries(files).map(([path, source]) => [
      resolve(virtualRoot, path).replaceAll('\\', '/'),
      source,
    ]),
  )
  const configPath = resolve(DEFAULT_ROOT, 'tsconfig.app.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) throw new Error(formatTypescriptDiagnostic(config.error))
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    DEFAULT_ROOT,
    undefined,
    configPath,
  )
  const host = ts.createCompilerHost(parsed.options, true)
  const getSourceFile = host.getSourceFile.bind(host)
  host.fileExists = (path) =>
    virtualFiles.has(path.replaceAll('\\', '/')) || ts.sys.fileExists(path)
  host.directoryExists = (path) => {
    const normalized = path.replaceAll('\\', '/')
    return (
      normalized === virtualRoot ||
      normalized.startsWith(`${virtualRoot}/`) ||
      ts.sys.directoryExists(path)
    )
  }
  host.readFile = (path) => virtualFiles.get(path.replaceAll('\\', '/')) ?? ts.sys.readFile(path)
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const normalized = path.replaceAll('\\', '/')
    const source = virtualFiles.get(normalized)
    return source === undefined
      ? getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(
          path,
          source,
          languageVersion,
          true,
          path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        )
  }
  const program = ts.createProgram({
    rootNames: [
      ...virtualFiles.keys(),
      resolve(DEFAULT_ROOT, PRESENTATION_SOURCE_CONTRACT.factory.path),
    ],
    options: parsed.options,
    host,
  })
  const checker = program.getTypeChecker()
  const totalPromiseBrandDeclaration = requireNamedDeclaration(
    program,
    DEFAULT_ROOT,
    PRESENTATION_SOURCE_CONTRACT.factory.path,
    'totalPresentationInteractionPromiseBrand',
    ts.isVariableDeclaration,
  )
  const totalPromiseBrandSymbol = canonicalSymbol(
    checker,
    checker.getSymbolAtLocation(totalPromiseBrandDeclaration.name),
  )
  if (!totalPromiseBrandSymbol) throw new Error('TotalPresentationInteractionPromiseBrandMissing')
  return { checker, program, totalPromiseBrandSymbol, virtualRoot }
}

function inventoryInteractionSitesInAst(path, sourceFile, typedSourceModel) {
  const declarations = typedSourceModel ? null : collectLocalDeclarations(sourceFile)
  const rawSites = []
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue
        const event = attribute.name.getText(sourceFile)
        if (!/^on[A-Z]/u.test(event)) continue
        const handler = jsxAttributeExpression(attribute)
        rawSites.push(
          sourceInteraction({
            path,
            sourceFile,
            node,
            handler,
            declarations,
            typedSourceModel,
            kind: 'jsx-handler',
            event,
            element: node.tagName.getText(sourceFile),
          }),
        )
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addEventListener'
    ) {
      const eventNode = node.arguments[0]
      if (eventNode && ts.isStringLiteralLike(eventNode)) {
        rawSites.push(
          sourceInteraction({
            path,
            sourceFile,
            node,
            handler: node.arguments[1],
            declarations,
            typedSourceModel,
            kind: 'dom-listener',
            event: eventNode.text,
            element: node.expression.expression.getText(sourceFile),
          }),
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const ordinals = new Map()
  return rawSites.map((site) => {
    const base = `${site.path}#${site.source.owner}|${site.kind}|${site.event}|${site.element}|${site.sourceFingerprint}`
    const ordinal = (ordinals.get(base) ?? 0) + 1
    ordinals.set(base, ordinal)
    return Object.freeze({ ...site, id: `${base}:${ordinal}` })
  })
}

function sourceInteraction({
  path,
  sourceFile,
  node,
  handler,
  declarations,
  typedSourceModel,
  kind,
  event,
  element,
}) {
  const line =
    sourceFile.getLineAndCharacterOfPosition(
      kind === 'jsx-handler'
        ? findJsxEventAttribute(node, event, sourceFile).getStart(sourceFile)
        : node.getStart(sourceFile),
    ).line + 1
  const resolved = typedSourceModel
    ? resolveHandlerNodesWithChecker(handler, typedSourceModel.checker, sourceFile)
    : resolveHandlerNodes(handler, declarations, sourceFile)
  const analyzedNodes = [handler, ...resolved.nodes].filter(Boolean)
  const analyzedRanges = analyzedNodes.map((candidate) => ({
    start: candidate.getStart(sourceFile),
    end: candidate.getEnd(),
  }))
  const presentationInvocations = sourceFactsInRanges(
    typedSourceModel?.presentationInvocationsByPath.get(path),
    analyzedRanges,
  )
  const configurationDemands = sourceFactsInRanges(
    typedSourceModel?.configurationDemandsByPath.get(path),
    analyzedRanges,
  )
  const attributes =
    kind === 'jsx-handler' ? readJsxAttributes(node.attributes.properties, sourceFile) : []
  const localGates = attributes.filter((attribute) => LOCAL_GATE_ATTRIBUTES.has(attribute.name))
  const ancestorGates =
    kind === 'jsx-handler' ? readAncestorJsxGates(node, sourceFile) : Object.freeze([])
  const calls = uniqueSorted(
    analyzedNodes.flatMap((candidate) => collectCallNames(candidate, sourceFile)),
  )
  const guards = uniqueSorted(
    analyzedNodes.flatMap((candidate) => collectGuardExpressions(candidate, sourceFile)),
  ).slice(0, 24)
  const handlerText = boundedText(handler?.getText(sourceFile) ?? '', 480)
  const resolvedHandlerNames = uniqueSorted(resolved.names)
  const uncoveredAsyncSignals = uncoveredAsyncSignalsForContract(
    analyzedNodes,
    presentationInvocations,
    sourceFile,
    typedSourceModel?.checker,
    typedSourceModel?.totalPromiseBrandSymbol,
  )
  const totalPresentationOwnership =
    presentationInvocations.length > 0 &&
    presentationInvocations.every((entry) => entry.capabilityIds.length > 0) &&
    uncoveredAsyncSignals.length === 0
  return Object.freeze({
    path,
    line,
    kind,
    event,
    element,
    sourceFingerprint: sourceFingerprint(handler?.getText(sourceFile) ?? ''),
    source: Object.freeze({
      owner: findEnclosingOwner(node, sourceFile),
      handlerText,
      resolvedHandlerNames: Object.freeze(resolvedHandlerNames),
      calledSymbols: Object.freeze(calls),
      controlAttributes: Object.freeze(
        attributes.filter(
          (attribute) =>
            SEMANTIC_ATTRIBUTES.has(attribute.name) || LOCAL_GATE_ATTRIBUTES.has(attribute.name),
        ),
      ),
      guardExpressions: Object.freeze(guards),
      asyncSignals: analyzeAsyncOwnership(
        analyzedNodes,
        element,
        event,
        typedSourceModel?.checker,
        typedSourceModel?.totalPromiseBrandSymbol,
      ),
      presentationInteraction: Object.freeze({
        contractId: PRESENTATION_INTERACTION_CONTRACT_ID,
        invocationIds: Object.freeze(presentationInvocations.map((entry) => entry.id)),
        capabilityIds: Object.freeze(
          uniqueSorted(presentationInvocations.flatMap((entry) => entry.capabilityIds)),
        ),
        totalOwnership: totalPresentationOwnership,
        uncoveredAsyncSignals: Object.freeze(uncoveredAsyncSignals),
      }),
      configurationDemands: Object.freeze(
        configurationDemands.map((entry) =>
          Object.freeze({ id: entry.id, property: entry.property }),
        ),
      ),
      localGateAttributes: Object.freeze(localGates),
      ancestorGateAttributes: ancestorGates,
    }),
  })
}

function classifyInteraction(site, rule) {
  const operation = interactionOperationSignal(site)
  const effects = classifyEffects(site, operation)
  const requiredCapabilities = classifyCapabilities(site, rule, operation, effects)
  const scope = classifyScope(effects)
  const asyncOwnership = site.source.asyncSignals
  return Object.freeze({
    semanticIdentity: semanticIdentity(site),
    architecturalCluster: rule?.architecturalCluster ?? 'unclassified',
    scope,
    requiredCapabilities: Object.freeze(requiredCapabilities),
    effects: Object.freeze(effects),
    gates: Object.freeze({
      local: site.source.localGateAttributes,
      ancestors: site.source.ancestorGateAttributes,
      inherited: Object.freeze([]),
      disposition:
        site.path === 'src/app/WorkspaceBootstrap.tsx'
          ? 'Only exact local and same-source ancestor gates are derived.'
          : 'No aggregate Shell gate is inherited; exact local and same-source ancestor gates remain capability-local.',
    }),
    asyncOwnership,
    errorOwnership: reviewErrorOwnership(asyncOwnership, site.source.presentationInteraction),
    continuityObligations: Object.freeze(classifyContinuity(site, rule, effects)),
  })
}

function classifyEffects(site, operation) {
  const effects = new Set(['visual'])
  if (isDurableCommandInteraction(site, operation)) {
    effects.add('command')
  }
  if (isNavigationInteraction(site, operation)) {
    effects.add('navigation')
  }
  if (isQueryInteraction(site, operation)) {
    effects.add('query')
  }
  if (isBrowserIoInteraction(site, operation)) {
    effects.add('browser-io')
  }
  return [...effects].sort()
}

function classifyCapabilities(site, rule, operation, effects) {
  const capabilities = new Set(['tab-presentation'])
  if (site.path === 'src/app/WorkspaceBootstrap.tsx') capabilities.add('bootstrap-control')
  if (effects.includes('navigation')) capabilities.add('tab-navigation')
  if (effects.includes('query')) capabilities.add('repository-read')
  if (effects.includes('browser-io')) capabilities.add('browser-io')
  if (effects.includes('command')) capabilities.add('durable-write')
  if (isGenerationInteraction(operation)) {
    capabilities.add('generation-attempt')
    capabilities.add('durable-write')
  }
  const capabilityEffect = effects.some((effect) => rule?.projectionEffects.includes(effect))
  if (rule?.projectionCapability && capabilityEffect) {
    capabilities.add(rule.projectionCapability)
  }
  return [...capabilities].sort()
}

function classifyScope(effects) {
  if (effects.includes('command')) return 'mixed-tab-and-durable'
  if (effects.includes('browser-io')) return 'browser-external'
  return 'tab-local'
}

function classifyContinuity(site, rule, effects) {
  const obligations = new Set(['first-input-not-discarded', 'paint-continuity'])
  const event = site.event.toLowerCase()
  if (/click|change|input|key|focus|submit|pointerdown|contextmenu/u.test(event)) {
    obligations.add('focus-continuity')
  }
  if (
    rule?.scrollSensitive ||
    effects.includes('navigation') ||
    /scroll|wheel|pointer/u.test(site.event.toLowerCase())
  ) {
    obligations.add('scroll-continuity')
  }
  if (
    site.source.asyncSignals.isAsync ||
    effects.includes('query') ||
    effects.includes('command')
  ) {
    obligations.add('unrelated-controls-remain-interactive')
  }
  if (
    effects.includes('navigation') ||
    effects.includes('command') ||
    isGenerationInteraction(interactionOperationSignal(site))
  ) {
    obligations.add('tab-intent-isolation')
  }
  return [...obligations].sort()
}

function semanticIdentity(site) {
  const hooks = new Map(
    (site.semanticHooks ?? []).map((hook) => {
      const separator = hook.indexOf('=')
      return separator === -1 ? [hook, ''] : [hook.slice(0, separator), hook.slice(separator + 1)]
    }),
  )
  for (const name of ['data-role', 'data-ui', 'aria-label']) {
    const value = hooks.get(name)
    if (value) return Object.freeze({ kind: name, value: `${value}.${site.event}` })
  }
  const customCallback = site.kind === 'jsx-handler' && /^[A-Z]/u.test(site.element)
  return Object.freeze({
    kind: customCallback ? 'component-callback-contract' : 'generated-exact-locator',
    value: `${site.element}.${site.event}@${site.path}:${site.line}`,
  })
}

function buildClassificationGaps(classification, matchedRules, exception) {
  const gaps = []
  if (matchedRules.length === 0) gaps.push('classification-rule-missing')
  if (matchedRules.length > 1) gaps.push('classification-rule-overlap')
  if (exception && matchedRules.length !== 1) gaps.push('exception-without-unique-base-rule')
  if (!classification.semanticIdentity.value) gaps.push('semantic-identity-missing')
  if (classification.architecturalCluster === 'unclassified') gaps.push('cluster-unresolved')
  if (classification.scope === 'unknown') gaps.push('scope-unresolved')
  if (classification.effects.includes('unknown')) gaps.push('effect-unresolved')
  if (classification.requiredCapabilities.includes('unknown')) gaps.push('capability-unresolved')
  if (!classification.errorOwnership?.reviewDisposition) gaps.push('error-owner-unreviewed')
  return uniqueSorted(gaps)
}

function buildArchitectureGaps(classification) {
  const gaps = []
  if (classification.gates.inherited.includes('aggregate-workspace-running-shell-inert')) {
    gaps.push('inherited-aggregate-shell-gate')
  }
  if (classification.errorOwnership.reviewDisposition === 'reviewed-static-non-proof') {
    gaps.push('async-error-owner-not-proven')
  }
  return Object.freeze(uniqueSorted(gaps))
}

function applyException(derived, exception) {
  return Object.freeze({
    ...derived,
    ...(exception.semanticIdentity ? { semanticIdentity: exception.semanticIdentity } : {}),
    ...(exception.architecturalCluster
      ? { architecturalCluster: exception.architecturalCluster }
      : {}),
    ...(exception.scope ? { scope: exception.scope } : {}),
    ...(exception.requiredCapabilities
      ? { requiredCapabilities: Object.freeze([...exception.requiredCapabilities].sort()) }
      : {}),
    ...(exception.effects ? { effects: Object.freeze([...exception.effects].sort()) } : {}),
    ...(exception.continuityObligations
      ? { continuityObligations: Object.freeze([...exception.continuityObligations].sort()) }
      : {}),
    ...(exception.errorOwnership
      ? { errorOwnership: Object.freeze(exception.errorOwnership) }
      : {}),
  })
}

function interactionOperationSignal(site) {
  const simpleHandler = /^[\w?.]+$/u.test(site.source.handlerText) ? site.source.handlerText : ''
  const operationCalls = site.source.calledSymbols.filter((symbol) => {
    const leaf = symbol.split('.').at(-1) ?? symbol
    return symbol.includes('.') || !/^set[A-Z]/u.test(leaf)
  })
  return [
    site.event,
    simpleHandler,
    ...site.source.resolvedHandlerNames,
    ...operationCalls,
    ...site.source.controlAttributes
      .filter((attribute) => ['download', 'href', 'target', 'type'].includes(attribute.name))
      .map((attribute) => `${attribute.name}=${attribute.value}`),
  ]
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[^a-z0-9]+/giu, ' ')
    .toLowerCase()
}

function isDurableCommandInteraction(site, operation) {
  if (
    /^on(?:abort|add|confirm|continue(?:message)?|delete(?:node)?|dismissgenerationnotice|editandsendmessage|editinplace|fork(?:chat|message)?|insert(?:afterleaf|atchildleg|atsharedtrunk)?|mutate(?:attachmentref|messageattachmentref)|reassignTo|regeneratemessage|remove|replaceupload|restoreupload|save(?:asnew|toexisting)?|submit|toggle(?:contextvisibility|provideroutputitemhidden|reasoningdetailhidden))$/iu.test(
      site.event,
    )
  ) {
    return true
  }
  if (
    /\b(?:catalog|configuration|interchange|storage) application(?: [a-z0-9]+){0,2} (?:add|apply|archive|batch relink|clear|create|delete|detach|duplicate|ensure and move|execute|import|ingest|move|overwrite|patch|relink|remove|rename|reorder|replace|restore|save|set|switch|unarchive)\b/u.test(
      operation,
    )
  ) {
    return true
  }
  if (site.path === 'src/ui/chat/ChatHeader.tsx' && /\bcommit edit\b/u.test(operation)) {
    return true
  }
  return /\b(?:abort keyboard stream|conversation actions|commit (?:height|save|save and send)|delete attachment for storage|detach attachment ref|handle import|import (?:chat|connection|file|preset json|workspace)|ingest files|relink attachment ref|send|set attachment ref visibility|write [a-z]|edit (?:on blur|on pointer up|set value)|on (?:abort|continue|delete|dismiss generation notice|edit and send|edit in place|fork chat|insert|mutate|regenerate|remove|save|toggle context visibility|toggle message context visibility|toggle provider output item hidden|toggle reasoning detail hidden)|run profile action|run delete|save as new|update config|update include|patch)\b/u.test(
    operation,
  )
}

function isNavigationInteraction(site, operation) {
  if (
    /^on(?:activate|activatenode|auxclickcapture|chatintent|clickcapture|contextmenucapture|openSidebar|treeviewintent)$/iu.test(
      site.event,
    )
  ) {
    return true
  }
  return /\b(?:begin route intent|chat href|home href|make anchor click handler|navigate(?: conversation)?|navigate for intent|new chat|open new chat|storage href)\b/u.test(
    operation,
  )
}

function isQueryInteraction(site, operation) {
  if (site.source.configurationDemands.length > 0) return true
  if (/^on(?:load|loadmore|loadoldermessages|retry|test)$/iu.test(site.event)) return true
  return /\b(?:(?:catalog|configuration|interchange|storage) application(?: [a-z0-9]+){0,2} (?:export|get|list|load|plan|probe|query|read|refresh|resolve|search)|fetch|load(?:er)?|probe|query|refresh|resolve conversation sibling position|retry|search|set query|set search|get attachment)\b/u.test(
    operation,
  )
}

function isBrowserIoInteraction(site, operation) {
  if (/^(?:change|onchange|ondrop|drop)$/iu.test(site.event) && /\btype file\b/u.test(operation)) {
    return true
  }
  return /\b(?:clipboard|copy diagnostics|copy message|download|export|file input|handle import|import (?:chat|connection|file|input ref|preset json|workspace)|ingest files|navigator|show open file picker|trigger json download|window open)\b/u.test(
    operation,
  )
}

function isGenerationInteraction(operation) {
  return /\b(?:abort keyboard stream|on abort|on continue|on edit and send|on regenerate|regenerate message|send)\b/u.test(
    operation,
  )
}

function reviewErrorOwnership(asyncSignals, presentationInteraction) {
  if (presentationInteraction.totalOwnership) {
    return Object.freeze({
      owner: PRESENTATION_INTERACTION_CONTRACT_ID,
      reviewDisposition: 'source-resolved-total-owner',
      rationale:
        'The compiler-resolved interaction handle returns one total outcome and owns rejection, cancellation, supersession, pending rejection, and failure publication.',
    })
  }
  if (asyncSignals.hasCatch) {
    return Object.freeze({
      owner: 'local-handler-catch',
      reviewDisposition: 'reviewed-static-owner',
      rationale: 'The analyzed handler closure contains an exact catch boundary.',
    })
  }
  if (asyncSignals.totalNonRejecting) {
    return Object.freeze({
      owner: PRESENTATION_INTERACTION_CONTRACT_ID,
      reviewDisposition: 'source-resolved-total-owner',
      rationale:
        'The exact private-brand settlement remains asynchronous for continuity but cannot reject; every terminal outcome is a resolved value.',
    })
  }
  if (!asyncSignals.isAsync) {
    return Object.freeze({
      owner: 'synchronous-site',
      reviewDisposition: 'reviewed-static-owner',
      rationale:
        'No local async syntax is visible; imported or delegated promise returns remain outside scanner proof.',
    })
  }
  return Object.freeze({
    owner: asyncSignals.errorOwner,
    reviewDisposition: 'reviewed-static-non-proof',
    rationale:
      'The site is explicitly classified, but no local catch proves ownership of a rejected delegated or detached promise.',
  })
}

function interactionRuleMatches(rule, path) {
  if (rule.match.excludedPaths.includes(path)) return false
  if (rule.match.excludedPathPrefixes.some((prefix) => path.startsWith(prefix))) return false
  return (
    rule.match.paths.includes(path) ||
    rule.match.pathPrefixes.some((prefix) => path.startsWith(prefix))
  )
}

function sourceFactRecord(site) {
  return JSON.stringify({
    id: site?.id,
    owner: site?.source?.owner,
    handler: site?.source?.handlerText,
    resolved: site?.source?.resolvedHandlerNames,
    calls: site?.source?.calledSymbols,
    attrs: site?.source?.controlAttributes,
    guards: site?.source?.guardExpressions,
    async: site?.source?.asyncSignals,
    presentationInteraction: site?.source?.presentationInteraction,
    configurationDemands: site?.source?.configurationDemands,
  })
}

export function interactionSiteDigests(sites) {
  const exactSiteIds = sites.map((site) => site?.id ?? '<missing>').sort()
  const sourceFactRecords = sites.map(sourceFactRecord).sort()
  return Object.freeze({
    exactSiteIdSha256: sha256(exactSiteIds.join('\n')),
    sourceFactSha256: sha256(sourceFactRecords.join('\n')),
  })
}

export function presentationDefinitionDigest(definitions) {
  const records = definitions
    .map((definition) =>
      JSON.stringify({
        capabilityId: definition?.capabilityId ?? '<missing>',
        path: definition?.path ?? '<missing>',
        name: definition?.name ?? '<missing>',
        concurrency: definition?.concurrency ?? '<missing>',
        lifetime: definition?.lifetime ?? '<missing>',
      }),
    )
    .sort()
  return sha256(records.join('\n'))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function analyzeAsyncOwnership(nodes, element, event, checker, totalPromiseBrandSymbol) {
  let isAsync = false
  let hasAwait = false
  let hasCatch = false
  let hasFinally = false
  let fireAndForget = false
  let hasTotalAsync = false
  let hasPotentiallyRejectingAsync = false
  for (const node of nodes) {
    if (checker && totalPromiseBrandSymbol) {
      const settlement = callableReturnSettlementFacts(
        checker.getTypeAtLocation(node),
        checker,
        totalPromiseBrandSymbol,
      )
      if (settlement.hasTotal) {
        isAsync = true
        hasTotalAsync = true
      }
      if (settlement.hasPotentiallyRejectingAsync) {
        isAsync = true
        hasPotentiallyRejectingAsync = true
      }
    }
    const visit = (candidate) => {
      if (candidate !== node && isCallableDeclaration(candidate)) return
      if (
        'modifiers' in candidate &&
        candidate.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        isAsync = true
        hasPotentiallyRejectingAsync = true
      }
      if (ts.isAwaitExpression(candidate)) {
        isAsync = true
        hasAwait = true
        const awaitedType = checker?.getTypeAtLocation(candidate.expression)
        if (
          checker &&
          totalPromiseBrandSymbol &&
          awaitedType &&
          typeHasOnlySynchronousOrTotalMembers(awaitedType, checker, totalPromiseBrandSymbol)
        ) {
          hasTotalAsync = true
        } else {
          hasPotentiallyRejectingAsync = true
        }
      }
      if (ts.isCatchClause(candidate) && catchClauseSettles(candidate)) hasCatch = true
      if (ts.isTryStatement(candidate) && candidate.finallyBlock) hasFinally = true
      if (ts.isVoidExpression(candidate)) {
        const semantics = checker
          ? observableAsyncTypeSemantics(checker.getTypeAtLocation(candidate.expression), checker)
          : 'unknown'
        if (semantics !== 'sync') {
          isAsync = true
          fireAndForget = true
          if (
            checker &&
            totalPromiseBrandSymbol &&
            typeHasOnlySynchronousOrTotalMembers(
              checker.getTypeAtLocation(candidate.expression),
              checker,
              totalPromiseBrandSymbol,
            )
          ) {
            hasTotalAsync = true
          } else {
            hasPotentiallyRejectingAsync = true
          }
        }
      }
      if (
        checker &&
        (ts.isCallExpression(candidate) || ts.isNewExpression(candidate)) &&
        observableAsyncTypeSemantics(checker.getTypeAtLocation(candidate), checker) !== 'sync'
      ) {
        isAsync = true
        if (
          totalPromiseBrandSymbol &&
          typeHasOnlySynchronousOrTotalMembers(
            checker.getTypeAtLocation(candidate),
            checker,
            totalPromiseBrandSymbol,
          )
        ) {
          hasTotalAsync = true
        } else {
          hasPotentiallyRejectingAsync = true
        }
      }
      if (
        ts.isCallExpression(candidate) &&
        ts.isPropertyAccessExpression(candidate.expression) &&
        candidate.expression.name.text === 'catch'
      ) {
        isAsync = true
        if (
          candidate.arguments[0] &&
          promiseContinuationIsSynchronous(candidate.arguments[0], checker)
        ) {
          hasCatch = true
        }
      }
      ts.forEachChild(candidate, visit)
    }
    visit(node)
  }
  const delegated = /^[A-Z]/u.test(element) && /^on[A-Z]/u.test(event)
  const errorOwner = hasCatch
    ? 'local-catch'
    : !isAsync
      ? 'synchronous-or-unobserved'
      : hasTotalAsync && !hasPotentiallyRejectingAsync
        ? 'typed-total-outcome'
        : delegated
          ? 'delegated-component-callback'
          : fireAndForget
            ? 'fire-and-forget-without-local-catch'
            : 'unowned-async'
  return Object.freeze({
    isAsync,
    hasAwait,
    hasCatch,
    hasFinally,
    fireAndForget,
    hasPotentiallyRejectingAsync,
    totalNonRejecting: hasTotalAsync && !hasPotentiallyRejectingAsync,
    errorOwner,
    disposition:
      'Static syntax describes visible ownership only; callees may own additional error policy and require site review.',
  })
}

function collectLocalDeclarations(sourceFile) {
  const declarations = new Map()
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const callable = localCallableInitializer(node.initializer)
      if (callable) declarations.set(node.name.text, callable)
    }
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      declarations.set(node.name.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return declarations
}

function localCallableInitializer(initializer) {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer
  if (!ts.isCallExpression(initializer)) return null
  const callee = initializer.expression
  const leaf = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ''
  if (!['useCallback', 'useMemo'].includes(leaf)) return null
  const callback = initializer.arguments[0]
  return callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : null
}

function resolveHandlerNodesWithChecker(handler, checker, sourceFile) {
  if (!handler) return { names: [], nodes: [] }
  const queue = []
  const enqueueExpression = (expression, depth) => {
    const declaration = callableDeclarationForExpression(expression, checker, sourceFile)
    if (declaration) queue.push({ declaration, depth })
  }
  enqueueExpression(handler, 0)
  for (const expression of collectCallExpressions(handler)) {
    enqueueExpression(expression, 0)
  }
  const seen = new Set()
  const names = []
  const nodes = []
  while (queue.length > 0 && nodes.length < 24) {
    const current = queue.shift()
    if (!current) continue
    const key = current.declaration.getStart(sourceFile)
    if (seen.has(key)) continue
    seen.add(key)
    nodes.push(current.declaration)
    names.push(declarationName(current.declaration, sourceFile))
    if (current.depth >= 2) continue
    for (const expression of collectCallExpressions(current.declaration)) {
      enqueueExpression(expression, current.depth + 1)
    }
  }
  return { names, nodes }
}

function callableDeclarationForExpression(expression, checker, sourceFile) {
  const candidate = unwrapExpression(expression)
  if (!candidate) return null
  const symbol = canonicalSymbol(checker, symbolAtExpression(checker, candidate))
  const direct = callableDeclarationForSymbol(symbol, sourceFile)
  if (direct) return direct
  if (ts.isPropertyAccessExpression(candidate)) {
    return returnedObjectCallableForPropertyAccess(candidate, checker, sourceFile)
  }
  return null
}

function callableDeclarationForSymbol(symbol, sourceFile) {
  for (const declaration of symbol?.declarations ?? []) {
    if (declaration.getSourceFile() !== sourceFile) continue
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)
    ) {
      return declaration
    }
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const callable = localCallableInitializer(declaration.initializer)
      if (callable) return callable
    }
  }
  return null
}

function returnedObjectCallableForPropertyAccess(access, checker, sourceFile) {
  const receiver = unwrapExpression(access.expression)
  if (!receiver) return null
  const receiverSymbol = canonicalSymbol(checker, symbolAtExpression(checker, receiver))
  for (const declaration of receiverSymbol?.declarations ?? []) {
    if (
      declaration.getSourceFile() !== sourceFile ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer
    ) {
      continue
    }
    const initializer = unwrapExpression(declaration.initializer)
    if (!initializer || !ts.isCallExpression(initializer)) continue
    const factory = checker.getResolvedSignature(initializer)?.declaration
    if (!factory || factory.getSourceFile() !== sourceFile) continue
    for (const returned of returnObjectLiterals(factory)) {
      const property = returned.properties.find(
        (entry) => propertyNameText(entry.name) === access.name.text,
      )
      if (!property) continue
      if (ts.isMethodDeclaration(property)) return property
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = canonicalSymbol(checker, checker.getShorthandAssignmentValueSymbol(property))
        const callable = callableDeclarationForSymbol(symbol, sourceFile)
        if (callable) return callable
      }
      if (ts.isPropertyAssignment(property)) {
        const initializer = unwrapExpression(property.initializer)
        if (
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          return initializer
        }
        if (initializer) {
          const callable = callableDeclarationForExpression(initializer, checker, sourceFile)
          if (callable) return callable
        }
      }
    }
  }
  return null
}

function returnObjectLiterals(declaration) {
  const objects = []
  const visit = (node) => {
    if (ts.isReturnStatement(node)) {
      const expression = unwrapExpression(node.expression)
      if (expression && ts.isObjectLiteralExpression(expression)) objects.push(expression)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  return objects
}

function collectCallExpressions(node) {
  const expressions = []
  const visit = (candidate) => {
    if (ts.isCallExpression(candidate) || ts.isNewExpression(candidate)) {
      expressions.push(candidate.expression)
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return expressions
}

function declarationName(declaration, sourceFile) {
  if (declaration.name) return declaration.name.getText(sourceFile)
  if (
    (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) &&
    ts.isVariableDeclaration(declaration.parent) &&
    ts.isIdentifier(declaration.parent.name)
  ) {
    return declaration.parent.name.text
  }
  return `<local@${declaration.getStart(sourceFile)}>`
}

function uncoveredAsyncSignalsForContract(
  nodes,
  invocations,
  sourceFile,
  checker,
  totalPromiseBrandSymbol,
) {
  const actionBoundaries = findActionBoundaries(invocations, sourceFile)
  const contractOwnedDeclarations = checker
    ? collectContractOwnedDeclarations(actionBoundaries, sourceFile, checker)
    : new Set()
  const signals = new Map()
  for (const root of new Set([...nodes, ...actionBoundaries, ...contractOwnedDeclarations])) {
    const visit = (node) => {
      if (
        node !== root &&
        isCallableDeclaration(node) &&
        !actionBoundaries.has(node) &&
        !contractOwnedDeclarations.has(node)
      ) {
        return
      }
      if (
        ts.isAwaitExpression(node) ||
        (ts.isVoidExpression(node) &&
          (!checker ||
            observableAsyncTypeSemantics(checker.getTypeAtLocation(node.expression), checker) !==
              'sync'))
      ) {
        signals.set(`${node.kind}:${node.getStart(sourceFile)}`, node)
      }
      if (
        checker &&
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        typeIsPromiseLike(checker.getTypeAtLocation(node), checker)
      ) {
        if (
          totalPromiseBrandSymbol &&
          typeHasOnlySynchronousOrTotalMembers(
            checker.getTypeAtLocation(node),
            checker,
            totalPromiseBrandSymbol,
          )
        ) {
          return
        }
        signals.set(`${node.kind}:${node.getStart(sourceFile)}`, node)
      }
      if (
        (ts.isArrowFunction(node) ||
          ts.isFunctionExpression(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isMethodDeclaration(node)) &&
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        const modifier = node.modifiers.find(
          (candidate) => candidate.kind === ts.SyntaxKind.AsyncKeyword,
        )
        if (modifier) signals.set(`${modifier.kind}:${modifier.getStart(sourceFile)}`, modifier)
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
  }
  const uncovered = []
  const expectedActionRanges = new Set(
    invocations.flatMap((invocation) =>
      invocation.actionRanges.map((range) => `${range.start}:${range.end}`),
    ),
  )
  if (actionBoundaries.size !== expectedActionRanges.size) {
    uncovered.push(`ActionBoundaryMissing:${expectedActionRanges.size - actionBoundaries.size}`)
  }
  for (const signal of signals.values()) {
    if (asyncSignalOwnedByContract(signal, actionBoundaries, contractOwnedDeclarations, checker))
      continue
    const start = signal.getStart(sourceFile)
    const position = sourceFile.getLineAndCharacterOfPosition(start)
    uncovered.push(`${ts.SyntaxKind[signal.kind]}@${position.line + 1}:${position.character + 1}`)
  }
  return uniqueSorted(uncovered)
}

function observableAsyncTypeSemantics(type, checker) {
  if (typeIsPromiseLike(type, checker)) return 'async'
  if (type.isUnion?.()) {
    const members = type.types.map((entry) => observableAsyncTypeSemantics(entry, checker))
    if (members.includes('async')) return 'async'
    return members.every((entry) => entry === 'sync') ? 'sync' : 'unknown'
  }
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !== 0) {
    return 'unknown'
  }
  return 'sync'
}

function findActionBoundaries(invocations, sourceFile) {
  const ranges = invocations.flatMap((invocation) => invocation.actionRanges)
  const boundaries = new Set()
  const visit = (node) => {
    if (
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isParameter(node)) &&
      ranges.some(
        (range) => node.getStart(sourceFile) === range.start && node.getEnd() === range.end,
      )
    ) {
      boundaries.add(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return boundaries
}

function collectContractOwnedDeclarations(actionBoundaries, sourceFile, checker) {
  const owned = new Set()
  const pending = [...actionBoundaries]
  const inspected = new Set()
  while (pending.length > 0) {
    const root = pending.shift()
    if (!root || inspected.has(root)) continue
    inspected.add(root)
    const visit = (node) => {
      if (
        (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
        typeIsPromiseLike(checker.getTypeAtLocation(node), checker) &&
        promiseExpressionOwnedByBoundary(node, root)
      ) {
        const declaration = ts.isCallExpression(node)
          ? checker.getResolvedSignature(node)?.declaration
          : undefined
        if (declaration?.getSourceFile() === sourceFile && !owned.has(declaration)) {
          owned.add(declaration)
          pending.push(declaration)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
  }
  return owned
}

function asyncSignalOwnedByContract(signal, actionBoundaries, ownedDeclarations, checker) {
  if (ts.isVoidExpression(signal)) return false
  const boundary = enclosingOwnedBoundary(signal, actionBoundaries, ownedDeclarations)
  if (!boundary) return false
  if (signal.kind === ts.SyntaxKind.AsyncKeyword || ts.isAwaitExpression(signal)) return true
  if ((ts.isCallExpression(signal) || ts.isNewExpression(signal)) && checker) {
    return promiseExpressionOwnedByBoundary(signal, boundary)
  }
  return false
}

function enclosingOwnedBoundary(signal, actionBoundaries, ownedDeclarations) {
  let current = signal.parent
  while (current) {
    if (actionBoundaries.has(current) || ownedDeclarations.has(current)) return current
    current = current.parent
  }
  return null
}

function promiseExpressionOwnedByBoundary(expression, boundary) {
  let current = expression
  while (current && current !== boundary) {
    if (ts.isVoidExpression(current)) return false
    if (ts.isAwaitExpression(current) || ts.isReturnStatement(current)) return true
    current = current.parent
  }
  return (
    (ts.isArrowFunction(boundary) || ts.isFunctionExpression(boundary)) &&
    !ts.isBlock(boundary.body) &&
    expression.pos >= boundary.body.pos &&
    expression.end <= boundary.body.end
  )
}

function resolveHandlerNodes(handler, declarations, sourceFile) {
  if (!handler) return { names: [], nodes: [] }
  const initialNames = new Set()
  if (ts.isIdentifier(handler)) initialNames.add(handler.text)
  for (const name of collectCallNames(handler, sourceFile)) {
    const leaf = name.split('.').at(-1)
    if (leaf) initialNames.add(leaf)
  }
  const queue = [...initialNames].map((name) => ({ name, depth: 0 }))
  const seen = new Set()
  const names = []
  const nodes = []
  while (queue.length > 0 && nodes.length < 24) {
    const current = queue.shift()
    if (!current || seen.has(current.name)) continue
    seen.add(current.name)
    const declaration = declarations.get(current.name)
    if (!declaration) continue
    names.push(current.name)
    nodes.push(declaration)
    if (current.depth >= 2) continue
    for (const name of collectCallNames(declaration, sourceFile)) {
      const leaf = name.split('.').at(-1)
      if (leaf && !seen.has(leaf)) queue.push({ name: leaf, depth: current.depth + 1 })
    }
  }
  return { names, nodes }
}

function collectCallNames(node, sourceFile) {
  const names = []
  const visit = (candidate) => {
    if (ts.isCallExpression(candidate) || ts.isNewExpression(candidate)) {
      names.push(candidate.expression.getText(sourceFile))
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return names
}

function collectGuardExpressions(node, sourceFile) {
  const expressions = []
  const visit = (candidate) => {
    if (ts.isIfStatement(candidate))
      expressions.push(boundedText(candidate.expression.getText(sourceFile), 240))
    if (ts.isConditionalExpression(candidate)) {
      expressions.push(boundedText(candidate.condition.getText(sourceFile), 240))
    }
    ts.forEachChild(candidate, visit)
  }
  visit(node)
  return expressions
}

function findEnclosingOwner(node, sourceFile) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(sourceFile)
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
    current = current.parent
  }
  return '<module>'
}

function readJsxAttributes(properties, sourceFile) {
  return properties.filter(ts.isJsxAttribute).map((attribute) =>
    Object.freeze({
      name: attribute.name.getText(sourceFile),
      value: jsxAttributeValue(attribute, sourceFile),
    }),
  )
}

function readAncestorJsxGates(node, sourceFile) {
  const gates = []
  let current = node.parent
  while (current) {
    if (ts.isJsxElement(current)) {
      for (const attribute of readJsxAttributes(
        current.openingElement.attributes.properties,
        sourceFile,
      )) {
        if (LOCAL_GATE_ATTRIBUTES.has(attribute.name)) gates.push(attribute)
      }
    }
    current = current.parent
  }
  return Object.freeze(gates)
}

function jsxAttributeValue(attribute, sourceFile) {
  if (!attribute.initializer) return 'true'
  if (ts.isStringLiteralLike(attribute.initializer)) return attribute.initializer.text
  if (ts.isJsxExpression(attribute.initializer)) {
    return boundedText(attribute.initializer.expression?.getText(sourceFile) ?? '', 240)
  }
  return boundedText(attribute.initializer.getText(sourceFile), 240)
}

function jsxAttributeExpression(attribute) {
  return attribute.initializer && ts.isJsxExpression(attribute.initializer)
    ? attribute.initializer.expression
    : undefined
}

function findJsxEventAttribute(node, event, sourceFile) {
  const attribute = node.attributes.properties.find(
    (candidate) => ts.isJsxAttribute(candidate) && candidate.name.getText(sourceFile) === event,
  )
  if (!attribute) throw new Error(`InteractionEventAttributeMissing:${event}`)
  return attribute
}

function boundedText(value, maxLength) {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false
  const sortedLeft = uniqueSorted(left)
  const sortedRight = uniqueSorted(right)
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function groupBy(values, keyFor) {
  const groups = new Map()
  for (const value of values) {
    const key = keyFor(value)
    const group = groups.get(key) ?? []
    group.push(value)
    groups.set(key, group)
  }
  return groups
}
