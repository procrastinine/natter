import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { staticAuditState } from './audit-result-state.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_INVENTORY = resolve(ROOT, 'scripts/scroll-continuity-inventory.mjs')
const REQUIRED_WRITER_IDS = Object.freeze([
  'transcript-instant-position',
  'transcript-smooth-bottom',
  'branch-search-result-center',
  'branch-node-center-horizontal',
  'branch-node-center-vertical',
  'branch-pan-horizontal',
  'branch-pan-vertical',
  'sidebar-top-anchor-correction',
  'sidebar-bottom-anchor-correction',
  'sidebar-row-anchor-correction',
  'sidebar-virtual-anchor-fallback',
  'storage-previous-page-origin',
  'storage-next-page-origin',
])
const REQUIRED_HEIGHT_PRODUCER_IDS = Object.freeze([
  'window-prefix-publication',
  'live-stream-content',
  'stream-terminal-renderer-handoff',
  'progressive-static-event-loop-handoff',
  'async-code-highlighting',
  'async-mermaid-render',
  'remote-markdown-image',
  'generated-output-image',
  'generated-output-audio',
  'generated-output-video',
  'attachment-catalog-resolution',
  'reasoning-disclosure',
  'tool-evidence-disclosure',
  'message-info-disclosure',
  'inline-editor-autosize',
  'message-collapse-mode',
  'generation-terminal-notices',
  'content-visibility-realization',
])
const REQUIRED_TRANSITION_IDS = Object.freeze([
  'destination-first-demand',
  'destination-settled-floor-demand',
  'prepend-publication-handshake',
  'prepend-anchor-capture',
  'prepend-anchor-reconcile',
  'auto-top-demand',
  'open-to-leaf',
  'selection-change',
  'reveal-claim-acquire',
  'stream-claim-acquire',
  'reveal-claim-ready',
  'stream-terminal-settle',
  'content-growth-reconciliation',
  'user-follow-cancel',
  'editor-nearest-reveal',
])
const REQUIRED_PROOF_IDS = Object.freeze([
  'destination-first-passive-floor',
  'repeated-mixed-height-prepend',
  'automatic-adjacent-prepend',
  'delayed-layout-prepend',
  'edit-scroll-not-trapped',
  'stream-growth-unit-transition',
  'semantic-prepend-anchor-unit',
  'background-prepend-prepublication-unit',
  'save-send-prepublication-unit',
  'generic-scroll-recorder-contract',
  'single-viewport-continuity-lease-static',
  'filtered-sidebar-semantic-anchor-browser-journey',
  'stream-terminal-continuous-browser',
  'save-send-continuous-browser',
  'generic-automatic-scroll-journeys-browser',
  'height-producer-ownership-matrix-browser',
])
const REQUIRED_GAP_IDS = Object.freeze([])
const REQUIRED_ACCEPTANCE_IDS = Object.freeze([
  'no-unowned-geometry-writers',
  'no-automatic-discontinuity',
  'destination-first-then-passive-floor',
  'unbounded-chat-pagination',
  'user-intent-revokes-follow',
  'stream-terminal-continuity',
  'edit-and-send-continuity',
  'single-transcript-scroll-authority',
])
const VALID_SURFACES = new Set(['transcript', 'branch-tree', 'sidebar', 'storage-table'])
const VALID_TRIGGERS = new Set([
  'automatic-or-explicit',
  'explicit-navigation',
  'explicit-edit',
  'layout-reconciliation',
  'user-gesture',
])
const VALID_CONTINUITY = new Set([
  'semantic-owner-required',
  'explicit-target',
  'nearest-edge',
  'preserve-anchor',
  'reset-origin',
  'user-owned',
])
const VALID_HEIGHT_TIMING = new Set([
  'async-idle',
  'async-resource',
  'browser-layout',
  'data-page',
  'stream',
  'user-control',
])
const VALID_ANCHOR_REQUIREMENTS = new Set([
  'explicit-intent',
  'follow-or-anchor',
  'preserve-anchor',
])
const VALID_HEIGHT_PROOF_MECHANISMS = new Set([
  'async-resource',
  'browser-layout',
  'data-page',
  'stream',
  'user-control',
])
const VALID_TRANSITION_OWNERS = new Set([
  'editor',
  'layout-anchor',
  'selection',
  'stream',
  'transcript-demand',
  'user-intent',
])
const VALID_PROOF_KINDS = new Set([
  'browser',
  'component',
  'geometry',
  'interaction',
  'performance',
  'static',
])
const SCROLL_CALL_NAMES = new Set([
  'scroll',
  'scrollBy',
  'scrollIntoView',
  'scrollTo',
  'scrollToIndex',
  'scrollToOffset',
])
const SCROLL_OFFSET_NAMES = new Set(['scrollLeft', 'scrollTop'])
const ASSIGNMENT_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
])

