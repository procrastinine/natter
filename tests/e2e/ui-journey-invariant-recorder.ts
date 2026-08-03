import type { Page } from '@playwright/test'

export type UiJourneyViolationCode =
  | 'acquire-bottom-discontinuity'
  | 'acquire-bottom-forbidden-alignment'
  | 'acquire-bottom-reversal'
  | 'acquire-bottom-unfulfilled'
  | 'covered-gesture'
  | 'count-regression'
  | 'critical-control-disappeared'
  | 'critical-control-inert'
  | 'critical-control-missing'
  | 'double-gesture'
  | 'focus-continuity-lost'
  | 'follow-bottom-discontinuity'
  | 'follow-bottom-not-at-bottom'
  | 'gesture-delivery-mismatch'
  | 'gesture-outcome-unfulfilled'
  | 'prepend-anchor-discontinuity'
  | 'prepend-anchor-lost'
  | 'route-change-without-intent'
  | 'route-intent-mismatch'
  | 'route-intent-unfulfilled'
  | 'selection-continuity-lost'
  | 'semantic-claim-mismatch'
  | 'semantic-node-remount'
  | 'semantic-surface-cardinality'
  | 'shell-blank'
  | 'shell-inert'
  | 'shell-loading-exposed'
  | 'shell-missing'
  | 'transcript-message-remount'
  | 'transcript-prefix-loss'
  | 'visibility-resume-discontinuity'

export type UiJourneyValueClaim =
  | { kind: 'exact'; value: string }
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'stable' }

export interface UiJourneyShellConfig {
  selector: string
  contentSelector?: string
  contentSelectors?: readonly string[]
  loadingSelectors?: readonly string[]
  requireVisible?: boolean
  forbidInert?: boolean
  preserveIdentityAcrossVisibility?: boolean
}

export interface UiJourneySemanticNodeConfig {
  id: string
  selector: string
  activeWhenSelector?: string
  cardinality?: 'singleton' | 'keyed'
  keyAttribute?: string
  preserveKeys?: boolean
  preserveIdentity?: boolean
  preserveAcrossVisibility?: boolean
  required?: boolean
  requireVisible?: boolean
  requireInteractive?: boolean
  text?: UiJourneyValueClaim
  attributes?: Readonly<Record<string, UiJourneyValueClaim>>
  properties?: Readonly<Partial<Record<'checked' | 'value', UiJourneyValueClaim>>>
  resetOnRouteChange?: boolean
}

export interface UiJourneySurfaceExpectation {
  selector: string
  requireVisible?: boolean
  requireInteractive?: boolean
  text?: UiJourneyValueClaim
  attributes?: Readonly<Record<string, UiJourneyValueClaim>>
  properties?: Readonly<Partial<Record<'checked' | 'value', UiJourneyValueClaim>>>
}

export interface UiJourneyCountSurfaceConfig {
  id: string
  itemSelector: string
  activeWhenSelector?: string
  rootSelector?: string
  minimum?: number
  monotonic?: 'nondecreasing' | 'nonincreasing'
  resetOnRouteChange?: boolean
}

export interface UiJourneyTranscriptConfig {
  rootSelector: string
  itemSelector: string
  idAttribute: string
  maxTrackedItems?: number
  preserveMessageIdentity?: boolean
  preservePrefix?: boolean
  stablePrefixTailAllowance?: number
  resetOnRouteChange?: boolean
  scrollSelector?: string
  boundedPrefixEviction?: {
    countSurfaceId: string
    renderedCountAttribute: string
    totalCountAttribute: string
  }
  boundedVirtualResidency?: {
    renderedCountAttribute: string
    virtualizedAttribute: string
  }
}

export interface UiJourneyInvariantRecorderConfig {
  sampleLimit?: number
  transitionLimit?: number
  violationLimit?: number
  geometryPrecisionPx?: number
  defaultScrollTolerancePx?: number
  shell?: UiJourneyShellConfig
  semanticNodes?: readonly UiJourneySemanticNodeConfig[]
  countSurfaces?: readonly UiJourneyCountSurfaceConfig[]
  transcript?: UiJourneyTranscriptConfig
}

export interface UiJourneyRouteExpectation {
  kind: 'exact' | 'prefix' | 'includes'
  value: string
}

export type UiJourneyIntent =
  | {
      kind: 'route'
      id: string
      expected?: UiJourneyRouteExpectation
    }
  | {
      kind: 'gesture'
      id: string
      targetSelector: string
      allowRepeat?: boolean
      allowsRouteChange?: boolean
      expectedRoute?: UiJourneyRouteExpectation
      eventType?: string
      expectedDeliveries?: number
      outcome?: UiJourneySurfaceExpectation
    }
  | {
      kind: 'follow-bottom'
      id: string
      scrollSelector?: string
      tolerancePx?: number
    }
  | {
      kind: 'acquire-bottom'
      id: string
      scrollSelector?: string
      tolerancePx?: number
      rejectAlignmentSelector?: string
    }
  | {
      kind: 'focus-continuity'
      id: string
      selector?: string
      preserveSelection?: boolean
    }
  | {
      kind: 'prepend-anchor'
      id: string
      anchorSelector?: string
      scrollSelector?: string
      tolerancePx?: number
    }
  | {
      kind: 'transcript-replace-after'
      id: string
      messageId: string
    }

export interface UiJourneyCompactNode {
  id: number
  visible: boolean
  disabled: boolean
  rect: readonly [number, number, number, number]
}

export interface UiJourneySample {
  sequence: number
  at: number
  label?: string
  reasons: readonly string[]
  route: string
  shell: UiJourneyCompactNode | null
  controls: Readonly<Record<string, UiJourneyCompactNode | null>>
  counts: Readonly<Record<string, number>>
  transcript: {
    rootId: number
    count: number
    messageIds: readonly string[]
    presentationKind: string | null
    virtualWindowId: number | null
    truncated: boolean
    renderedCount: number | null
    totalCount: number | null
    virtualized: boolean
  } | null
  scroll: {
    nodeId: number
    top: number
    height: number
    viewport: number
    fromBottom: number
  } | null
}

export interface UiJourneyTransition {
  sequence: number
  at: number
  changes: readonly string[]
}

export interface UiJourneyViolation {
  sequence: number
  at: number
  code: UiJourneyViolationCode
  subject: string
  detail: string
}

export interface UiJourneyInvariantReport {
  armed: boolean
  stopped: boolean
  droppedSamples: number
  droppedTransitions: number
  droppedViolations: number
  samples: readonly UiJourneySample[]
  transitions: readonly UiJourneyTransition[]
  violations: readonly UiJourneyViolation[]
}

interface BrowserRecorderApi {
  arm(label?: string): Promise<UiJourneyInvariantReport>
  markIntent(intent: UiJourneyIntent): void
  snapshot(label?: string, completeIntents?: boolean): Promise<UiJourneyInvariantReport>
  report(): UiJourneyInvariantReport
  stop(label?: string): Promise<UiJourneyInvariantReport>
  __disposeNow(): void
}

interface UiJourneyWindow extends Window {
  __uiJourneyInvariantRecorder?: BrowserRecorderApi
}

interface UiJourneySnapshotOptions {
  completeIntents?: boolean
}

type FocusSelectionSnapshot =
  | {
      kind: 'control'
      start: number | null
      end: number | null
      direction: string | null
    }
  | {
      kind: 'document'
      anchorNode: Node | null
      anchorOffset: number
      focusNode: Node | null
      focusOffset: number
    }

