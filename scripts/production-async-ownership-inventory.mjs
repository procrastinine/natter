import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { productionAsyncOwnershipReviews } from './production-async-ownership-review.mjs'
import productionModuleInventory from './production-module-inventory.json' with { type: 'json' }
import { validateReviewedCandidateDispositions } from './reviewed-candidate-dispositions.mjs'
import { sourceFingerprint, sourceLineText } from './source-site-identity.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const CALLBACK_CONSUMERS = new Set([
  'addEventListener',
  'forEach',
  'requestAnimationFrame',
  'requestIdleCallback',
  'setInterval',
  'setTimeout',
  'subscribe',
])

export function buildProductionAsyncOwnershipInventory(root = DEFAULT_ROOT) {
  const functions = []
  const detached = []
  for (const [path, classification] of moduleClassifications()) {
    const sourceText = readFileSync(resolve(root, path), 'utf8')
    const inventory = inventoryAsyncOwnershipInSource(path, sourceText, classification)
    functions.push(...inventory.functions)
    detached.push(...inventory.detached)
  }
  functions.sort(compareLocations)
  detached.sort(compareLocations)
  const exactFunctions = assignIds(functions, 'async-function')
  const knownAsyncNames = new Set(
    exactFunctions.map((entry) => entry.owner).filter((name) => !name.startsWith('<')),
  )
  const exactDetached = assignIds(
    detached.filter(
      (site) =>
        site.kind !== 'void-detached' ||
        site.explicitPromiseSyntax ||
        (site.calleeName !== null && knownAsyncNames.has(site.calleeName)),
    ),
    'detached-promise',
  )
  const syntacticCandidates = exactDetached.filter((site) => site.failureOwnership === 'unproved')
  const syntacticGaps = syntacticCandidates.map((site) =>
    Object.freeze({
      id: `detached-failure-owner-unproved:${site.id}`,
      path: site.path,
      line: site.line,
      rationale: `${site.kind} has no syntactic rejection or local error owner.`,
    }),
  )
  const review = validateReviewedCandidateDispositions({
    candidates: syntacticCandidates,
    reviews: productionAsyncOwnershipReviews,
    root,
    auditName: 'AsyncOwnership',
    proofRoles: new Set([
      'error-owner',
      'non-rejecting-construction',
      'non-rejecting-transform',
      'non-throwing-finalizer',
    ]),
  })
  const reviewsById = new Map(productionAsyncOwnershipReviews.map((entry) => [entry.siteId, entry]))
  const gaps = syntacticCandidates
    .filter((site) => reviewsById.get(site.id)?.disposition === 'architecture-gap')
    .map((site) =>
      Object.freeze({
        id: `detached-failure-owner-unproved:${site.id}`,
        path: site.path,
        line: site.line,
        rationale: reviewsById.get(site.id).rationale,
      }),
    )
  return Object.freeze({
    schemaVersion: 2,
    disposition:
      'This closes the manually reviewed detached-failure syntactic candidate queue only. Exact error owners and non-rejecting identity flows are reviewed evidence, not a claim that the syntax inventory recognizes every detached promise or proves semantic rollback and liveness.',
    functions: Object.freeze(exactFunctions),
    detached: Object.freeze(exactDetached),
    syntacticGaps: Object.freeze(syntacticGaps),
    reviews: productionAsyncOwnershipReviews,
    reviewProblems: review.problems,
    dispositionCounts: review.dispositionCounts,
    gaps: Object.freeze(gaps),
    counts: Object.freeze({
      functions: exactFunctions.length,
      awaitSites: exactFunctions.reduce((sum, entry) => sum + entry.awaitSites.length, 0),
      functionsWithCatch: exactFunctions.filter((entry) => entry.errorStrategy.includes('catch'))
        .length,
      functionsWithFinally: exactFunctions.filter((entry) => entry.hasFinally).length,
      cancellationAwareFunctions: exactFunctions.filter((entry) => entry.cancellationAware).length,
      awaitInLoopSites: exactFunctions.reduce((sum, entry) => sum + entry.awaitInLoopCount, 0),
      detachedSites: exactDetached.length,
      unprovedDetachedFailures: syntacticGaps.length,
      reviewedArchitectureGaps: gaps.length,
    }),
    errorStrategyCounts: Object.freeze(countBy(exactFunctions, 'errorStrategy')),
    detachedKindCounts: Object.freeze(countBy(exactDetached, 'kind')),
    domainCounts: Object.freeze(countBy(exactFunctions, 'domain')),
  })
}

export function inventoryAsyncOwnershipInSource(path, sourceText, classification) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const functions = []
  const detached = []
  const visit = (node) => {
    if (isFunctionLike(node)) {
      const summary = summarizeFunction(node, source, path, classification)
      if (summary) functions.push(summary)
    }
    const detachedSite = detachedPromiseSite(node, source, path, classification)
    if (detachedSite) detached.push(detachedSite)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return {
    functions: assignIds(functions, 'async-function'),
    detached: assignIds(detached, 'detached-promise'),
  }
}

