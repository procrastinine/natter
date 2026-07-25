import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import productionModuleInventory from './production-module-inventory.json' with { type: 'json' }
import { productionRuntimeEffectReviews } from './production-runtime-effect-review.mjs'
import { validateReviewedCandidateDispositions } from './reviewed-candidate-dispositions.mjs'
import { sourceFingerprint, sourceLineText } from './source-site-identity.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

const DOMAIN_CAPABILITIES = Object.freeze({
  'application-shell': 'shell-interaction',
  attachments: 'attachment-access',
  'build-environment': 'runtime-environment',
  catalog: 'catalog-projection',
  conversation: 'conversation-projection',
  diagnostics: 'diagnostics',
  generation: 'generation-attempt',
  interchange: 'workspace-interchange',
  organization: 'organization-write',
  'presentation-state': 'tab-presentation-state',
  'presentation-system': 'paint-and-scroll',
  'provider-configuration': 'configuration-projection',
  'provider-discovery': 'provider-discovery',
  'provider-io': 'provider-io',
  'schema-evolution': 'schema-upgrade',
  'shared-contracts': 'shared-contract',
  'shared-runtime': 'tab-runtime',
  'storage-administration': 'storage-maintenance',
  workspace: 'workspace-access',
})

const CALL_EFFECTS = Object.freeze({
  addEventListener: effect('event-listener', 'acquire', true),
  cancelAnimationFrame: effect('animation-frame', 'release', false),
  cancelIdleCallback: effect('idle-callback', 'release', false),
  clearInterval: effect('interval', 'release', false),
  clearTimeout: effect('timeout', 'release', false),
  createObjectURL: effect('object-url', 'acquire', true),
  deleteDatabase: effect('indexeddb-administration', 'operation', false),
  fetch: effect('network-request', 'operation', false),
  open: effect('indexeddb-open', 'operation', false),
  queueMicrotask: effect('microtask', 'schedule', false),
  removeEventListener: effect('event-listener', 'release', false),
  requestAnimationFrame: effect('animation-frame', 'acquire', true),
  requestIdleCallback: effect('idle-callback', 'acquire', true),
  revokeObjectURL: effect('object-url', 'release', false),
  setInterval: effect('interval', 'acquire', true),
  setTimeout: effect('timeout', 'schedule', false),
  useEffect: effect('react-effect', 'lifecycle', false),
  useInsertionEffect: effect('react-insertion-effect', 'lifecycle', false),
  useLayoutEffect: effect('react-layout-effect', 'lifecycle', false),
  useSyncExternalStore: effect('external-store-subscription', 'lifecycle', false),
})

const RELEASE_METHODS = Object.freeze({
  abort: 'abort-controller',
  cancel: 'cancelable-resource',
  close: 'closeable-resource',
  disconnect: 'observer',
  removeEventListener: 'event-listener',
  revokeObjectURL: 'object-url',
  terminate: 'worker',
  unsubscribe: 'subscription',
})

const NEW_EFFECTS = Object.freeze({
  AbortController: effect('abort-controller', 'acquire', true),
  BroadcastChannel: effect('broadcast-channel', 'acquire', true),
  EventSource: effect('event-source', 'acquire', true),
  IntersectionObserver: effect('intersection-observer', 'acquire', true),
  MessageChannel: effect('message-channel', 'acquire', true),
  MutationObserver: effect('mutation-observer', 'acquire', true),
  ResizeObserver: effect('resize-observer', 'acquire', true),
  SharedWorker: effect('shared-worker', 'acquire', true),
  WebSocket: effect('web-socket', 'acquire', true),
  Worker: effect('worker', 'acquire', true),
})

const SUBSCRIPTION_NAMES = /^subscribe[A-Z_]/u