export async function installUiJourneyInvariantRecorder(
  page: Page,
  config: UiJourneyInvariantRecorderConfig,
): Promise<void> {
  await page.addInitScript(installUiJourneyInvariantRecorderInPage, config)
  if (page.url() !== 'about:blank') {
    await page.evaluate(installUiJourneyInvariantRecorderInPage, config)
  }
}

export async function armUiJourneyInvariantRecorder(
  page: Page,
  label?: string,
): Promise<UiJourneyInvariantReport> {
  return page.evaluate(async (armLabel) => {
    const recorder = (window as UiJourneyWindow).__uiJourneyInvariantRecorder
    if (!recorder) throw new Error('UiJourneyInvariantRecorderNotInstalled')
    return recorder.arm(armLabel)
  }, label)
}

export async function markUiJourneyIntent(page: Page, intent: UiJourneyIntent): Promise<void> {
  await page.evaluate((nextIntent) => {
    const recorder = (window as UiJourneyWindow).__uiJourneyInvariantRecorder
    if (!recorder) throw new Error('UiJourneyInvariantRecorderNotInstalled')
    recorder.markIntent(nextIntent)
  }, intent)
}

export async function snapshotUiJourneyInvariants(
  page: Page,
  label?: string,
  options: UiJourneySnapshotOptions = {},
): Promise<UiJourneyInvariantReport> {
  return page.evaluate(
    async ({ completeIntents, snapshotLabel }) => {
      const recorder = (window as UiJourneyWindow).__uiJourneyInvariantRecorder
      if (!recorder) throw new Error('UiJourneyInvariantRecorderNotInstalled')
      return recorder.snapshot(snapshotLabel, completeIntents)
    },
    { completeIntents: options.completeIntents ?? true, snapshotLabel: label },
  )
}

export async function stopUiJourneyInvariantRecorder(
  page: Page,
  label = 'stop',
): Promise<UiJourneyInvariantReport> {
  return page.evaluate(async (stopLabel) => {
    const recorder = (window as UiJourneyWindow).__uiJourneyInvariantRecorder
    if (!recorder) throw new Error('UiJourneyInvariantRecorderNotInstalled')
    return recorder.stop(stopLabel)
  }, label)
}

export function formatUiJourneyViolations(report: UiJourneyInvariantReport): string {
  if (report.violations.length === 0) return 'No UI journey invariant violations'
  return report.violations
    .map(
      (violation) =>
        `${violation.sequence}. ${violation.code}/${violation.subject}: ${violation.detail}`,
    )
    .join('\n')
}