export function evaluateScrollContinuity(
  root,
  inventoryModule,
  mode = 'inventory',
  initialProblems = [],
) {
  if (mode !== 'inventory' && mode !== 'enforce') {
    throw new Error(`ScrollContinuityAuditModeInvalid:${mode}`)
  }
  const report = auditScrollContinuity(root, inventoryModule, initialProblems)
  const structurallyValid = report.problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || report.gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    discoveredWriterCount: report.discoveredWriterCount,
    writerCount: report.writerCount,
    heightProducerCount: report.heightProducerCount,
    heightProducerProofCount: report.heightProducerProofCount,
    transitionCount: report.transitionCount,
    proofCount: report.proofCount,
    gapCount: report.gaps.length,
    acceptanceCount: report.acceptanceCount,
    gaps: report.gaps,
    problems: report.problems,
  })
}

export function auditScrollContinuity(root, inventoryModule, initialProblems = []) {
  const problems = [...initialProblems]
  const writers = inventoryModule?.SCROLL_WRITER_CLASSIFICATIONS
  const heightProducers = inventoryModule?.TRANSCRIPT_HEIGHT_PRODUCERS
  const heightProducerProofs = inventoryModule?.SCROLL_HEIGHT_PRODUCER_PROOF_MATRIX
  const transitions = inventoryModule?.SCROLL_SEMANTIC_TRANSITIONS
  const proofs = inventoryModule?.SCROLL_EXISTING_PROOFS
  const gaps = inventoryModule?.SCROLL_CONTINUITY_GAPS
  const acceptance = inventoryModule?.SCROLL_CONTINUITY_ACCEPTANCE

  validateExactIds(writers, REQUIRED_WRITER_IDS, 'writers', problems)
  validateExactIds(heightProducers, REQUIRED_HEIGHT_PRODUCER_IDS, 'height-producers', problems)
  validateHeightProducerProofs(heightProducerProofs, heightProducers, proofs, problems)
  validateExactIds(transitions, REQUIRED_TRANSITION_IDS, 'transitions', problems)
  validateExactIds(proofs, REQUIRED_PROOF_IDS, 'proofs', problems)
  validateExactIds(gaps, REQUIRED_GAP_IDS, 'gaps', problems)
  validateExactIds(acceptance, REQUIRED_ACCEPTANCE_IDS, 'acceptance', problems)
  validateSourceLocators(writers, 'writers', root, problems)
  validateSourceLocators(heightProducers, 'height-producers', root, problems)
  validateSourceLocators(transitions, 'transitions', root, problems)
  validateSourceLocators(proofs, 'proofs', root, problems)
  validateSourceLocators(gaps, 'gaps', root, problems)
  validateClassification(writers, 'surface', VALID_SURFACES, problems)
  validateClassification(writers, 'trigger', VALID_TRIGGERS, problems)
  validateClassification(writers, 'continuity', VALID_CONTINUITY, problems)
  validateClassification(heightProducers, 'timing', VALID_HEIGHT_TIMING, problems)
  validateClassification(heightProducers, 'anchorRequirement', VALID_ANCHOR_REQUIREMENTS, problems)
  validateClassification(transitions, 'owner', VALID_TRANSITION_OWNERS, problems)
  validateAcceptance(acceptance, problems)
  validateScrollRegionArchitecture(root, problems)

  const discoveredWriters = discoverScrollWriters(root)
  validateWriterExhaustiveness(root, writers, discoveredWriters, problems)
  const normalizedGaps = Array.isArray(gaps)
    ? gaps
        .filter(isRecord)
        .map((gap) => ({ id: gap.id, path: gap.path, rationale: gap.rationale }))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    : []
  problems.sort()
  return {
    discoveredWriterCount: discoveredWriters.length,
    writerCount: Array.isArray(writers) ? writers.length : 0,
    heightProducerCount: Array.isArray(heightProducers) ? heightProducers.length : 0,
    heightProducerProofCount: Array.isArray(heightProducerProofs) ? heightProducerProofs.length : 0,
    transitionCount: Array.isArray(transitions) ? transitions.length : 0,
    proofCount: Array.isArray(proofs) ? proofs.length : 0,
    acceptanceCount: Array.isArray(acceptance) ? acceptance.length : 0,
    gaps: normalizedGaps,
    problems,
  }
}