export function buildProductionRuntimeEffectInventory(root = DEFAULT_ROOT) {
  const classifications = moduleClassifications()
  const sites = []
  for (const [path, classification] of classifications) {
    const sourceText = readFileSync(resolve(root, path), 'utf8')
    sites.push(...inventoryRuntimeEffectsInSource(path, sourceText, classification))
  }
  sites.sort(compareSites)
  const exactSites = assignStableIds(sites)
  const releasesByPathAndOwner = indexReleaseCandidates(exactSites)
  const withReleaseEvidence = exactSites.map((site) => {
    if (!site.requiresRelease) return Object.freeze({ ...site, releaseEvidence: 'not-required' })
    if (site.ownershipTransfer === 'returned-to-caller') {
      return Object.freeze({ ...site, releaseEvidence: 'delegated-to-caller' })
    }
    const candidates = compatibleReleaseCandidates(site, releasesByPathAndOwner)
    return Object.freeze({
      ...site,
      releaseEvidence: candidates.length > 0 ? 'candidate-only' : 'missing',
      releaseCandidateIds: Object.freeze(candidates.map((candidate) => candidate.id)),
    })
  })
  const syntacticCandidates = withReleaseEvidence.filter(
    (site) => site.requiresRelease && site.releaseEvidence === 'missing',
  )
  const syntacticGaps = syntacticCandidates.map((site) =>
    Object.freeze({
      id: `release-owner-unproved:${site.id}`,
      path: site.path,
      line: site.line,
      rationale: `${site.effectKind} acquisition has no compatible release site in its lexical or module owner.`,
    }),
  )
  const review = validateReviewedCandidateDispositions({
    candidates: syntacticCandidates,
    reviews: productionRuntimeEffectReviews,
    root,
    auditName: 'RuntimeEffect',
    proofRoles: new Set(['terminal-release', 'cancellation-release', 'release-implementation']),
  })
  const reviewsById = new Map(productionRuntimeEffectReviews.map((entry) => [entry.siteId, entry]))
  const gaps = syntacticCandidates
    .filter((site) => reviewsById.get(site.id)?.disposition === 'architecture-gap')
    .map((site) =>
      Object.freeze({
        id: `release-owner-unproved:${site.id}`,
        path: site.path,
        line: site.line,
        rationale: reviewsById.get(site.id).rationale,
      }),
    )
  return Object.freeze({
    schemaVersion: 2,
    disposition:
      'This closes the manually reviewed no-release syntactic candidate queue only. Exact release identities or bounded lifetimes are reviewed evidence, not a claim that the syntax inventory recognizes every possible runtime effect or every semantic terminal path.',
    sites: Object.freeze(withReleaseEvidence),
    syntacticGaps: Object.freeze(syntacticGaps),
    reviews: productionRuntimeEffectReviews,
    reviewProblems: review.problems,
    dispositionCounts: review.dispositionCounts,
    gaps: Object.freeze(gaps),
    counts: Object.freeze({
      sites: withReleaseEvidence.length,
      paths: new Set(withReleaseEvidence.map((site) => site.path)).size,
      acquisitions: withReleaseEvidence.filter((site) => site.action === 'acquire').length,
      releases: withReleaseEvidence.filter((site) => site.action === 'release').length,
      operations: withReleaseEvidence.filter((site) => site.action === 'operation').length,
      schedulers: withReleaseEvidence.filter((site) => site.action === 'schedule').length,
      lifecycles: withReleaseEvidence.filter((site) => site.action === 'lifecycle').length,
      missingReleaseEvidence: syntacticGaps.length,
      reviewedArchitectureGaps: gaps.length,
    }),
    categoryCounts: Object.freeze(countBy(withReleaseEvidence, 'effectKind')),
    domainCounts: Object.freeze(countBy(withReleaseEvidence, 'domain')),
    localityCounts: Object.freeze(countBy(withReleaseEvidence, 'locality')),
  })
}