function summarizeFunction(node, source, path, classification) {
  if (!node.body) return null
  const awaitSites = []
  let catchCount = 0
  let hasFinally = false
  let assignmentCount = 0
  let assignmentBeforeFirstAwait = 0
  let assignmentAfterFirstAwait = 0
  let awaitInLoopCount = 0
  let firstAwaitPosition = Number.POSITIVE_INFINITY
  const scan = (current, loopDepth = 0) => {
    if (current !== node && isFunctionLike(current)) return
    const nextLoopDepth = isLoop(current) ? loopDepth + 1 : loopDepth
    if (ts.isAwaitExpression(current)) {
      const location = source.getLineAndCharacterOfPosition(current.getStart(source))
      const position = current.getStart(source)
      firstAwaitPosition = Math.min(firstAwaitPosition, position)
      if (loopDepth > 0) awaitInLoopCount += 1
      awaitSites.push(
        Object.freeze({
          line: location.line + 1,
          column: location.character + 1,
          expression: summarizeExpression(current.expression, source),
          loopDepth,
          caughtLocally: hasCatchAncestorWithin(current, node),
          finalizedLocally: hasFinallyAncestorWithin(current, node),
        }),
      )
    }
    if (ts.isTryStatement(current)) {
      if (current.catchClause) catchCount += 1
      if (current.finallyBlock) hasFinally = true
    }
    if (isMutationExpression(current)) {
      assignmentCount += 1
      if (current.getStart(source) < firstAwaitPosition) assignmentBeforeFirstAwait += 1
      else assignmentAfterFirstAwait += 1
    }
    ts.forEachChild(current, (child) => scan(child, nextLoopDepth))
  }
  scan(node.body)
  const asyncModifier = hasModifier(node, ts.SyntaxKind.AsyncKeyword)
  if (!asyncModifier && awaitSites.length === 0) return null
  const location = source.getLineAndCharacterOfPosition(node.getStart(source))
  const cancellationAware = functionCancellationAware(node, source)
  return {
    path,
    line: location.line + 1,
    column: location.character + 1,
    siteText: sourceLineText(source, location.line),
    owner: functionName(node, source),
    exported: functionExported(node),
    asyncModifier,
    domain: classification.domain,
    layer: classification.layer,
    awaitSites: Object.freeze(awaitSites),
    awaitInLoopCount,
    catchCount,
    hasFinally,
    errorStrategy:
      catchCount > 0 && hasFinally
        ? 'local-catch-and-finally'
        : catchCount > 0
          ? 'local-catch'
          : hasFinally
            ? 'propagate-with-finally'
            : 'propagate',
    cancellationAware,
    assignmentCount,
    assignmentBeforeFirstAwait,
    assignmentAfterFirstAwait,
  }
}

function detachedPromiseSite(node, source, path, classification) {
  if (ts.isVoidExpression(node) && isPromiseShapedExpression(node.expression)) {
    const handled = expressionHasRejectionOwner(node.expression)
    return locationRecord(node, source, path, classification, {
      kind: 'void-detached',
      expression: summarizeExpression(node.expression, source),
      calleeName: deepestCallName(node.expression),
      explicitPromiseSyntax: expressionHasPromiseSyntax(node.expression),
      failureOwnership: handled ? 'syntactic-handler' : 'unproved',
    })
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Promise' &&
    node.arguments?.[0] &&
    isAsyncFunction(node.arguments[0])
  ) {
    return locationRecord(node, source, path, classification, {
      kind: 'async-promise-executor',
      expression: 'new Promise(async ...)',
      calleeName: 'Promise',
      explicitPromiseSyntax: true,
      failureOwnership: 'unproved',
    })
  }
  if (!ts.isCallExpression(node)) return null
  const callbackConsumer = callName(node.expression)
  if (!callbackConsumer || !CALLBACK_CONSUMERS.has(callbackConsumer)) return null
  const asyncCallback = node.arguments.find(isAsyncFunction)
  if (!asyncCallback) return null
  const locallyHandled = functionBodyHasCatch(asyncCallback)
  return locationRecord(node, source, path, classification, {
    kind: `${callbackConsumer}-async-callback`,
    expression: summarizeExpression(node, source),
    calleeName: callbackConsumer,
    explicitPromiseSyntax: true,
    failureOwnership: locallyHandled ? 'syntactic-handler' : 'unproved',
  })
}

function expressionHasPromiseSyntax(expression) {
  let current = unwrapExpression(expression)
  while (ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      if (['catch', 'finally', 'then'].includes(current.expression.name.text)) return true
      if (
        ts.isIdentifier(current.expression.expression) &&
        current.expression.expression.text === 'Promise'
      ) {
        return true
      }
      current = unwrapExpression(current.expression.expression)
      continue
    }
    return ts.isIdentifier(current.expression) && current.expression.text === 'Promise'
  }
  return (
    ts.isNewExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === 'Promise'
  )
}