function validateHeightProducerProofs(matrix, heightProducers, proofs, problems) {
  if (!Array.isArray(matrix)) {
    problems.push('height-producer-proofs: expected an array')
    return
  }
  const expectedIds = Array.isArray(heightProducers)
    ? heightProducers.filter(isRecord).map((entry) => entry.id)
    : []
  const actualIds = matrix.filter(isRecord).map((entry) => entry.producerId)
  if (new Set(actualIds).size !== actualIds.length) {
    problems.push('height-producer-proofs: duplicate producer id')
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    problems.push('height-producer-proofs: canonical producer order or coverage changed')
  }
  const browserProofIds = new Set(
    Array.isArray(proofs)
      ? proofs
          .filter((entry) => isRecord(entry) && entry.kind === 'browser')
          .map((entry) => entry.id)
      : [],
  )
  for (const entry of matrix) {
    if (!isRecord(entry)) {
      problems.push('height-producer-proofs: entry must be an object')
      continue
    }
    if (!VALID_HEIGHT_PROOF_MECHANISMS.has(entry.mechanism)) {
      problems.push(
        `height-producer-proofs:${String(entry.producerId)}: invalid mechanism: ${String(entry.mechanism)}`,
      )
    }
    for (const field of ['followProofId', 'pinnedProofId']) {
      if (!browserProofIds.has(entry[field])) {
        problems.push(
          `height-producer-proofs:${String(entry.producerId)}: ${field} is not a registered browser proof: ${String(entry[field])}`,
        )
      }
    }
  }
}

function validateScrollRegionArchitecture(root, problems) {
  const scrollRegion = readFileSync(resolve(root, 'src/ui/chat/ScrollRegion.tsx'), 'utf8')
  const conversationController = readFileSync(
    resolve(root, 'src/store/conversation-controller.ts'),
    'utf8',
  )
  const shell = readFileSync(resolve(root, 'src/app/Shell.tsx'), 'utf8')
  const required = [
    'type ViewportDisplacement =',
    'type ViewportContinuityLease =',
    'type SemanticFollowClaim =',
    'const continuityLeaseRef = useRef<ViewportContinuityLease | null>({',
    'const previousLease = continuityLeaseRef.current',
    "previousLease.claim.source === 'stream'",
    "if (documentVisibleRef.current) scheduleFollowReconciliation('resize')",
  ]
  const forbidden = [
    'followOwnershipRef',
    "scrollToFollowPositionNow('visibility')",
    'stateRef.current = state',
  ]
  for (const locator of required) {
    const count = countOccurrences(scrollRegion, locator)
    if (count !== 1) {
      problems.push(
        `architecture: required ScrollRegion invariant occurrences=${count}: ${locator}`,
      )
    }
  }
  for (const locator of forbidden) {
    if (scrollRegion.includes(locator)) {
      problems.push(`architecture: forbidden ScrollRegion authority remains: ${locator}`)
    }
  }
  const preparedPrependCount = countOccurrences(
    conversationController,
    "window.offset < previous.window.offset && nextEnd >= previousEnd ? 'prepend' : 'content'",
  )
  if (preparedPrependCount !== 1) {
    problems.push(
      `architecture: prepared prepend transition occurrences=${preparedPrependCount}; expected=1`,
    )
  }
  const viewportPortCount = countOccurrences(
    shell,
    'scrollRef.current?.prepareLayoutChange(transition)',
  )
  if (viewportPortCount !== 1) {
    problems.push(
      `architecture: viewport preparation port occurrences=${viewportPortCount}; expected=1`,
    )
  }
}