export function inventoryRuntimeEffectsInSource(path, sourceText, classification) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const sites = []
  const callNodes = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      callNodes.push(node)
      const callee = callName(node.expression)
      const direct =
        callee && Object.hasOwn(CALL_EFFECTS, callee) ? CALL_EFFECTS[callee] : undefined
      if (direct && callMatchesEffect(node, callee)) {
        sites.push(siteForNode(path, source, node, classification, direct, callee))
      } else if (callee && Object.hasOwn(RELEASE_METHODS, callee)) {
        sites.push(
          siteForNode(
            path,
            source,
            node,
            classification,
            effect(RELEASE_METHODS[callee], 'release', false),
            callee,
          ),
        )
      } else if (callee && SUBSCRIPTION_NAMES.test(callee)) {
        sites.push(
          siteForNode(
            path,
            source,
            node,
            classification,
            effect('subscription', 'acquire', true),
            callee,
          ),
        )
      } else if (isNavigatorLockRequest(node)) {
        sites.push(
          siteForNode(
            path,
            source,
            node,
            classification,
            effect('web-lock', 'operation', false),
            'navigator.locks.request',
          ),
        )
      } else if (isIndexedDbDatabases(node)) {
        sites.push(
          siteForNode(
            path,
            source,
            node,
            classification,
            effect('indexeddb-enumeration', 'operation', false),
            'indexedDB.databases',
          ),
        )
      } else if (isStorageManagerCall(node)) {
        sites.push(
          siteForNode(
            path,
            source,
            node,
            classification,
            effect('storage-manager', 'operation', false),
            expressionText(node.expression, source),
          ),
        )
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const contract = Object.hasOwn(NEW_EFFECTS, node.expression.text)
        ? NEW_EFFECTS[node.expression.text]
        : undefined
      if (contract) {
        sites.push(
          siteForNode(path, source, node, classification, contract, `new ${node.expression.text}`),
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  const acquiredBindings = new Set(
    sites
      .filter((site) => site.action === 'acquire' && site.bindingKey)
      .map((site) => site.bindingKey),
  )
  for (const node of callNodes) {
    const invokedBinding = expressionText(node.expression, source).replace(/\?\.$/u, '')
    if (!acquiredBindings.has(invokedBinding)) continue
    sites.push(
      siteForNode(
        path,
        source,
        node,
        classification,
        effect('bound-disposer', 'release', false),
        invokedBinding,
        { releaseBinding: invokedBinding },
      ),
    )
  }
  return assignStableIds(sites)
}

function effect(effectKind, action, requiresRelease) {
  return Object.freeze({ effectKind, action, requiresRelease })
}

function moduleClassifications() {
  const result = new Map()
  for (const classification of productionModuleInventory.classifications) {
    for (const path of classification.paths) {
      if (result.has(path)) throw new Error(`RuntimeEffectModuleClassificationDuplicate:${path}`)
      result.set(
        path,
        Object.freeze({ domain: classification.domain, layer: classification.layer }),
      )
    }
  }
  return result
}

function siteForNode(path, source, node, classification, contract, primitive, overrides = {}) {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source))
  const owner = enclosingOwner(node, source)
  return {
    path,
    line: location.line + 1,
    column: location.character + 1,
    siteText: sourceLineText(source, location.line),
    sourceFingerprint: sourceFingerprint(node.getText(source)),
    owner,
    domain: classification.domain,
    layer: classification.layer,
    capability: DOMAIN_CAPABILITIES[classification.domain],
    locality: localityFor(contract.effectKind, path),
    primitive,
    ownershipTransfer: returnedToCaller(node) ? 'returned-to-caller' : 'local-owner',
    bindingKey: contract.action === 'acquire' ? bindingKeyForAcquisition(node, source) : null,
    releaseBinding: contract.action === 'release' ? releaseBindingForNode(node, source) : null,
    ...contract,
    ...overrides,
  }
}

function bindingKeyForAcquisition(node, source) {
  let current = node
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isAwaitExpression(current.parent))
  ) {
    current = current.parent
  }
  const parent = current.parent
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === current) {
    return parent.name.getText(source)
  }
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === current
  ) {
    return parent.left.getText(source)
  }
  if (parent && ts.isPropertyDeclaration(parent) && parent.initializer === current) {
    return `this.${parent.name.getText(source)}`
  }
  return null
}

function releaseBindingForNode(node, source) {
  if (!ts.isCallExpression(node)) return null
  const callee = callName(node.expression)
  if (
    callee &&
    [
      'cancelAnimationFrame',
      'cancelIdleCallback',
      'clearInterval',
      'clearTimeout',
      'revokeObjectURL',
    ].includes(callee)
  ) {
    return node.arguments[0]?.getText(source) ?? null
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    return node.expression.expression.getText(source)
  }
  const argument = node.arguments[0]
  return argument?.getText(source) ?? null
}

function returnedToCaller(node) {
  let current = node
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isAwaitExpression(current.parent))
  ) {
    current = current.parent
  }
  if (current.parent && ts.isReturnStatement(current.parent)) return true
  return Boolean(
    current.parent && ts.isArrowFunction(current.parent) && current.parent.body === current,
  )
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression)) {
    return expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
      ? expression.argumentExpression.text
      : null
  }
  return null
}

function callMatchesEffect(node, callee) {
  if (callee === 'fetch') return ts.isIdentifier(node.expression)
  if (callee === 'open' || callee === 'deleteDatabase') {
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      expressionText(node.expression.expression, node.getSourceFile()).endsWith('indexedDB')
    )
  }
  return true
}

function isNavigatorLockRequest(node) {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'request' &&
    expressionText(node.expression.expression, node.getSourceFile()).endsWith('navigator.locks')
  )
}