function deepestCallName(expression) {
  let current = unwrapExpression(expression)
  while (ts.isCallExpression(current)) {
    if (ts.isIdentifier(current.expression)) return current.expression.text
    if (ts.isPropertyAccessExpression(current.expression)) {
      current = unwrapExpression(current.expression.expression)
      continue
    }
    return null
  }
  return null
}

function expressionHasRejectionOwner(expression) {
  let current = unwrapExpression(expression)
  while (ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      const name = current.expression.name.text
      if (name === 'catch') return current.arguments.length > 0
      if (name === 'then' && current.arguments.length > 1) return true
      current = unwrapExpression(current.expression.expression)
      continue
    }
    break
  }
  return false
}

function functionBodyHasCatch(node) {
  if (!node.body || !ts.isBlock(node.body)) return false
  let found = false
  const visit = (current) => {
    if (found || (current !== node && isFunctionLike(current))) return
    if (ts.isTryStatement(current) && current.catchClause) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node.body)
  return found
}

function functionCancellationAware(node, source) {
  const parameters = node.parameters.map((parameter) => parameter.getText(source)).join(' ')
  if (/\b(?:AbortSignal|AbortController|signal)\b/u.test(parameters)) return true
  const body = node.body?.getText(source) ?? ''
  return /\b(?:AbortSignal|AbortController|signal\.aborted|throwIfAborted)\b/u.test(body)
}

function hasCatchAncestorWithin(node, boundary) {
  let current = node.parent
  while (current && current !== boundary) {
    if (
      ts.isTryStatement(current) &&
      current.tryBlock.pos <= node.pos &&
      current.tryBlock.end >= node.end
    ) {
      return Boolean(current.catchClause)
    }
    current = current.parent
  }
  return false
}

function hasFinallyAncestorWithin(node, boundary) {
  let current = node.parent
  while (current && current !== boundary) {
    if (
      ts.isTryStatement(current) &&
      current.tryBlock.pos <= node.pos &&
      current.tryBlock.end >= node.end
    ) {
      return Boolean(current.finallyBlock)
    }
    current = current.parent
  }
  return false
}

function isMutationExpression(node) {
  if (ts.isBinaryExpression(node)) {
    return (
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
  }
  return ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)
}

function isLoop(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  )
}

function isPromiseShapedExpression(node) {
  const current = unwrapExpression(node)
  return (
    ts.isCallExpression(current) ||
    ts.isNewExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isConditionalExpression(current)
  )
}

function unwrapExpression(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function isAsyncFunction(node) {
  return isFunctionLike(node) && hasModifier(node, ts.SyntaxKind.AsyncKeyword)
}

function hasModifier(node, kind) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === kind))
}

function functionExported(node) {
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) return true
  let current = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (ts.isVariableStatement(current)) return hasModifier(current, ts.SyntaxKind.ExportKeyword)
    current = current.parent
  }
  return false
}

function functionName(node, source) {
  if ('name' in node && node.name) return node.name.getText(source)
  const parent = node.parent
  if (parent && ts.isVariableDeclaration(parent)) return parent.name.getText(source)
  if (parent && ts.isPropertyAssignment(parent)) return parent.name.getText(source)
  if (parent && ts.isCallExpression(parent))
    return `<callback:${callName(parent.expression) ?? 'call'}>`
  return '<anonymous>'
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return null
}

function summarizeExpression(node, source) {
  const text = node.getText(source).replace(/\s+/gu, ' ').trim()
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`
}

function locationRecord(node, source, path, classification, values) {
  const location = source.getLineAndCharacterOfPosition(node.getStart(source))
  return {
    path,
    line: location.line + 1,
    column: location.character + 1,
    siteText: sourceLineText(source, location.line),
    sourceFingerprint: sourceFingerprint(node.getText(source)),
    domain: classification.domain,
    layer: classification.layer,
    owner: enclosingFunctionName(node, source),
    ...values,
  }
}

function enclosingFunctionName(node, source) {
  let current = node.parent
  while (current) {
    if (isFunctionLike(current)) return functionName(current, source)
    current = current.parent
  }
  return '<module>'
}

function moduleClassifications() {
  const result = new Map()
  for (const classification of productionModuleInventory.classifications) {
    for (const path of classification.paths) {
      if (result.has(path)) throw new Error(`AsyncOwnershipModuleClassificationDuplicate:${path}`)
      result.set(path, { domain: classification.domain, layer: classification.layer })
    }
  }
  return result
}

function assignIds(entries, kind) {
  const ordinals = new Map()
  return entries.map((entry) => {
    const fingerprint =
      entry.sourceFingerprint ?? sourceFingerprint(`${entry.owner}|${entry.siteText ?? ''}`)
    const stem = `${entry.path}#${entry.owner}|${kind}|${fingerprint}`
    const ordinal = (ordinals.get(stem) ?? 0) + 1
    ordinals.set(stem, ordinal)
    return Object.freeze({ ...entry, id: `${stem}|${ordinal}` })
  })
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

function compareLocations(left, right) {
  return left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.stdout.write(`${JSON.stringify(buildProductionAsyncOwnershipInventory(), null, 2)}\n`)
}
