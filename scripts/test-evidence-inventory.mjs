import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'
import {
  buildLocalModuleGraph,
  discoverLocalModulePaths,
  LOCAL_MODULE_CODE_EXTENSIONS,
} from './local-module-graph.mjs'
import { sourceFingerprint } from './source-site-identity.mjs'
import { DECLARED_TEST_DOMAINS, TEST_GUARANTEE_CLAIMS } from './test-evidence-manifest.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const DIMENSION_PATTERNS = Object.freeze({
  success:
    /\b(?:happy path|succeed|success|render|persist|preserve|keep|load|stream|commit|round[- ]trip|open|send|follow|reconcile|survive)\w*/iu,
  failure:
    /\b(?:fail|error|invalid|malformed|abort|reject|missing|denied|closed|stale|orphan|drop|unavailable|cannot)\b/iu,
  concurrency:
    /\b(?:concurr|simultan|parallel|race|interleav|two tabs|two streams|two sends|100 writers|web locks?)\w*/iu,
  'multi-tab':
    /\b(?:multi[- ]tab|two tabs|tab [ab]|other tab|another tab|background tab|hidden tab|broadcastchannel|newpage)\b/iu,
  performance:
    /\b(?:performance|bounded|linear|quadratic|100k|100,?000|million|latency|budget|cold|hydrate|body i\/o|work count|o\()\w*/iu,
  memory:
    /\b(?:memory|retain|retention|release|dispose|object graph|object url|bounded buffer|cold bod|heap|garbage collect|blob:)\w*/iu,
  storage:
    /\b(?:indexeddb|idb|dexie|database|storage|persist|import|export|backup|quota|cache|opfs|transaction)\w*/iu,
  'dev-preview':
    /\b(?:vite|vite preview|built preview|production build|built app|verify-dist|dev server|production artifact)\b/iu,
})
export const TEST_EVIDENCE_DIMENSIONS = Object.freeze(Object.keys(DIMENSION_PATTERNS))