function isIndexedDbDatabases(node) {
  return (
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'databases' &&
    expressionText(node.expression.expression, node.getSourceFile()).endsWith('indexedDB')
  )
}

function isStorageManagerCall(node) {
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  const receiver = expressionText(node.expression.expression, node.getSourceFile())
  return receiver.endsWith('navigator.storage') || receiver.includes('storageBucket')
}

function expressionText(node, source) {
  return node?.getText(source) ?? ''
}

function enclosingOwner(node, source) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(source)
    if (ts.isConstructorDeclaration(current)) return 'constructor'
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parent &&
      ts.isPropertyAssignment(current.parent)
    ) {
      return current.parent.name.getText(source)
    }
    current = current.parent
  }
  return '<module>'
}

function localityFor(effectKind, path) {
  if (['broadcast-channel', 'web-lock'].includes(effectKind)) return 'cross-tab'
  if (effectKind.startsWith('indexeddb') || effectKind === 'storage-manager')
    return 'origin-durable'
  if (
    effectKind === 'network-request' ||
    effectKind === 'event-source' ||
    effectKind === 'web-socket'
  ) {
    return 'external-io'
  }
  if (path.startsWith('src/ui/') || path.startsWith('src/app/')) return 'tab-presentation'
  return 'tab-runtime'
}

function assignStableIds(sites) {
  const ordinals = new Map()
  return sites.map((site) => {
    const stem = `${site.path}#${site.owner}|${site.effectKind}|${site.action}|${site.primitive}|${site.sourceFingerprint}`
    const ordinal = (ordinals.get(stem) ?? 0) + 1
    ordinals.set(stem, ordinal)
    return Object.freeze({ ...site, id: `${stem}|${ordinal}` })
  })
}

function indexReleaseCandidates(sites) {
  const index = new Map()
  for (const site of sites) {
    if (site.action !== 'release') continue
    for (const owner of [site.owner, '<module>']) {
      const key = `${site.path}|${owner}`
      const values = index.get(key) ?? []
      values.push(site)
      index.set(key, values)
    }
    const pathKey = `${site.path}|*`
    const pathValues = index.get(pathKey) ?? []
    pathValues.push(site)
    index.set(pathKey, pathValues)
  }
  return index
}

function compatibleReleaseCandidates(site, index) {
  const candidates = [
    ...(index.get(`${site.path}|${site.owner}`) ?? []),
    ...(index.get(`${site.path}|<module>`) ?? []),
    ...(index.get(`${site.path}|*`) ?? []),
  ]
  return uniqueById(candidates).filter((candidate) => compatibleKinds(site, candidate))
}

function compatibleKinds(acquisition, release) {
  if (release.effectKind === 'bound-disposer') {
    return Boolean(acquisition.bindingKey && acquisition.bindingKey === release.releaseBinding)
  }
  if (
    acquisition.bindingKey &&
    release.releaseBinding &&
    acquisition.bindingKey !== release.releaseBinding
  ) {
    return false
  }
  if (acquisition.effectKind === release.effectKind) return true
  if (acquisition.effectKind.endsWith('-observer') && release.effectKind === 'observer') return true
  if (
    ['broadcast-channel', 'event-source', 'message-channel', 'web-socket'].includes(
      acquisition.effectKind,
    ) &&
    release.effectKind === 'closeable-resource'
  ) {
    return true
  }
  if (
    ['shared-worker', 'worker'].includes(acquisition.effectKind) &&
    release.effectKind === 'worker'
  ) {
    return true
  }
  if (
    ['animation-frame', 'idle-callback', 'subscription', 'external-store-subscription'].includes(
      acquisition.effectKind,
    ) &&
    ['cancelable-resource', 'subscription'].includes(release.effectKind)
  ) {
    return true
  }
  return false
}

function uniqueById(values) {
  return [...new Map(values.map((value) => [value.id, value])).values()]
}

function countBy(values, key) {
  return Object.fromEntries(
    [
      ...values.reduce((counts, value) => {
        const group = value[key]
        counts.set(group, (counts.get(group) ?? 0) + 1)
        return counts
      }, new Map()),
    ].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function compareSites(left, right) {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.effectKind.localeCompare(right.effectKind) ||
    left.primitive.localeCompare(right.primitive)
  )
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.stdout.write(`${JSON.stringify(buildProductionRuntimeEffectInventory(), null, 2)}\n`)
}