function discoverScrollWriters(root) {
  const sourceRoot = resolve(root, 'src')
  const discoveries = []
  for (const absolute of sourceFiles(sourceRoot)) {
    const path = relative(root, absolute).replaceAll('\\', '/')
    const sourceText = readFileSync(absolute, 'utf8')
    const sourceFile = ts.createSourceFile(
      absolute,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) &&
        SCROLL_OFFSET_NAMES.has(accessName(node.left))
      ) {
        discoveries.push(discovery(path, sourceFile, node, accessName(node.left)))
      }
      if (ts.isCallExpression(node) && SCROLL_CALL_NAMES.has(accessName(node.expression))) {
        discoveries.push(discovery(path, sourceFile, node, accessName(node.expression)))
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return discoveries.sort(
    (left, right) => left.path.localeCompare(right.path) || left.start - right.start,
  )
}

function discovery(path, sourceFile, node, operation) {
  const start = node.getStart(sourceFile)
  const position = sourceFile.getLineAndCharacterOfPosition(start)
  return Object.freeze({
    path,
    start,
    end: node.end,
    operation,
    line: position.line + 1,
    text: node.getText(sourceFile),
  })
}

function accessName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    if (ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text
  }
  return ''
}

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(absolute))
    else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(absolute)
    }
  }
  return files.sort()
}

function validateWriterExhaustiveness(root, entries, discoveries, problems) {
  if (!Array.isArray(entries)) return
  const spans = []
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.path) || !isNonEmptyString(entry.locator)) {
      continue
    }
    const absolute = resolve(root, entry.path)
    if (!existsSync(absolute)) continue
    const source = readFileSync(absolute, 'utf8')
    const start = source.indexOf(entry.locator)
    if (start < 0 || source.indexOf(entry.locator, start + 1) >= 0) continue
    spans.push({ id: entry.id, path: entry.path, start, end: start + entry.locator.length })
  }
  for (const discovery of discoveries) {
    const owners = spans.filter(
      (span) =>
        span.path === discovery.path && span.start <= discovery.start && span.end >= discovery.end,
    )
    if (owners.length === 0) {
      problems.push(
        `writers: unclassified ${discovery.operation} at ${discovery.path}:${discovery.line}: ${singleLine(discovery.text)}`,
      )
    } else if (owners.length > 1) {
      problems.push(
        `writers: multiply classified ${discovery.path}:${discovery.line}: ${owners.map((owner) => owner.id).join(',')}`,
      )
    }
  }
  for (const span of spans) {
    const matched = discoveries.filter(
      (discovery) =>
        discovery.path === span.path && span.start <= discovery.start && span.end >= discovery.end,
    )
    if (matched.length !== 1) {
      problems.push(
        `writers:${span.id}: classified discovered writer count=${matched.length}; expected=1`,
      )
    }
  }
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
    const count = countOccurrences(readFileSync(absolute, 'utf8'), entry.locator)
    if (count !== 1) problems.push(`${prefix}: locator occurrences=${count}; expected=1`)
  }
}

function validateClassification(entries, field, values, problems) {
  if (!Array.isArray(entries)) return
  for (const entry of entries) {
    if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue
    if (!values.has(entry[field])) problems.push(`${entry.id}: invalid ${field}: ${entry[field]}`)
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

function parseArgs(argv) {
  const parsed = { inventory: DEFAULT_INVENTORY, mode: 'inventory', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg !== '--inventory' && arg !== '--mode') {
      throw new Error(`Unknown scroll-continuity argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (arg === '--inventory') parsed.inventory = resolve(value)
    else {
      if (value !== 'inventory' && value !== 'enforce') {
        throw new Error(`Invalid scroll-continuity mode: ${value}`)
      }
      parsed.mode = value
    }
    index += 1
  }
  return parsed
}

function difference(left, right) {
  const accepted = new Set(right)
  return [...new Set(left.filter((value) => !accepted.has(value)))].sort()
}

function duplicates(values) {
  const seen = new Set()
  const found = new Set()
  for (const value of values) {
    if (seen.has(value)) found.add(value)
    seen.add(value)
  }
  return [...found].sort()
}

function countOccurrences(source, locator) {
  let count = 0
  let offset = 0
  while (true) {
    const index = source.indexOf(locator, offset)
    if (index < 0) return count
    count += 1
    offset = index + Math.max(1, locator.length)
  }
}

function isExactRepoPath(value) {
  return !isAbsolute(value) && !value.startsWith('../') && !value.includes('\\')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function singleLine(value) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2))
  let inventory = null
  const importProblems = []
  try {
    inventory = await import(`${pathToFileURL(args.inventory).href}?audit=${Date.now()}`)
  } catch (error) {
    importProblems.push(`inventory: ${errorText(error)}`)
  }
  const output = evaluateScrollContinuity(ROOT, inventory, args.mode, importProblems)
  process.stdout.write(`${JSON.stringify(output, null, args.json ? 2 : 0)}\n`)
  if (!output.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runCli()
}