const SOURCE_DIMENSION_PATTERNS = Object.freeze({
  concurrency:
    /Promise\.all|\.newPage\s*\(|BroadcastChannel|Web Locks?|Atomics\.|concurr|simultan|interleav/iu,
  'multi-tab':
    /\.newPage\s*\(|BroadcastChannel|visibilitychange|visibilityState|background tab|hidden tab/iu,
  performance:
    /performance\.now|workCount|100_?000|bounded|linear|quadratic|body I\/O|latency|budget/iu,
  memory:
    /memoryUsage|WeakRef|FinalizationRegistry|object URL|retention|release|dispose|cold bod|bounded buffer|heap/iu,
  storage:
    /indexedDB|IDB[A-Z]|Dexie|getDb\s*\(|localStorage|caches\s*\.|navigator\.storage|OPFS|\.transaction\s*\(/u,
  'dev-preview':
    /\b(?:vite|vite preview|built preview|verify-dist|production artifact|browser-devtools)\b|request\.get\(\s*['"]\/src\//iu,
})

const PERFORMANCE_PROOF_TITLE_PATTERN =
  /\b(?:linear|quadratic|logarithmic|constant[- ]time|100k|100,?000|million|30m|latency|body i\/o|work count|cost[- ]bounded|without hydrating|cold bod|scales roughly|bounded (?:work|memory|space|state|pages?|progress|prefix|renderer|projection|jobs?|set|snapshot|least|diagnostics?|redaction|aliases|scenarios?|text)|(?:entry|character|publication) budget)\b/iu

export function buildTestEvidenceInventory(root = DEFAULT_ROOT) {
  const moduleInventory = JSON.parse(
    readFileSync(resolve(root, 'scripts/production-module-inventory.json'), 'utf8'),
  )
  const moduleClassifications = canonicalModuleClassifications(moduleInventory)
  const canonicalDomains = new Set(moduleClassifications.values().map((value) => value.domain))
  const ignoredPaths = exactGitIgnoredPaths(root)
  const graphFiles = [
    ...discoverLocalModulePaths({
      root,
      directories: ['src', 'scripts', 'tests'],
      files: ['playwright.config.ts', 'vite.config.ts'],
      extensions: LOCAL_MODULE_CODE_EXTENSIONS,
    }),
  ].filter((path) => !isExactlyGitIgnored(path, ignoredPaths))
  const graph = buildLocalModuleGraph({ root, paths: graphFiles }).dependencies
  const testPaths = [...graphFiles]
    .filter((path) => path.startsWith('tests/'))
    .sort((left, right) => left.localeCompare(right))
  const files = testPaths.map((path) =>
    inventoryTestFile({
      root,
      path,
      graph,
      moduleClassifications,
      declaredDomains: DECLARED_TEST_DOMAINS[path] ?? [],
    }),
  )
  const interactionEvidence = discoverInteractionEvidence(root, files)

  return Object.freeze({
    schemaVersion: 1,
    generatedFrom: Object.freeze({
      testRoot: 'tests',
      productionModuleInventory: 'scripts/production-module-inventory.json',
      declarationManifest: 'scripts/test-evidence-manifest.mjs',
    }),
    signalDisposition:
      'Dimension matches are candidate evidence signals only. Behavioral proof exists only in an explicitly reviewed guarantee claim with an exact locator.',
    evidenceDimensions: TEST_EVIDENCE_DIMENSIONS,
    canonicalDomains: Object.freeze([...canonicalDomains].sort()),
    files: Object.freeze(files),
    interactionEvidence,
    guaranteeClaims: TEST_GUARANTEE_CLAIMS,
  })
}

function exactGitIgnoredPaths(root) {
  return readFileSync(resolve(root, '.gitignore'), 'utf8')
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/^\//u, ''))
    .filter((line) => line !== '' && !line.startsWith('#') && !/[?*[\]\\!]/u.test(line))
}

function isExactlyGitIgnored(path, ignoredPaths) {
  return ignoredPaths.some((ignored) => path === ignored || path.startsWith(`${ignored}/`))
}

function discoverInteractionEvidence(root, testFiles) {
  const candidateTestsByOwner = new Map()
  for (const file of testFiles) {
    if (!['suite', 'embedded-suite'].includes(file.role)) continue
    for (const owner of file.productionOwners.modules) {
      const candidates = candidateTestsByOwner.get(owner) ?? []
      candidates.push(file.path)
      candidateTestsByOwner.set(owner, candidates)
    }
  }
  const sites = []
  for (const directory of ['src/app', 'src/ui']) {
    for (const path of walkFiles(resolve(root, directory), root).filter((candidate) =>
      candidate.endsWith('.tsx'),
    )) {
      const source = readFileSync(resolve(root, path), 'utf8')
      const sourceFile = parseSource(path, source)
      const visit = (node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const hooks = jsxSemanticHooks(node, sourceFile)
          for (const attribute of node.attributes.properties) {
            if (!ts.isJsxAttribute(attribute)) continue
            const event = attribute.name.getText(sourceFile)
            if (!/^on[A-Z]/u.test(event)) continue
            const handler = jsxAttributeExpression(attribute)
            const line =
              sourceFile.getLineAndCharacterOfPosition(attribute.getStart(sourceFile)).line + 1
            sites.push(
              interactionSite({
                path,
                line,
                kind: 'jsx-handler',
                event,
                element: node.tagName.getText(sourceFile),
                owner: findEnclosingOwner(node, sourceFile),
                sourceFingerprint: sourceFingerprint(handler?.getText(sourceFile) ?? ''),
                hooks,
                candidateTests: candidateTestsByOwner.get(path) ?? [],
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
            const line =
              sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
            sites.push(
              interactionSite({
                path,
                line,
                kind: 'dom-listener',
                event: eventNode.text,
                element: node.expression.expression.getText(sourceFile),
                owner: findEnclosingOwner(node, sourceFile),
                sourceFingerprint: sourceFingerprint(node.arguments[1]?.getText(sourceFile) ?? ''),
                hooks: [],
                candidateTests: candidateTestsByOwner.get(path) ?? [],
              }),
            )
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(sourceFile)
    }
  }
  const ordinals = new Map()
  const exactSites = sites.map((site) => {
    const base = `${site.path}#${site.owner}|${site.kind}|${site.event}|${site.element}|${site.sourceFingerprint}`
    const ordinal = (ordinals.get(base) ?? 0) + 1
    ordinals.set(base, ordinal)
    return Object.freeze({ ...site, id: `${base}:${ordinal}` })
  })
  return Object.freeze({
    sites: Object.freeze(exactSites),
    siteCount: exactSites.length,
    sourceCount: new Set(exactSites.map((site) => site.path)).size,
    sourceLevelCandidateCount: exactSites.filter((site) => site.candidateTests.length > 0).length,
    perSiteOutcomeProofCount: 0,
    proofDisposition:
      'Source-level imports and declared behavior-test files are candidate evidence only; no current manifest binds each exact interaction site to an asserted outcome.',
  })
}

function jsxSemanticHooks(node, sourceFile) {
  const hooks = []
  for (const attribute of node.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue
    const name = attribute.name.getText(sourceFile)
    if (!['data-ui', 'data-control', 'data-role', 'aria-label'].includes(name)) continue
    if (attribute.initializer && ts.isStringLiteralLike(attribute.initializer)) {
      hooks.push(`${name}=${attribute.initializer.text}`)
    }
  }
  return uniqueSorted(hooks)
}

function interactionSite({
  path,
  line,
  kind,
  event,
  element,
  owner,
  sourceFingerprint,
  hooks,
  candidateTests,
}) {
  return Object.freeze({
    path,
    line,
    kind,
    event,
    element,
    owner,
    sourceFingerprint,
    semanticHooks: Object.freeze([...hooks]),
    candidateTests: Object.freeze(uniqueSorted(candidateTests)),
  })
}

function jsxAttributeExpression(attribute) {
  return attribute.initializer && ts.isJsxExpression(attribute.initializer)
    ? attribute.initializer.expression
    : undefined
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

function inventoryTestFile({ root, path, graph, moduleClassifications, declaredDomains }) {
  const absolutePath = resolve(root, path)
  const source = readFileSync(absolutePath, 'utf8')
  const sourceFile = parseSource(path, source)
  const definitions = discoverTestDefinitions(sourceFile)
  const isSuitePath = /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
  const role = path.startsWith('tests/fixtures/')
    ? 'fixture'
    : isSuitePath
      ? 'suite'
      : definitions.tests.length > 0
        ? 'embedded-suite'
        : 'support'
  const productionOwners = discoverNearestProductionOwners(path, graph)
  const referencedOwners = discoverReferencedProductionModules(sourceFile, root)
  const ownerModules = uniqueSorted([...productionOwners.paths, ...referencedOwners])
  const exactClassifications = ownerModules
    .map((ownerPath) => moduleClassifications.get(ownerPath))
    .filter(Boolean)
  const exactDomains = uniqueSorted(exactClassifications.map((entry) => entry.domain))
  const domains = uniqueSorted([...exactDomains, ...declaredDomains])
  const domainSource =
    exactDomains.length > 0 && declaredDomains.length > 0
      ? `${productionOwners.source}+declared-manifest`
      : exactDomains.length > 0
        ? productionOwners.source
        : 'declared-manifest'
  const layers = uniqueSorted(exactClassifications.map((entry) => entry.layer))
  const evidenceSignals = discoverEvidenceSignals({ source, definitions })
  const proofKinds = discoverProofKinds(path, source, evidenceSignals)

  return Object.freeze({
    path,
    role,
    execution: executionShape(path, source, role),
    proofKinds: Object.freeze(proofKinds),
    definitions,
    productionOwners: Object.freeze({
      source: productionOwners.source,
      modules: Object.freeze(ownerModules),
      directOrNearestImportModules: Object.freeze(productionOwners.paths),
      exactSourceReferenceModules: Object.freeze(referencedOwners),
    }),
    domains: Object.freeze(domains),
    domainSource,
    layers: Object.freeze(layers),
    evidenceSignals,
    dimensionDispositions: Object.freeze(
      Object.fromEntries(
        TEST_EVIDENCE_DIMENSIONS.map((dimension) => [
          dimension,
          Object.freeze({
            status: evidenceSignals[dimension]
              ? 'candidate-signal'
              : 'not-deterministically-signaled',
          }),
        ]),
      ),
    ),
  })
}

function canonicalModuleClassifications(inventory) {
  const byPath = new Map()
  for (const classification of inventory.classifications ?? []) {
    for (const path of classification.paths ?? []) {
      byPath.set(path, {
        domain: classification.domain,
        layer: classification.layer,
        responsibility: classification.responsibility,
      })
    }
  }
  return byPath
}

function walkFiles(directory, root) {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...walkFiles(absolutePath, root))
    else if (entry.isFile()) paths.push(normalizePath(relative(root, absolutePath)))
  }
  return paths
}

function discoverNearestProductionOwners(startPath, graph) {
  const direct = (graph.get(startPath) ?? []).filter((path) => path.startsWith('src/'))
  if (direct.length > 0) return { source: 'direct-import', paths: uniqueSorted(direct) }
  let frontier = (graph.get(startPath) ?? []).filter((path) => !path.startsWith('src/'))
  const visited = new Set([startPath])
  while (frontier.length > 0) {
    const owners = []
    const next = []
    for (const path of frontier) {
      if (visited.has(path)) continue
      visited.add(path)
      for (const dependency of graph.get(path) ?? []) {
        if (dependency.startsWith('src/')) owners.push(dependency)
        else if (!visited.has(dependency)) next.push(dependency)
      }
    }
    if (owners.length > 0) return { source: 'nearest-helper-import', paths: uniqueSorted(owners) }
    frontier = uniqueSorted(next)
  }
  return { source: 'none', paths: [] }
}

function discoverReferencedProductionModules(sourceFile, root) {
  const references = []
  const visit = (node) => {
    if (ts.isStringLiteralLike(node)) {
      const match = /(?:^|\/)(src\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?)(?:$|[#?:])/u.exec(node.text)
      if (match?.[1] && statSync(resolve(root, match[1]), { throwIfNoEntry: false })?.isFile()) {
        references.push(match[1])
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return uniqueSorted(references)
}

function discoverTestDefinitions(sourceFile) {
  const describes = []
  const tests = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const api = testApiRoot(node.expression)
      if (api && node.arguments.length > 0) {
        const title = testTitle(node.arguments[0], sourceFile)
        if (title) {
          const definition = Object.freeze({
            api,
            title: title.value,
            titleKind: title.kind,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            status: callStatus(node.expression, sourceFile),
            parameterized: node.expression.getText(sourceFile).includes('.each'),
          })
          if (api === 'describe') describes.push(definition)
          else tests.push(definition)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return Object.freeze({ describes: Object.freeze(describes), tests: Object.freeze(tests) })
}

function testApiRoot(expression) {
  if (ts.isIdentifier(expression)) {
    return ['describe', 'it', 'test'].includes(expression.text) ? expression.text : null
  }
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return testApiRoot(expression.expression)
  }
  if (ts.isCallExpression(expression)) return testApiRoot(expression.expression)
  return null
}

function testTitle(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return { kind: 'static', value: node.text }
  if (ts.isNoSubstitutionTemplateLiteral(node)) return { kind: 'static', value: node.text }
  if (ts.isTemplateExpression(node)) {
    return { kind: 'dynamic-template', value: bounded(node.getText(sourceFile), 240) }
  }
  return null
}

function callStatus(expression, sourceFile) {
  const text = expression.getText(sourceFile)
  if (/\.(?:skip|skipIf)\b/u.test(text)) return 'skipped'
  if (/\.todo\b/u.test(text)) return 'todo'
  if (/\.only\b/u.test(text)) return 'only'
  if (/\.(?:fails|failing)\b/u.test(text)) return 'expected-failure'
  return 'active'
}

function discoverEvidenceSignals({ source, definitions }) {
  const titleCorpus = definitions.tests.map((definition) => definition.title)
  const signals = {}
  for (const [dimension, pattern] of Object.entries(DIMENSION_PATTERNS)) {
    const titleMatches = titleCorpus.filter((title) => pattern.test(title))
    pattern.lastIndex = 0
    const sourcePattern = SOURCE_DIMENSION_PATTERNS[dimension]
    const sourceMatch = sourcePattern?.exec(source) ?? null
    if (sourcePattern) sourcePattern.lastIndex = 0
    if (titleMatches.length === 0 && !sourceMatch) continue
    signals[dimension] = Object.freeze({
      titleMatches: Object.freeze(titleMatches),
      sourceLocator: sourceMatch
        ? Object.freeze({
            line: lineAtOffset(source, sourceMatch.index),
            excerpt: bounded(sourceMatch[0], 120),
          })
        : null,
    })
  }
  if (/\.newPage\s*\(/u.test(source)) {
    signals['multi-tab'] = mergePrimitiveSignal(signals['multi-tab'], 'newPage()')
    signals.concurrency = mergePrimitiveSignal(signals.concurrency, 'newPage()')
  }
  if (/visibilitychange|visibilityState/u.test(source)) {
    signals['multi-tab'] = mergePrimitiveSignal(signals['multi-tab'], 'visibility lifecycle')
  }
  if (/indexedDB|IDBDatabase|getDb\s*\(|Dexie/u.test(source)) {
    signals.storage = mergePrimitiveSignal(signals.storage, 'browser database primitive')
  }
  return Object.freeze(signals)
}

function mergePrimitiveSignal(existing, primitive) {
  return Object.freeze({
    titleMatches: existing?.titleMatches ?? Object.freeze([]),
    sourceLocator: existing?.sourceLocator ?? null,
    primitives: Object.freeze(uniqueSorted([...(existing?.primitives ?? []), primitive])),
  })
}

function discoverProofKinds(path, source, evidenceSignals) {
  const kinds = []
  if (path.startsWith('tests/e2e/')) kinds.push('browser')
  else if (path.startsWith('tests/integration/')) kinds.push('integration')
  else if (path.startsWith('tests/live/')) kinds.push('live')
  else if (path.startsWith('tests/unit/')) kinds.push('unit')
  if (
    /(?:audit|boundary|inventory|discipline|generation-path-audit|runtime-resource-manifest|legacy-test-migration-ledger)\.(?:test|spec)\./u.test(
      path,
    ) ||
    /from ['"](?:node:fs|node:path|typescript)|from ['"][^'"]*scripts\/|scripts\/audit-|readFileSync\s*\(/u.test(
      source,
    )
  ) {
    kinds.push('static')
  }
  if (path.includes('live-') || path.includes('-live.') || /\bLIVE\b/u.test(source))
    kinds.push('live')
  if (
    path.includes('performance') ||
    evidenceSignals.performance?.titleMatches.some((title) =>
      PERFORMANCE_PROOF_TITLE_PATTERN.test(title),
    ) ||
    /performance\.now|workCount|100_?000|quadratic|body I\/O|bounded (?:work|space|memory)|linear (?:work|space|total)/iu.test(
      source,
    )
  ) {
    kinds.push('performance')
  }
  return uniqueSorted(kinds)
}

function executionShape(path, source, role) {
  if (role === 'fixture') return 'test-asset'
  if (role === 'support') return path.startsWith('tests/e2e/') ? 'browser-support' : 'test-support'
  if (path.startsWith('tests/e2e/')) return 'chromium-built-preview'
  const pragma = /@vitest-environment\s+([^\s*]+)/u.exec(source)?.[1]
  return `vitest-${pragma ?? 'jsdom'}`
}

function parseSource(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function lineAtOffset(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function bounded(value, length) {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`
}

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}