export function installUiJourneyInvariantRecorderInPage(
  input: UiJourneyInvariantRecorderConfig,
): void {
  const owner = window as UiJourneyWindow
  owner.__uiJourneyInvariantRecorder?.__disposeNow()

  const config = {
    sampleLimit: Math.max(1, input.sampleLimit ?? 240),
    transitionLimit: Math.max(1, input.transitionLimit ?? 160),
    violationLimit: Math.max(1, input.violationLimit ?? 80),
    geometryPrecisionPx: Math.max(0.1, input.geometryPrecisionPx ?? 0.5),
    defaultScrollTolerancePx: Math.max(0, input.defaultScrollTolerancePx ?? 4),
    shell: input.shell,
    semanticNodes: input.semanticNodes ?? [],
    countSurfaces: input.countSurfaces ?? [],
    transcript: input.transcript,
  }
  const nodeIds = new WeakMap<Node, number>()
  const semanticNodes = new Map<string, Element>()
  const semanticConfigs = new Map<string, UiJourneySemanticNodeConfig>()
  const claimBaselines = new Map<string, string>()
  const messageNodes = new Map<string, Element>()
  const messageTops = new Map<string, number>()
  const messageWrappers = new Map<string, Element>()
  const messageWrapperIndices = new Map<string, string | null>()
  const priorCounts = new Map<string, number>()
  const pendingGestures = new Map<
    string,
    {
      intent: Extract<UiJourneyIntent, { kind: 'gesture' }>
      target: Element | null
      deliveries: number
      eventType: string
      listener: EventListener
    }
  >()
  const pendingRoutes: Array<{
    id: string
    expected?: UiJourneyRouteExpectation
  }> = []
  let followIntent:
    | {
        id: string
        node: HTMLElement
        tolerance: number
      }
    | undefined
  let prependIntent:
    | {
        id: string
        anchor: Element
        anchorId: number
        top: number
        tolerance: number
      }
    | undefined
  let acquireBottomIntent:
    | {
        id: string
        node: HTMLElement | null
        selector: string
        tolerance: number
        initialTop: number
        lastDistance: number
        started: boolean
        acquired: boolean
        rejectedAlignment: Element | null
        rejectedAlignmentSelector?: string
      }
    | undefined
  let transcriptReplacementIntent:
    | {
        id: string
        messageId: string
      }
    | undefined
  let focusIntent:
    | {
        id: string
        element: Element
        elementId: number
        selection: FocusSelectionSnapshot | null
        preserveSelection: boolean
      }
    | undefined
  let hiddenBaseline:
    | {
        shell: Element | null
        controls: Map<string, Element>
      }
    | undefined
  let resumeBaseline:
    | {
        shell: Element | null
        controls: Map<string, Element>
      }
    | undefined
  const samples: UiJourneySample[] = []
  const transitions: UiJourneyTransition[] = []
  const violations: UiJourneyViolation[] = []
  const dirtyReasons = new Set<string>()
  const sampleWaiters: Array<{
    completeIntents: boolean
    label?: string
    resolve: (report: UiJourneyInvariantReport) => void
  }> = []
  let nextNodeId = 1
  let sequence = 0
  let droppedSamples = 0
  let droppedTransitions = 0
  let droppedViolations = 0
  let animationFrame: number | undefined
  let hiddenCheckpointPending = false
  let armed = false
  let stopped = false
  let priorSample: UiJourneySample | undefined
  let activeViolationKeys = new Set<string>()
  let mutationObserver: MutationObserver | undefined
  let resizeObserver: ResizeObserver | undefined
  let observationActive = false

  const round = (value: number) =>
    Math.round(value / config.geometryPrecisionPx) * config.geometryPrecisionPx
  const route = () => `${location.pathname}${location.search}${location.hash}`
  const nodeId = (node: Node) => {
    const known = nodeIds.get(node)
    if (known !== undefined) return known
    const id = nextNodeId
    nextNodeId += 1
    nodeIds.set(node, id)
    return id
  }
  const pushBounded = <T>(values: T[], value: T, limit: number, onDrop: () => void) => {
    if (values.length === limit) {
      values.shift()
      onDrop()
    }
    values.push(value)
  }
  const compactNode = (element: Element): UiJourneyCompactNode => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    const html = element as HTMLElement
    const disabled =
      ('disabled' in html && Boolean((html as HTMLButtonElement).disabled)) ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.closest('[inert]') !== null
    return {
      id: nodeId(element),
      visible:
        element.isConnected &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0,
      disabled,
      rect: [round(rect.x), round(rect.y), round(rect.width), round(rect.height)],
    }
  }
  const isInteractive = (element: Element, compact = compactNode(element)) =>
    compact.visible && !compact.disabled && getComputedStyle(element).pointerEvents !== 'none'
  const fingerprint = (value: string) => {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return `${value.length}:${(hash >>> 0).toString(16).padStart(8, '0')}`
  }
  const textFingerprint = (element: Element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let length = 0
    let hash = 0x811c9dc5
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? ''
      length += value.length
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
      }
    }
    return `${length}:${(hash >>> 0).toString(16).padStart(8, '0')}`
  }
  const textEquals = (element: Element, expected: string) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let offset = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue ?? ''
      if (expected.slice(offset, offset + value.length) !== value) return false
      offset += value.length
      if (offset > expected.length) return false
    }
    return offset === expected.length
  }
  const hasText = (element: Element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if ((node.nodeValue ?? '').length > 0) return true
    }
    return false
  }
  const summarizeKey = (value: string) =>
    value.length <= 96 ? value : `fingerprint:${fingerprint(value)}`
  const readIntegerAttribute = (element: Element, attribute: string | undefined) => {
    if (!attribute) return null
    const raw = element.getAttribute(attribute)
    if (raw === null || !/^(?:0|[1-9]\d*)$/u.test(raw)) return null
    const value = Number(raw)
    return Number.isSafeInteger(value) ? value : null
  }
  const claimMatches = (
    claim: UiJourneyValueClaim,
    value: string | null,
    stableKey: string,
    valueFingerprint: () => string,
  ) => {
    if (claim.kind === 'present') return value !== null
    if (claim.kind === 'absent') return value === null
    if (claim.kind === 'exact') return value === claim.value
    const current = valueFingerprint()
    const baseline = claimBaselines.get(stableKey)
    if (baseline === undefined) {
      claimBaselines.set(stableKey, current)
      return true
    }
    return baseline === current
  }
  const inspectClaims = (
    seen: Set<string>,
    subject: string,
    element: Element,
    text: UiJourneyValueClaim | undefined,
    attributes: Readonly<Record<string, UiJourneyValueClaim>> | undefined,
    properties: Readonly<Partial<Record<'checked' | 'value', UiJourneyValueClaim>>> | undefined,
    violationCode: Extract<
      UiJourneyViolationCode,
      'semantic-claim-mismatch' | 'gesture-outcome-unfulfilled'
    >,
  ) => {
    if (text) {
      const matches =
        text.kind === 'exact'
          ? textEquals(element, text.value)
          : text.kind === 'present'
            ? hasText(element)
            : text.kind === 'absent'
              ? !hasText(element)
              : claimMatches(text, '', `${subject}:text`, () => textFingerprint(element))
      if (!matches) {
        recordViolation(
          seen,
          violationCode,
          subject,
          `text ${text.kind} claim failed (${textFingerprint(element)})`,
        )
      }
    }
    for (const [attribute, claim] of Object.entries(attributes ?? {})) {
      const value = element.getAttribute(attribute)
      if (
        !claimMatches(claim, value, `${subject}:attribute:${attribute}`, () =>
          fingerprint(value ?? ''),
        )
      ) {
        recordViolation(
          seen,
          violationCode,
          subject,
          `${attribute} ${claim.kind} claim failed (${fingerprint(value ?? '')})`,
        )
      }
    }
    for (const [property, claim] of Object.entries(properties ?? {})) {
      const value =
        property === 'checked' && element instanceof HTMLInputElement
          ? String(element.checked)
          : property === 'value' &&
              (element instanceof HTMLInputElement ||
                element instanceof HTMLTextAreaElement ||
                element instanceof HTMLSelectElement)
            ? element.value
            : null
      if (
        !claimMatches(claim, value, `${subject}:property:${property}`, () =>
          fingerprint(value ?? ''),
        )
      ) {
        recordViolation(
          seen,
          violationCode,
          subject,
          `${property} ${claim.kind} claim failed (${fingerprint(value ?? '')})`,
        )
      }
    }
  }
  const scrollSnapshot = (element: HTMLElement) => ({
    nodeId: nodeId(element),
    top: round(element.scrollTop),
    height: round(element.scrollHeight),
    viewport: round(element.clientHeight),
    fromBottom: round(element.scrollHeight - element.scrollTop - element.clientHeight),
  })
  const report = (): UiJourneyInvariantReport => ({
    armed,
    stopped,
    droppedSamples,
    droppedTransitions,
    droppedViolations,
    samples: [...samples],
    transitions: [...transitions],
    violations: [...violations],
  })
  const recordViolation = (
    seen: Set<string>,
    code: UiJourneyViolationCode,
    subject: string,
    detail: string,
  ) => {
    const key = `${code}:${subject}`
    seen.add(key)
    if (activeViolationKeys.has(key)) return
    pushBounded(
      violations,
      { sequence, at: round(performance.now()), code, subject, detail },
      config.violationLimit,
      () => {
        droppedViolations += 1
      },
    )
  }
  const recordImmediateViolation = (
    code: UiJourneyViolationCode,
    subject: string,
    detail: string,
  ) => {
    const seen = new Set(activeViolationKeys)
    activeViolationKeys.delete(`${code}:${subject}`)
    recordViolation(seen, code, subject, detail)
    activeViolationKeys = seen
  }
  const matchesRoute = (value: string, expected: UiJourneyRouteExpectation) => {
    if (expected.kind === 'exact') return value === expected.value
    if (expected.kind === 'prefix') return value.startsWith(expected.value)
    return value.includes(expected.value)
  }
  const resetRouteScopedBaselines = () => {
    for (const [logicalId, item] of semanticConfigs) {
      if (item.resetOnRouteChange ?? true) {
        semanticNodes.delete(logicalId)
        semanticConfigs.delete(logicalId)
      }
    }
    claimBaselines.clear()
    for (const surface of config.countSurfaces) {
      if (surface.resetOnRouteChange ?? true) priorCounts.delete(surface.id)
    }
    if (config.transcript?.resetOnRouteChange ?? true) {
      messageNodes.clear()
      messageWrappers.clear()
      messageWrapperIndices.clear()
    }
  }
  const inspectRouteChange = (seen: Set<string>, previous: string, current: string) => {
    if (previous === current) return false
    const intent = pendingRoutes.shift()
    if (!intent) {
      recordViolation(seen, 'route-change-without-intent', 'route', `${previous} -> ${current}`)
    } else if (intent.expected && !matchesRoute(current, intent.expected)) {
      recordViolation(
        seen,
        'route-intent-mismatch',
        intent.id,
        `expected ${intent.expected.kind}:${intent.expected.value}, received ${current}`,
      )
    }
    resetRouteScopedBaselines()
    return true
  }
  const inspectShell = (seen: Set<string>) => {
    if (!config.shell) return null
    const shell = document.querySelector(config.shell.selector)
    if (!shell) {
      recordViolation(seen, 'shell-missing', config.shell.selector, 'shell is not mounted')
      return null
    }
    const compact = compactNode(shell)
    if ((config.shell.requireVisible ?? true) && !compact.visible) {
      recordViolation(seen, 'shell-blank', config.shell.selector, 'shell is not visible')
    }
    const contentSelectors = [
      ...(config.shell.contentSelector ? [config.shell.contentSelector] : []),
      ...(config.shell.contentSelectors ?? []),
    ]
    if (
      contentSelectors.length > 0 &&
      !contentSelectors.some((selector) => {
        const content = shell.querySelector(selector)
        return content ? compactNode(content).visible : false
      })
    ) {
      recordViolation(
        seen,
        'shell-blank',
        config.shell.selector,
        `none of ${contentSelectors.join(', ')} is visible`,
      )
    }
    for (const loadingSelector of config.shell.loadingSelectors ?? []) {
      const visibleLoadingSurface = Array.from(shell.querySelectorAll(loadingSelector)).some(
        (element) => compactNode(element).visible,
      )
      if (visibleLoadingSurface) {
        recordViolation(
          seen,
          'shell-loading-exposed',
          loadingSelector,
          'loading surface became visible while the journey was armed',
        )
      }
    }
    if (config.shell.forbidInert ?? true) {
      const style = getComputedStyle(shell)
      if (
        shell.hasAttribute('inert') ||
        shell.getAttribute('aria-busy') === 'true' ||
        shell.getAttribute('data-interactive') === 'false' ||
        style.pointerEvents === 'none'
      ) {
        recordViolation(seen, 'shell-inert', config.shell.selector, 'shell rejects interaction')
      }
    }
    return compact
  }
  const inspectSemanticNodes = (seen: Set<string>) => {
    const controls: Record<string, UiJourneyCompactNode | null> = {}
    for (const item of config.semanticNodes) {
      const previousEntries = [...semanticConfigs.entries()].filter(([, owner]) => owner === item)
      const active = !item.activeWhenSelector || document.querySelector(item.activeWhenSelector)
      if (!active) {
        for (const [logicalId] of previousEntries) {
          semanticNodes.delete(logicalId)
          semanticConfigs.delete(logicalId)
        }
        continue
      }
      const cardinality = item.cardinality ?? 'singleton'
      const matches = Array.from(document.querySelectorAll(item.selector))
      if (cardinality === 'singleton' && matches.length > 1) {
        recordViolation(
          seen,
          'semantic-surface-cardinality',
          item.id,
          `${matches.length} nodes matched singleton ${item.selector}`,
        )
      }
      if (cardinality === 'keyed' && !item.keyAttribute) {
        recordViolation(
          seen,
          'semantic-surface-cardinality',
          item.id,
          'keyed surface has no keyAttribute',
        )
      }
      const candidates = cardinality === 'singleton' ? matches.slice(0, 1) : matches
      const currentLogicalIds = new Set<string>()
      const rawKeys = new Set<string>()
      for (const current of candidates) {
        const rawKey =
          cardinality === 'keyed' ? current.getAttribute(item.keyAttribute ?? '') : null
        if (cardinality === 'keyed' && rawKey === null) {
          recordViolation(
            seen,
            'semantic-surface-cardinality',
            item.id,
            `${item.selector} node is missing ${item.keyAttribute}`,
          )
          continue
        }
        if (rawKey !== null && rawKeys.has(rawKey)) {
          recordViolation(
            seen,
            'semantic-surface-cardinality',
            item.id,
            `duplicate ${item.keyAttribute} fingerprint ${fingerprint(rawKey)}`,
          )
          continue
        }
        if (rawKey !== null) rawKeys.add(rawKey)
        const logicalId = rawKey === null ? item.id : `${item.id}[${summarizeKey(rawKey)}]`
        if (currentLogicalIds.has(logicalId)) {
          recordViolation(
            seen,
            'semantic-surface-cardinality',
            item.id,
            `key collision ${logicalId}`,
          )
          continue
        }
        currentLogicalIds.add(logicalId)
        const compact = compactNode(current)
        controls[logicalId] = compact
        const previous = semanticNodes.get(logicalId)
        if ((item.requireVisible ?? true) && !compact.visible) {
          recordViolation(
            seen,
            'critical-control-disappeared',
            logicalId,
            `${item.selector} is hidden`,
          )
        }
        if (item.requireInteractive && !isInteractive(current, compact)) {
          recordViolation(
            seen,
            'critical-control-inert',
            logicalId,
            `${item.selector} rejects interaction`,
          )
        }
        if ((item.preserveIdentity ?? true) && previous && previous !== current) {
          recordViolation(
            seen,
            'semantic-node-remount',
            logicalId,
            `${nodeId(previous)} -> ${nodeId(current)}`,
          )
        }
        inspectClaims(
          seen,
          logicalId,
          current,
          item.text,
          item.attributes,
          item.properties,
          'semantic-claim-mismatch',
        )
        semanticNodes.set(logicalId, current)
        semanticConfigs.set(logicalId, item)
      }
      if (currentLogicalIds.size === 0 && (item.required ?? true)) {
        recordViolation(
          seen,
          previousEntries.length > 0 ? 'critical-control-disappeared' : 'critical-control-missing',
          item.id,
          item.selector,
        )
        controls[item.id] = null
      }
      for (const [logicalId] of previousEntries) {
        if (currentLogicalIds.has(logicalId)) continue
        if (item.preserveKeys) {
          recordViolation(
            seen,
            'critical-control-disappeared',
            logicalId,
            `${item.selector} key disappeared`,
          )
        }
        semanticNodes.delete(logicalId)
        semanticConfigs.delete(logicalId)
      }
    }
    return controls
  }
  const inspectCounts = (seen: Set<string>, boundedPrefixEviction: boolean) => {
    const counts: Record<string, number> = {}
    for (const surface of config.countSurfaces) {
      if (surface.activeWhenSelector && !document.querySelector(surface.activeWhenSelector)) {
        continue
      }
      const root = surface.rootSelector ? document.querySelector(surface.rootSelector) : document
      const count = root?.querySelectorAll(surface.itemSelector).length ?? 0
      counts[surface.id] = count
      const prior = priorCounts.get(surface.id)
      const regression =
        prior !== undefined &&
        ((surface.monotonic === 'nondecreasing' && count < prior) ||
          (surface.monotonic === 'nonincreasing' && count > prior))
      const evictionOwnsRegression =
        boundedPrefixEviction &&
        config.transcript?.boundedPrefixEviction?.countSurfaceId === surface.id
      if (regression && !evictionOwnsRegression) {
        recordViolation(
          seen,
          'count-regression',
          surface.id,
          `${prior} -> ${count} (${surface.monotonic})`,
        )
      }
      if (surface.minimum !== undefined && count < surface.minimum) {
        recordViolation(
          seen,
          'count-regression',
          surface.id,
          `${count} is below minimum ${surface.minimum}`,
        )
      }
      priorCounts.set(surface.id, count)
    }
    return counts
  }
  const inspectTranscript = (seen: Set<string>, resetComparison: boolean) => {
    if (!config.transcript) {
      return { transcript: null, scroll: null, boundedPrefixEviction: false }
    }
    const root = document.querySelector(config.transcript.rootSelector)
    if (!root) return { transcript: null, scroll: null, boundedPrefixEviction: false }
    const all = Array.from(root.querySelectorAll(config.transcript.itemSelector))
    const maxTrackedItems = Math.max(1, config.transcript.maxTrackedItems ?? 256)
    const allIds: string[] = []
    const seenIds = new Set<string>()
    for (const element of all) {
      const id = element.getAttribute(config.transcript.idAttribute)
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      allIds.push(id)
    }
    const tracked = all.slice(0, maxTrackedItems)
    const currentNodes = new Map<string, Element>()
    const messageIds: string[] = []
    for (const element of tracked) {
      const id = element.getAttribute(config.transcript.idAttribute)
      if (!id || currentNodes.has(id)) continue
      currentNodes.set(id, element)
      messageIds.push(id)
    }
    const scroll = config.transcript.scrollSelector
      ? document.querySelector<HTMLElement>(config.transcript.scrollSelector)
      : null
    const scrollState = scroll ? scrollSnapshot(scroll) : null
    const renderedCount = readIntegerAttribute(
      root,
      config.transcript.boundedPrefixEviction?.renderedCountAttribute,
    )
    const totalCount = readIntegerAttribute(
      root,
      config.transcript.boundedPrefixEviction?.totalCountAttribute,
    )
    const virtualized =
      config.transcript.boundedVirtualResidency !== undefined &&
      root.getAttribute(config.transcript.boundedVirtualResidency.virtualizedAttribute) === 'true'
    const residencyRenderedCount = readIntegerAttribute(
      root,
      config.transcript.boundedVirtualResidency?.renderedCountAttribute,
    )
    const boundedVirtualResidency =
      virtualized && residencyRenderedCount !== null && residencyRenderedCount >= all.length
    const presentationKind = root.getAttribute('data-presentation-kind')
    const virtualWindow = root.querySelector('[data-ui="message-virtual-window"]')
    const virtualWindowId = virtualWindow ? nodeId(virtualWindow) : null
    const previousTranscript = priorSample?.transcript
    const previousIds = previousTranscript?.messageIds ?? []
    const evictedRowCount = previousIds.length - messageIds.length
    const retainedAnchorId = messageIds[0]
    const retainedAnchor = retainedAnchorId ? currentNodes.get(retainedAnchorId) : undefined
    const previousAnchor = retainedAnchorId ? messageNodes.get(retainedAnchorId) : undefined
    const previousAnchorTop = retainedAnchorId ? messageTops.get(retainedAnchorId) : undefined
    const retainedAnchorTop = retainedAnchor?.getBoundingClientRect().top
    const tolerance = config.defaultScrollTolerancePx
    const boundedPrefixEviction =
      !resetComparison &&
      config.transcript.boundedPrefixEviction !== undefined &&
      previousTranscript !== null &&
      previousTranscript !== undefined &&
      priorSample?.scroll !== null &&
      priorSample?.scroll !== undefined &&
      scrollState !== null &&
      previousTranscript.rootId === nodeId(root) &&
      priorSample.scroll.nodeId === scrollState.nodeId &&
      !previousTranscript.truncated &&
      all.length === messageIds.length &&
      evictedRowCount > 0 &&
      messageIds.length > 0 &&
      previousIds.slice(evictedRowCount).every((id, index) => id === messageIds[index]) &&
      renderedCount === all.length &&
      previousTranscript.renderedCount === previousTranscript.count &&
      totalCount !== null &&
      totalCount === previousTranscript.totalCount &&
      retainedAnchor !== undefined &&
      retainedAnchor === previousAnchor &&
      previousAnchorTop !== undefined &&
      retainedAnchorTop !== undefined &&
      Math.abs(retainedAnchorTop - previousAnchorTop) <= tolerance
    const replacementIndex = transcriptReplacementIntent
      ? previousIds.indexOf(transcriptReplacementIntent.messageId)
      : -1
    if (
      (config.transcript.preservePrefix ?? true) &&
      !resetComparison &&
      !boundedPrefixEviction &&
      !boundedVirtualResidency
    ) {
      const allowance = Math.max(0, config.transcript.stablePrefixTailAllowance ?? 0)
      const stable =
        replacementIndex >= 0
          ? previousIds.slice(0, replacementIndex)
          : previousIds.slice(0, Math.max(0, previousIds.length - allowance))
      let cursor = 0
      for (const id of stable) {
        const found = allIds.indexOf(id, cursor)
        if (found < 0) {
          recordViolation(
            seen,
            'transcript-prefix-loss',
            id,
            `stable message missing from ${allIds.length} mounted rows`,
          )
          break
        }
        cursor = found + 1
      }
    }
    if (config.transcript.preserveMessageIdentity ?? true) {
      for (const [id, element] of currentNodes) {
        const previous = messageNodes.get(id)
        const previousWrapper = messageWrappers.get(id)
        const currentWrapper = element.closest('[data-ui="message-virtual-row"]')
        const previousWrapperIndex = messageWrapperIndices.get(id) ?? null
        const currentWrapperIndex = currentWrapper?.getAttribute('data-index') ?? null
        const replacementOwnsIdentity =
          replacementIndex >= 0 && previousIds.slice(replacementIndex).includes(id)
        if (previous && previous !== element && !replacementOwnsIdentity) {
          recordViolation(
            seen,
            'transcript-message-remount',
            id,
            `${nodeId(previous)} -> ${nodeId(element)}; wrapper ${previousWrapper ? nodeId(previousWrapper) : 0}@${previousWrapperIndex ?? 'none'} -> ${currentWrapper ? nodeId(currentWrapper) : 0}@${currentWrapperIndex ?? 'none'}; window ${previousTranscript?.virtualWindowId ?? 0} -> ${virtualWindowId ?? 0}; root ${previousTranscript?.rootId ?? 0} -> ${nodeId(root)}; presentation ${previousTranscript?.presentationKind ?? 'none'} -> ${presentationKind ?? 'none'}; virtualized ${previousTranscript?.virtualized === true ? 'true' : 'false'} -> ${virtualized ? 'true' : 'false'}; rendered ${previousTranscript?.renderedCount ?? 'none'} -> ${renderedCount ?? 'none'}`,
          )
        }
      }
    }
    messageNodes.clear()
    messageTops.clear()
    messageWrappers.clear()
    messageWrapperIndices.clear()
    for (const [id, element] of currentNodes) {
      messageNodes.set(id, element)
      messageTops.set(id, element.getBoundingClientRect().top)
      const wrapper = element.closest('[data-ui="message-virtual-row"]')
      if (wrapper) {
        messageWrappers.set(id, wrapper)
        messageWrapperIndices.set(id, wrapper.getAttribute('data-index'))
      }
    }
    return {
      transcript: {
        rootId: nodeId(root),
        count: all.length,
        messageIds,
        presentationKind,
        virtualWindowId,
        truncated: all.length > tracked.length,
        renderedCount,
        totalCount,
        virtualized,
      },
      scroll: scrollState,
      boundedPrefixEviction,
    }
  }
  const inspectScrollIntents = (seen: Set<string>) => {
    if (followIntent) {
      if (!followIntent.node.isConnected) {
        recordViolation(
          seen,
          'follow-bottom-discontinuity',
          followIntent.id,
          'scroll node was replaced',
        )
      } else {
        const distance =
          followIntent.node.scrollHeight -
          followIntent.node.scrollTop -
          followIntent.node.clientHeight
        if (distance > followIntent.tolerance) {
          recordViolation(
            seen,
            'follow-bottom-discontinuity',
            followIntent.id,
            `${round(distance)}px from bottom; tolerance ${followIntent.tolerance}px`,
          )
        }
      }
    }
    if (prependIntent) {
      if (!prependIntent.anchor.isConnected) {
        recordViolation(
          seen,
          'prepend-anchor-lost',
          prependIntent.id,
          `node ${prependIntent.anchorId} disconnected`,
        )
      } else {
        const top = prependIntent.anchor.getBoundingClientRect().top
        const delta = Math.abs(top - prependIntent.top)
        if (delta > prependIntent.tolerance) {
          recordViolation(
            seen,
            'prepend-anchor-discontinuity',
            prependIntent.id,
            `${round(delta)}px displacement; tolerance ${prependIntent.tolerance}px`,
          )
        }
      }
    }
    if (acquireBottomIntent) {
      const intent = acquireBottomIntent
      if (!intent.node) {
        intent.node = document.querySelector<HTMLElement>(intent.selector)
        if (intent.node) {
          intent.initialTop = intent.node.scrollTop
          intent.lastDistance =
            intent.node.scrollHeight - intent.node.scrollTop - intent.node.clientHeight
          intent.started = intent.lastDistance <= intent.tolerance
          intent.acquired = intent.started
          intent.rejectedAlignment = intent.rejectedAlignmentSelector
            ? document.querySelector(intent.rejectedAlignmentSelector)
            : null
        }
      }
      if (!intent.node) return
      if (!intent.node.isConnected) {
        recordViolation(seen, 'acquire-bottom-discontinuity', intent.id, 'scroll node was replaced')
        return
      }
      const top = intent.node.scrollTop
      const distance = intent.node.scrollHeight - top - intent.node.clientHeight
      const started =
        intent.started ||
        Math.abs(top - intent.initialTop) > intent.tolerance ||
        distance < intent.lastDistance - intent.tolerance
      if (started && !intent.acquired && distance > intent.lastDistance + intent.tolerance) {
        recordViolation(
          seen,
          'acquire-bottom-reversal',
          intent.id,
          `distance from bottom reversed ${round(intent.lastDistance)} -> ${round(distance)}`,
        )
      }
      if (started && !intent.acquired && intent.rejectedAlignment?.isConnected) {
        const scrollTop = intent.node.getBoundingClientRect().top
        const targetTop = intent.rejectedAlignment.getBoundingClientRect().top
        if (Math.abs(targetTop - scrollTop) <= intent.tolerance) {
          recordViolation(
            seen,
            'acquire-bottom-forbidden-alignment',
            intent.id,
            `${round(targetTop)}px aligned with rejected target instead of the requested bottom`,
          )
        }
      }
      if (distance <= intent.tolerance) intent.acquired = true
      if (intent.acquired && distance > intent.tolerance) {
        recordViolation(
          seen,
          'acquire-bottom-discontinuity',
          intent.id,
          `${round(distance)}px from bottom after acquisition; tolerance ${intent.tolerance}px`,
        )
      }
      intent.started = started
      intent.lastDistance = distance
    }
  }
  const captureFocusSelection = (element: Element): FocusSelectionSnapshot | null => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return {
        kind: 'control',
        start: element.selectionStart,
        end: element.selectionEnd,
        direction: element.selectionDirection,
      }
    }
    const selection = document.getSelection()
    if (!selection) return null
    const anchorElement =
      selection.anchorNode instanceof Element
        ? selection.anchorNode
        : selection.anchorNode?.parentElement
    const focusElement =
      selection.focusNode instanceof Element
        ? selection.focusNode
        : selection.focusNode?.parentElement
    if (
      (!anchorElement || !element.contains(anchorElement)) &&
      (!focusElement || !element.contains(focusElement))
    ) {
      return null
    }
    return {
      kind: 'document',
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
    }
  }
  const selectionMatches = (
    before: FocusSelectionSnapshot | null,
    after: FocusSelectionSnapshot | null,
  ) => {
    if (before === null || after === null) return before === after
    if (before.kind !== after.kind) return false
    if (before.kind === 'control' && after.kind === 'control') {
      return (
        before.start === after.start &&
        before.end === after.end &&
        before.direction === after.direction
      )
    }
    if (before.kind === 'document' && after.kind === 'document') {
      return (
        before.anchorNode === after.anchorNode &&
        before.anchorOffset === after.anchorOffset &&
        before.focusNode === after.focusNode &&
        before.focusOffset === after.focusOffset
      )
    }
    return false
  }
  const inspectFocusIntent = (seen: Set<string>) => {
    if (!focusIntent) return
    if (!focusIntent.element.isConnected || document.activeElement !== focusIntent.element) {
      recordViolation(
        seen,
        'focus-continuity-lost',
        focusIntent.id,
        `expected node ${focusIntent.elementId}, active node ${document.activeElement ? nodeId(document.activeElement) : 0}`,
      )
      return
    }
    if (
      focusIntent.preserveSelection &&
      !selectionMatches(focusIntent.selection, captureFocusSelection(focusIntent.element))
    ) {
      recordViolation(
        seen,
        'selection-continuity-lost',
        focusIntent.id,
        `selection changed on node ${focusIntent.elementId}`,
      )
    }
  }
  const inspectVisibilityResume = (seen: Set<string>) => {
    if (!resumeBaseline) return
    if ((config.shell?.preserveIdentityAcrossVisibility ?? true) && resumeBaseline.shell) {
      const current = config.shell ? document.querySelector(config.shell.selector) : null
      if (
        current !== resumeBaseline.shell ||
        !resumeBaseline.shell.isConnected ||
        !compactNode(resumeBaseline.shell).visible
      ) {
        recordViolation(
          seen,
          'visibility-resume-discontinuity',
          'shell',
          `expected node ${nodeId(resumeBaseline.shell)}, resumed node ${current ? nodeId(current) : 0}`,
        )
      }
    }
    for (const [logicalId, previous] of resumeBaseline.controls) {
      const item = semanticConfigs.get(logicalId)
      if (!(item?.preserveAcrossVisibility ?? item?.preserveIdentity ?? true)) continue
      const current = semanticNodes.get(logicalId)
      if (current !== previous || !previous.isConnected || !compactNode(previous).visible) {
        recordViolation(
          seen,
          'visibility-resume-discontinuity',
          logicalId,
          `expected node ${nodeId(previous)}, resumed node ${current ? nodeId(current) : 0}`,
        )
      }
    }
    resumeBaseline = undefined
  }
  const transitionChanges = (previous: UiJourneySample, current: UiJourneySample) => {
    const changes: string[] = []
    if (previous.route !== current.route) changes.push(`route:${previous.route}->${current.route}`)
    if (previous.shell?.id !== current.shell?.id) {
      changes.push(`shell:${previous.shell?.id ?? 0}->${current.shell?.id ?? 0}`)
    }
    for (const id of Object.keys(current.controls)) {
      const before = previous.controls[id]
      const after = current.controls[id]
      if (
        before?.id !== after?.id ||
        before?.visible !== after?.visible ||
        before?.disabled !== after?.disabled
      ) {
        changes.push(
          `control:${id}:${before?.id ?? 0}/${before?.visible ? 1 : 0}/${before?.disabled ? 1 : 0}->${after?.id ?? 0}/${after?.visible ? 1 : 0}/${after?.disabled ? 1 : 0}`,
        )
      }
    }
    for (const [id, count] of Object.entries(current.counts)) {
      if (previous.counts[id] !== count) {
        changes.push(`count:${id}:${previous.counts[id] ?? 0}->${count}`)
      }
    }
    if (previous.transcript?.count !== current.transcript?.count) {
      changes.push(
        `transcript:${previous.transcript?.count ?? 0}->${current.transcript?.count ?? 0}`,
      )
    }
    if (previous.scroll && current.scroll) {
      if (previous.scroll.fromBottom !== current.scroll.fromBottom) {
        changes.push(`bottom:${previous.scroll.fromBottom}->${current.scroll.fromBottom}`)
      }
      if (previous.scroll.top !== current.scroll.top) {
        changes.push(`scroll:${previous.scroll.top}->${current.scroll.top}`)
      }
    }
    return changes.slice(0, 32)
  }
  const completePendingIntents = (geometrySettled: boolean) => {
    const seen = new Set(activeViolationKeys)
    for (const pending of pendingGestures.values()) {
      const expectedDeliveries = Math.max(0, pending.intent.expectedDeliveries ?? 1)
      if (pending.deliveries !== expectedDeliveries) {
        recordViolation(
          seen,
          'gesture-delivery-mismatch',
          pending.intent.id,
          `${pending.eventType} delivered ${pending.deliveries} times; expected ${expectedDeliveries}`,
        )
      }
      const outcome = pending.intent.outcome
      if (outcome) {
        const element = document.querySelector(outcome.selector)
        if (!element) {
          recordViolation(
            seen,
            'gesture-outcome-unfulfilled',
            pending.intent.id,
            `${outcome.selector} missing`,
          )
        } else {
          const compact = compactNode(element)
          if ((outcome.requireVisible ?? true) && !compact.visible) {
            recordViolation(
              seen,
              'gesture-outcome-unfulfilled',
              pending.intent.id,
              `${outcome.selector} is hidden`,
            )
          }
          if (outcome.requireInteractive && !isInteractive(element, compact)) {
            recordViolation(
              seen,
              'gesture-outcome-unfulfilled',
              pending.intent.id,
              `${outcome.selector} rejects interaction`,
            )
          }
          inspectClaims(
            seen,
            pending.intent.id,
            element,
            outcome.text,
            outcome.attributes,
            outcome.properties,
            'gesture-outcome-unfulfilled',
          )
        }
      }
      document.removeEventListener(pending.eventType, pending.listener, true)
    }
    pendingGestures.clear()
    followIntent = undefined
    prependIntent = undefined
    if (acquireBottomIntent) {
      const node = acquireBottomIntent.node
      const distance = node ? node.scrollHeight - node.scrollTop - node.clientHeight : Infinity
      if (
        !node?.isConnected ||
        !acquireBottomIntent.acquired ||
        (geometrySettled && distance > acquireBottomIntent.tolerance)
      ) {
        recordViolation(
          seen,
          'acquire-bottom-unfulfilled',
          acquireBottomIntent.id,
          node?.isConnected
            ? `${round(distance)}px from bottom; tolerance ${acquireBottomIntent.tolerance}px`
            : 'scroll node was never acquired',
        )
      }
    }
    acquireBottomIntent = undefined
    transcriptReplacementIntent = undefined
    focusIntent = undefined
    for (const intent of pendingRoutes.splice(0)) {
      recordViolation(
        seen,
        'route-intent-unfulfilled',
        intent.id,
        intent.expected
          ? `${intent.expected.kind}:${intent.expected.value}`
          : 'no route change observed before checkpoint',
      )
    }
    activeViolationKeys = seen
  }
  const takeSample = () => {
    animationFrame = undefined
    if (stopped || !armed) return
    sequence += 1
    const seen = new Set<string>()
    const reasons = [...dirtyReasons].slice(0, 8)
    dirtyReasons.clear()
    const currentRoute = route()
    const routeChanged = priorSample
      ? inspectRouteChange(seen, priorSample.route, currentRoute)
      : false
    const shell = inspectShell(seen)
    const controls = inspectSemanticNodes(seen)
    const { transcript, scroll, boundedPrefixEviction } = inspectTranscript(seen, routeChanged)
    const counts = inspectCounts(seen, boundedPrefixEviction)
    const geometrySettled =
      !routeChanged && !reasons.includes('mutation') && reasons.some((reason) => reason !== 'route')
    if (geometrySettled) {
      inspectScrollIntents(seen)
    }
    inspectFocusIntent(seen)
    inspectVisibilityResume(seen)
    const waiterLabel = sampleWaiters.find((waiter) => waiter.label)?.label
    const sample: UiJourneySample = {
      sequence,
      at: round(performance.now()),
      ...(waiterLabel === undefined ? {} : { label: waiterLabel }),
      reasons,
      route: currentRoute,
      shell,
      controls,
      counts,
      transcript,
      scroll,
    }
    if (priorSample) {
      const changes = transitionChanges(priorSample, sample)
      if (changes.length > 0) {
        pushBounded(
          transitions,
          { sequence, at: sample.at, changes },
          config.transitionLimit,
          () => {
            droppedTransitions += 1
          },
        )
      }
    }
    pushBounded(samples, sample, config.sampleLimit, () => {
      droppedSamples += 1
    })
    priorSample = sample
    activeViolationKeys = seen
    const waiters = sampleWaiters.splice(0)
    if (waiters.some((waiter) => waiter.completeIntents)) {
      completePendingIntents(geometrySettled)
    }
    const currentReport = report()
    for (const waiter of waiters) waiter.resolve(currentReport)
  }
  const scheduleSample = (reason: string) => {
    if (stopped) return
    dirtyReasons.add(reason)
    if (!armed || animationFrame !== undefined) return
    animationFrame = requestAnimationFrame(takeSample)
  }
  const waitForSample = (label: string | undefined, completeIntents: boolean) =>
    new Promise<UiJourneyInvariantReport>((resolve) => {
      sampleWaiters.push({
        completeIntents,
        ...(label === undefined ? {} : { label }),
        resolve,
      })
      dirtyReasons.add('checkpoint')
      if (document.visibilityState === 'hidden') {
        if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
        animationFrame = undefined
        if (!hiddenCheckpointPending) {
          hiddenCheckpointPending = true
          queueMicrotask(() => {
            hiddenCheckpointPending = false
            if (armed && !stopped) takeSample()
          })
        }
        return
      }
      scheduleSample('checkpoint')
    })
  const nearestVisibleAnchor = (scroll: HTMLElement) => {
    if (!config.transcript) return null
    const scrollRect = scroll.getBoundingClientRect()
    const candidates = document.querySelectorAll(config.transcript.itemSelector)
    for (const candidate of candidates) {
      const rect = candidate.getBoundingClientRect()
      if (rect.bottom > scrollRect.top && rect.top < scrollRect.bottom) return candidate
    }
    return candidates.item(0)
  }
  const markIntent = (intent: UiJourneyIntent) => {
    if (!armed || stopped) throw new Error('UiJourneyInvariantRecorderNotArmed')
    if (intent.kind === 'route') {
      pendingRoutes.push({
        id: intent.id,
        ...(intent.expected === undefined ? {} : { expected: intent.expected }),
      })
      return
    }
    if (intent.kind === 'gesture') {
      const existing = pendingGestures.get(intent.id)
      if (existing) {
        if (!intent.allowRepeat) {
          recordImmediateViolation(
            'double-gesture',
            intent.id,
            'gesture repeated before the prior phase reached a checkpoint',
          )
        }
        return
      }
      const target = document.querySelector<HTMLElement>(intent.targetSelector)
      const eventType = intent.eventType ?? 'click'
      const listener: EventListener = (event) => {
        const pending = pendingGestures.get(intent.id)
        if (!pending?.target) return
        const eventTarget = event.target
        const delivered =
          event.composedPath().includes(pending.target) ||
          (eventTarget instanceof Node && pending.target.contains(eventTarget))
        if (delivered) pending.deliveries += 1
      }
      pendingGestures.set(intent.id, {
        intent,
        target,
        deliveries: 0,
        eventType,
        listener,
      })
      document.addEventListener(eventType, listener, true)
      if (!target) {
        recordImmediateViolation('covered-gesture', intent.id, `${intent.targetSelector} missing`)
      } else {
        const compact = compactNode(target)
        const rect = target.getBoundingClientRect()
        const top = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        )
        if (
          !compact.visible ||
          compact.disabled ||
          !top ||
          (top !== target && !target.contains(top))
        ) {
          recordImmediateViolation(
            'covered-gesture',
            intent.id,
            `target=${compact.id} top=${top ? nodeId(top) : 0} visible=${compact.visible} disabled=${compact.disabled}`,
          )
        }
      }
      if (intent.allowsRouteChange || intent.expectedRoute) {
        pendingRoutes.push({
          id: intent.id,
          ...(intent.expectedRoute === undefined ? {} : { expected: intent.expectedRoute }),
        })
      }
      return
    }
    if (intent.kind === 'focus-continuity') {
      const element = intent.selector
        ? document.querySelector(intent.selector)
        : document.activeElement
      if (!element) throw new Error(`UiJourneyFocusSurfaceMissing:${intent.id}`)
      if (document.activeElement !== element) {
        recordImmediateViolation(
          'focus-continuity-lost',
          intent.id,
          `expected node ${nodeId(element)}, active node ${document.activeElement ? nodeId(document.activeElement) : 0}`,
        )
      }
      focusIntent = {
        id: intent.id,
        element,
        elementId: nodeId(element),
        selection: captureFocusSelection(element),
        preserveSelection: intent.preserveSelection ?? true,
      }
      return
    }
    if (intent.kind === 'transcript-replace-after') {
      transcriptReplacementIntent = { id: intent.id, messageId: intent.messageId }
      return
    }
    const selector =
      intent.scrollSelector ?? config.transcript?.scrollSelector ?? '[data-ui="scroll-region"]'
    const scroll = document.querySelector<HTMLElement>(selector)
    const tolerance = Math.max(0, intent.tolerancePx ?? config.defaultScrollTolerancePx)
    if (intent.kind === 'acquire-bottom') {
      const distance = scroll
        ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
        : Number.POSITIVE_INFINITY
      acquireBottomIntent = {
        id: intent.id,
        selector,
        node: scroll,
        tolerance,
        initialTop: scroll?.scrollTop ?? 0,
        lastDistance: distance,
        started: scroll !== null && distance <= tolerance,
        acquired: scroll !== null && distance <= tolerance,
        rejectedAlignment:
          scroll && intent.rejectAlignmentSelector
            ? document.querySelector(intent.rejectAlignmentSelector)
            : null,
        ...(intent.rejectAlignmentSelector
          ? { rejectedAlignmentSelector: intent.rejectAlignmentSelector }
          : {}),
      }
      return
    }
    if (!scroll) throw new Error(`UiJourneyScrollSurfaceMissing:${selector}`)
    if (intent.kind === 'follow-bottom') {
      const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
      if (distance > tolerance) {
        recordImmediateViolation(
          'follow-bottom-not-at-bottom',
          intent.id,
          `${round(distance)}px from bottom; tolerance ${tolerance}px`,
        )
      }
      followIntent = { id: intent.id, node: scroll, tolerance }
      return
    }
    const anchor = intent.anchorSelector
      ? document.querySelector(intent.anchorSelector)
      : nearestVisibleAnchor(scroll)
    if (!anchor) throw new Error(`UiJourneyPrependAnchorMissing:${intent.id}`)
    prependIntent = {
      id: intent.id,
      anchor,
      anchorId: nodeId(anchor),
      top: anchor.getBoundingClientRect().top,
      tolerance,
    }
  }
  const onHashChange = () => scheduleSample('route')
  const onPopState = () => scheduleSample('route')
  const onScroll = () => scheduleSample('scroll')
  const onVisibilityChange = () => {
    if (!armed || stopped) return
    if (document.visibilityState === 'hidden') {
      hiddenBaseline = {
        shell: config.shell ? document.querySelector(config.shell.selector) : null,
        controls: new Map(semanticNodes),
      }
      return
    }
    if (hiddenBaseline) {
      resumeBaseline = hiddenBaseline
      hiddenBaseline = undefined
      scheduleSample('visibility-resume')
    }
  }
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState
  const patchedPushState: History['pushState'] = (...args) => {
    originalPushState.apply(history, args)
    scheduleSample('route')
  }
  const patchedReplaceState: History['replaceState'] = (...args) => {
    originalReplaceState.apply(history, args)
    scheduleSample('route')
  }
  const attachResizeObserver = () => {
    if (resizeObserver) return
    resizeObserver = new ResizeObserver(() => {
      queueMicrotask(() => scheduleSample('resize'))
    })
    resizeObserver.observe(document.documentElement)
    const scroll = config.transcript?.scrollSelector
      ? document.querySelector(config.transcript.scrollSelector)
      : null
    const content =
      scroll?.querySelector('[data-ui="scroll-content"]') ??
      (config.transcript ? document.querySelector(config.transcript.rootSelector) : null)
    if (content) resizeObserver.observe(content)
  }
  const startObservation = () => {
    if (observationActive) return
    observationActive = true
    mutationObserver = new MutationObserver(() => {
      const scroll = config.transcript?.scrollSelector
        ? document.querySelector(config.transcript.scrollSelector)
        : null
      const content =
        scroll?.querySelector('[data-ui="scroll-content"]') ??
        (config.transcript ? document.querySelector(config.transcript.rootSelector) : null)
      if (content) resizeObserver?.observe(content)
      scheduleSample('mutation')
    })
    mutationObserver.observe(document, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    addEventListener('hashchange', onHashChange)
    addEventListener('popstate', onPopState)
    addEventListener('scroll', onScroll, true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    history.pushState = patchedPushState
    history.replaceState = patchedReplaceState
    attachResizeObserver()
  }
  const stopObservation = () => {
    if (!observationActive) return
    observationActive = false
    mutationObserver?.disconnect()
    mutationObserver = undefined
    resizeObserver?.disconnect()
    resizeObserver = undefined
    removeEventListener('hashchange', onHashChange)
    removeEventListener('popstate', onPopState)
    removeEventListener('scroll', onScroll, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (history.pushState === patchedPushState) history.pushState = originalPushState
    if (history.replaceState === patchedReplaceState) history.replaceState = originalReplaceState
    for (const pending of pendingGestures.values()) {
      document.removeEventListener(pending.eventType, pending.listener, true)
    }
  }

  const disposeNow = () => {
    stopped = true
    armed = false
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
    animationFrame = undefined
    hiddenCheckpointPending = false
    stopObservation()
    semanticNodes.clear()
    semanticConfigs.clear()
    claimBaselines.clear()
    messageNodes.clear()
    messageWrappers.clear()
    messageWrapperIndices.clear()
    pendingGestures.clear()
    followIntent = undefined
    prependIntent = undefined
    acquireBottomIntent = undefined
    transcriptReplacementIntent = undefined
    focusIntent = undefined
    hiddenBaseline = undefined
    resumeBaseline = undefined
    for (const waiter of sampleWaiters.splice(0)) waiter.resolve(report())
  }
  owner.__uiJourneyInvariantRecorder = {
    async arm(label) {
      if (stopped) throw new Error('UiJourneyInvariantRecorderStopped')
      armed = true
      sequence = 0
      droppedSamples = 0
      droppedTransitions = 0
      droppedViolations = 0
      samples.length = 0
      transitions.length = 0
      violations.length = 0
      semanticNodes.clear()
      semanticConfigs.clear()
      claimBaselines.clear()
      messageNodes.clear()
      messageWrappers.clear()
      messageWrapperIndices.clear()
      priorCounts.clear()
      for (const pending of pendingGestures.values()) {
        document.removeEventListener(pending.eventType, pending.listener, true)
      }
      pendingGestures.clear()
      pendingRoutes.length = 0
      followIntent = undefined
      prependIntent = undefined
      acquireBottomIntent = undefined
      transcriptReplacementIntent = undefined
      focusIntent = undefined
      hiddenBaseline = undefined
      resumeBaseline = undefined
      priorSample = undefined
      activeViolationKeys = new Set()
      dirtyReasons.clear()
      startObservation()
      return waitForSample(label, false)
    },
    markIntent,
    snapshot(label, completeIntents = true) {
      if (!armed || stopped) throw new Error('UiJourneyInvariantRecorderNotArmed')
      return waitForSample(label, completeIntents)
    },
    report,
    async stop(label) {
      if (stopped) return report()
      if (!armed) {
        disposeNow()
        return report()
      }
      const finalReport = await waitForSample(label, true)
      disposeNow()
      return { ...finalReport, armed: false, stopped: true }
    },
    __disposeNow: disposeNow,
  }
}
