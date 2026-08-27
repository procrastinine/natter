import { expect, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  seedFirstRunFromOnboarding,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRunFromOnboarding(page)
})

test('bounds every warm existing-chat preparation phase and provider dispatch', async ({
  page,
}, testInfo) => {
  let turn = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    turn += 1
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `send-critical-path-${turn}`, content: `reply ${turn}`, finish: 'stop' },
      ]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'first turn')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').first(),
  ).toHaveText('reply 1')
  await waitForAssistantGenerationFinished(page, await firstChatId(page))

  await page.evaluate(() => {
    interface TraceEvent {
      readonly at: number
      readonly kind: string
      readonly detail?: unknown
    }
    interface TraceScope extends Window {
      __sendCriticalPathEvents?: TraceEvent[]
      __sendCriticalPathRuntimeObserver?: MutationObserver
    }
    const scope = window as TraceScope
    const events: TraceEvent[] = []
    scope.__sendCriticalPathEvents = events
    const now = () => performance.timeOrigin + performance.now()
    const record = (kind: string, detail?: unknown) => {
      events.push({ at: now(), kind, ...(detail === undefined ? {} : { detail }) })
    }
    const originalInfo = console.info.bind(console)
    console.info = (...args: unknown[]) => {
      const label = args[0]
      const detail = args[1]
      if (typeof label === 'string' && label.startsWith('[generation-submit]')) {
        record('generation-phase', detail)
      }
      originalInfo(...args)
    }
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (url.includes('/api/v1/chat/completions')) record('provider-fetch', url)
      return originalFetch(input, init)
    }
    const lockManager = navigator.locks as
      | (LockManager & { request: (...args: unknown[]) => Promise<unknown> })
      | undefined
    let lockRequestSequence = 0
    record('trace-ready', { webLocks: lockManager !== undefined })
    const workspaceShell = document.querySelector('[data-ui="app-shell"]')
    const recordWorkspaceRuntime = () =>
      record('workspace-runtime', workspaceShell?.getAttribute('data-workspace-runtime-state'))
    recordWorkspaceRuntime()
    if (workspaceShell) {
      const runtimeObserver = new MutationObserver(recordWorkspaceRuntime)
      runtimeObserver.observe(workspaceShell, {
        attributeFilter: ['data-workspace-runtime-state'],
      })
      scope.__sendCriticalPathRuntimeObserver = runtimeObserver
    }
    if (lockManager) {
      const originalLockRequest = lockManager.request.bind(lockManager)
      lockManager.request = (...args: unknown[]) => {
        const name = String(args[0])
        const requestId = ++lockRequestSequence
        const callbackIndex = args.length - 1
        const callback = args[callbackIndex] as (lock: Lock | null) => unknown
        const requestedAt = now()
        args[callbackIndex] = (lock: Lock | null) => {
          record('lock-acquired', {
            name,
            requestId,
            available: lock !== null,
            elapsedMs: now() - requestedAt,
          })
          return callback(lock)
        }
        record('lock-requested', { name, requestId })
        return originalLockRequest(...args)
      }
    }
    document.addEventListener(
      'click',
      (event) => {
        if (event.target instanceof Element && event.target.closest('[data-ui="send"]')) {
          record('send-click')
        }
      },
      { capture: true, once: true },
    )
  })

  await sendMessage(page, 'second turn')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').nth(1),
  ).toHaveText('reply 2')
  const events = await page.evaluate(() => {
    interface TraceEvent {
      readonly at: number
      readonly kind: string
      readonly detail?: unknown
    }
    const scope = window as Window & {
      __sendCriticalPathEvents?: readonly TraceEvent[]
      __sendCriticalPathRuntimeObserver?: MutationObserver
    }
    scope.__sendCriticalPathRuntimeObserver?.disconnect()
    return scope.__sendCriticalPathEvents ?? []
  })
  await testInfo.attach('send-critical-path-events.json', {
    body: Buffer.from(JSON.stringify(events, null, 2)),
    contentType: 'application/json',
  })
  const click = events.find((event) => event.kind === 'send-click')
  if (!click) throw new Error('SendCriticalPathClickMissing')
  const providerFetches = events.filter((event) => event.kind === 'provider-fetch')
  expect(providerFetches).toHaveLength(1)
  expect(
    events.filter((event) => event.kind === 'workspace-runtime').map((event) => event.detail),
  ).toEqual(['RUNNING'])
  expect((providerFetches[0]?.at ?? Number.POSITIVE_INFINITY) - click.at).toBeLessThan(750)

  const phaseEvents = events.filter((event) => event.kind === 'generation-phase')
  const phaseDetails = phaseEvents.map((event) => {
    const detail = event.detail as {
      readonly phase?: unknown
      readonly elapsedMs?: unknown
      readonly phaseElapsedMs?: unknown
    }
    if (
      typeof detail.phase !== 'string' ||
      typeof detail.elapsedMs !== 'number' ||
      typeof detail.phaseElapsedMs !== 'number'
    ) {
      throw new Error('SendCriticalPathPhaseInvalid')
    }
    return { ...detail, phase: detail.phase, elapsedMs: detail.elapsedMs }
  })
  expect(phaseDetails.map((detail) => detail.phase)).toEqual([
    'claimed',
    'workspace-requested',
    'workspace-admitted',
    'ownership-requested',
    'repository-requested',
    'local-applied',
    'admitted',
    'settled',
  ])
  for (let index = 1; index < phaseDetails.length; index += 1) {
    expect(phaseDetails[index]?.elapsedMs).toBeGreaterThanOrEqual(
      phaseDetails[index - 1]?.elapsedMs ?? 0,
    )
  }
  const localApplied = phaseDetails.find((detail) => detail.phase === 'local-applied')
  const admitted = phaseDetails.find((detail) => detail.phase === 'admitted')
  expect(localApplied?.elapsedMs).toBeLessThan(400)
  expect(admitted?.elapsedMs).toBeLessThan(450)

  const traceReady = events.find((event) => event.kind === 'trace-ready')?.detail as
    | { readonly webLocks?: unknown }
    | undefined
  if (traceReady?.webLocks === true) {
    const phaseAt = (phase: string) => {
      const at = phaseEvents.find(
        (event) => (event.detail as { readonly phase?: unknown }).phase === phase,
      )?.at
      if (at === undefined) throw new Error(`SendCriticalPathPhaseMissing:${phase}`)
      return at
    }
    const workspaceRequestedAt = phaseAt('workspace-requested')
    const workspaceAdmittedAt = phaseAt('workspace-admitted')
    const ownershipRequestedAt = phaseAt('ownership-requested')
    const repositoryRequestedAt = phaseAt('repository-requested')
    const localAppliedAt = phaseEvents.find(
      (event) => (event.detail as { readonly phase?: unknown }).phase === 'local-applied',
    )?.at
    if (localAppliedAt === undefined) throw new Error('SendCriticalPathLocalAppliedMissing')
    const admissionLockRequests = events.filter(
      (event) =>
        event.kind === 'lock-requested' &&
        event.at >= workspaceRequestedAt &&
        event.at <= workspaceAdmittedAt,
    )
    const ownershipLockRequests = events.filter(
      (event) =>
        event.kind === 'lock-requested' &&
        event.at >= ownershipRequestedAt &&
        event.at <= repositoryRequestedAt,
    )
    const repositoryLockRequests = events.filter(
      (event) =>
        event.kind === 'lock-requested' &&
        event.at >= repositoryRequestedAt &&
        event.at <= localAppliedAt,
    )
    const admissionLockNames = admissionLockRequests.map(
      (event) => (event.detail as { readonly name?: unknown }).name,
    )
    const ownershipLockNames = ownershipLockRequests.map(
      (event) => (event.detail as { readonly name?: unknown }).name,
    )
    const repositoryLockNames = repositoryLockRequests.map(
      (event) => (event.detail as { readonly name?: unknown }).name,
    )
    expect(
      admissionLockNames.filter((name) => name === 'workspace:generation-lifetime'),
    ).toHaveLength(1)
    expect(
      ownershipLockNames.filter((name) => String(name).startsWith('stream-owner:')),
    ).toHaveLength(1)
    expect(repositoryLockNames.filter((name) => name === 'workspace:authoritative')).toHaveLength(1)
    expect(
      repositoryLockNames.filter((name) => String(name).startsWith('chat-meta:')),
    ).toHaveLength(1)
    expect(
      repositoryLockNames.filter((name) => String(name).startsWith('message-topology:')),
    ).toHaveLength(1)
    expect(repositoryLockNames.filter((name) => String(name).startsWith('message:'))).toHaveLength(
      1,
    )
    const causalLockRequests = [
      ...admissionLockRequests,
      ...ownershipLockRequests,
      ...repositoryLockRequests,
    ]
    expect(
      causalLockRequests
        .map((event) => (event.detail as { readonly name?: unknown }).name)
        .filter((name) => /^(?:key|preset|profile|setting):/u.test(String(name))),
    ).toEqual([])
    const causalRequestIds = new Set(
      causalLockRequests.map(
        (event) => (event.detail as { readonly requestId?: unknown }).requestId,
      ),
    )
    const acquisitionDurations = events
      .filter(
        (event) =>
          event.kind === 'lock-acquired' &&
          causalRequestIds.has((event.detail as { readonly requestId?: unknown }).requestId),
      )
      .map((event) => (event.detail as { readonly elapsedMs?: unknown }).elapsedMs)
      .filter((value): value is number => typeof value === 'number')
    expect(Math.max(0, ...acquisitionDurations)).toBeLessThan(250)
  }
})
