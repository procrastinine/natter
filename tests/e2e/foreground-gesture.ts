import type { Page } from '@playwright/test'

export interface ForegroundGestureResult {
  clickCount: number
  sidebarTransitions: string[]
  shellIdentityStable: boolean
  toggleIdentityStable: boolean
  hitTargetWasToggle: boolean
  openingStillPending: boolean
  runtimeState: string | null
  clickAt: number | null
  outcomeAt: number | null
  visibleAt: number | null
  firstVisibleFrameAt: number | null
}

interface ForegroundGestureProbe {
  shell: HTMLElement
  toggle: HTMLElement
  clickCount: number
  transitions: string[]
  onClick: () => void
  observer: MutationObserver
  hitTargetWasToggle: boolean
  point: { x: number; y: number }
  clickAt: number | null
  outcomeAt: number | null
  visibleAt: number | null
  firstVisibleFrameAt: number | null
  onVisibilityChange: () => void
}

interface ForegroundGestureWindow extends Window {
  __foregroundGestureProbe?: ForegroundGestureProbe
}

export interface ReloadStorageAdministrationBlockerState {
  acquired: boolean
  released: boolean
}

export async function startForegroundGestureRecorder(page: Page): Promise<string> {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-ui="app-shell"]')
    const toggle = shell?.querySelector('[data-role="sidebar-toggle"]')
    if (!(shell instanceof HTMLElement) || !(toggle instanceof HTMLElement)) {
      throw new Error('ForegroundGestureSurfaceMissing')
    }
    const transitions: string[] = []
    const rect = toggle.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) throw new Error('SidebarToggleHasNoLayoutBox')
    const onClick = () => {
      const probe = (window as ForegroundGestureWindow).__foregroundGestureProbe
      if (!probe) return
      probe.clickCount += 1
      probe.clickAt ??= performance.now()
    }
    const observer = new MutationObserver(() => {
      const state = shell.getAttribute('data-sidebar')
      if (!state || transitions.at(-1) === state) return
      transitions.push(state)
      const probe = (window as ForegroundGestureWindow).__foregroundGestureProbe
      if (probe) probe.outcomeAt ??= performance.now()
    })
    const onVisibilityChange = () => {
      const probe = (window as ForegroundGestureWindow).__foregroundGestureProbe
      if (!probe || document.visibilityState !== 'visible') return
      probe.visibleAt ??= performance.now()
      requestAnimationFrame(() => {
        const current = (window as ForegroundGestureWindow).__foregroundGestureProbe
        if (current === probe) current.firstVisibleFrameAt ??= performance.now()
      })
    }
    toggle.addEventListener('click', onClick, true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    observer.observe(shell, { attributes: true, attributeFilter: ['data-sidebar'] })
    ;(window as ForegroundGestureWindow).__foregroundGestureProbe = {
      shell,
      toggle,
      clickCount: 0,
      transitions,
      onClick,
      observer,
      hitTargetWasToggle: false,
      point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      clickAt: null,
      outcomeAt: null,
      visibleAt: null,
      firstVisibleFrameAt: null,
      onVisibilityChange,
    }
    return shell.getAttribute('data-sidebar') ?? ''
  })
}

export async function clickSidebarToggleWithoutActionabilityWait(
  page: Page,
): Promise<ForegroundGestureResult> {
  const point = await page.evaluate(() => {
    const probe = (window as ForegroundGestureWindow).__foregroundGestureProbe
    if (!probe) throw new Error('ForegroundGestureProbeMissing')
    const hit = document.elementFromPoint(probe.point.x, probe.point.y)
    probe.hitTargetWasToggle = hit === probe.toggle || (hit !== null && probe.toggle.contains(hit))
    return probe.point
  })
  await page.mouse.click(point.x, point.y)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  return page.evaluate(() => {
    const owner = window as ForegroundGestureWindow
    const probe = owner.__foregroundGestureProbe
    if (!probe) throw new Error('ForegroundGestureProbeMissing')
    probe.observer.disconnect()
    probe.toggle.removeEventListener('click', probe.onClick, true)
    document.removeEventListener('visibilitychange', probe.onVisibilityChange)
    const result = {
      clickCount: probe.clickCount,
      sidebarTransitions: probe.transitions,
      shellIdentityStable: probe.shell === document.querySelector('[data-ui="app-shell"]'),
      toggleIdentityStable:
        probe.toggle ===
        document.querySelector('[data-ui="app-shell"] [data-role="sidebar-toggle"]'),
      hitTargetWasToggle: probe.hitTargetWasToggle,
      openingStillPending:
        document.querySelector('[data-ui="workspace-bootstrap"][data-state="opening"]') !== null,
      runtimeState: probe.shell.getAttribute('data-workspace-runtime-state'),
      clickAt: probe.clickAt,
      outcomeAt: probe.outcomeAt,
      visibleAt: probe.visibleAt,
      firstVisibleFrameAt: probe.firstVisibleFrameAt,
    }
    delete owner.__foregroundGestureProbe
    return result
  })
}

export async function installReloadStorageAdministrationBlocker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const locks = (globalThis as { navigator?: Partial<Navigator> }).navigator?.locks
    if (!locks) return
    const state: ReloadStorageAdministrationBlockerState = {
      acquired: false,
      released: false,
    }
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const win = window as Window & {
      __reloadStorageAdministrationBlocker?: ReloadStorageAdministrationBlockerState
      __releaseReloadStorageAdministrationBlocker?: () => void
    }
    win.__reloadStorageAdministrationBlocker = state
    win.__releaseReloadStorageAdministrationBlocker = release
    void locks
      .request('natter:storage-administration', { mode: 'exclusive' }, async () => {
        state.acquired = true
        await released
        state.released = true
      })
      .catch(() => {})
  })
}

export async function reloadStorageAdministrationBlockerState(
  page: Page,
): Promise<ReloadStorageAdministrationBlockerState> {
  return page.evaluate(() => {
    const state = (
      window as Window & {
        __reloadStorageAdministrationBlocker?: ReloadStorageAdministrationBlockerState
      }
    ).__reloadStorageAdministrationBlocker
    if (!state) throw new Error('ReloadStorageAdministrationBlockerMissing')
    return { ...state }
  })
}

export async function releaseReloadStorageAdministrationBlocker(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(
      window as Window & {
        __releaseReloadStorageAdministrationBlocker?: () => void
      }
    ).__releaseReloadStorageAdministrationBlocker?.()
  })
}
