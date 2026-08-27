interface LifecycleDrainLocator {
  waitFor(options: { state: 'attached' }): Promise<void>
}

export interface LifecycleDrainPage {
  goto(url: string, options: { waitUntil: 'commit' }): Promise<unknown>
  isClosed(): boolean
  locator(selector: string): LifecycleDrainLocator
  setContent(html: string): Promise<void>
  url(): string
}

const LIFECYCLE_DRAIN_URL = 'about:blank'
const LIFECYCLE_DRAIN_MARKER = '[data-e2e-lifecycle-drain]'
const LIFECYCLE_DRAIN_DOCUMENT =
  '<!doctype html><html data-e2e-lifecycle-drain><title>Closed</title></html>'

function lifecycleDrainError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('RuntimeDiagnosticLifecycleDrainRejected', { cause: reason })
}

async function navigatePageForLifecycleDrain(page: LifecycleDrainPage): Promise<void> {
  const navigationErrors: unknown[] = []
  for (let attempt = 0; attempt < 2 && !page.isClosed(); attempt += 1) {
    try {
      await page.goto(LIFECYCLE_DRAIN_URL, { waitUntil: 'commit' })
    } catch (error) {
      navigationErrors.push(error)
    }
    if (page.url() === LIFECYCLE_DRAIN_URL) break
  }
  if (page.isClosed() || page.url() !== LIFECYCLE_DRAIN_URL) {
    if (navigationErrors.length === 1) throw lifecycleDrainError(navigationErrors[0])
    if (navigationErrors.length > 1) {
      throw new AggregateError(
        navigationErrors.map(lifecycleDrainError),
        'RuntimeDiagnosticLifecycleDrainRejected',
      )
    }
    throw new Error('RuntimeDiagnosticDrainUrlMismatch')
  }
  await page.setContent(LIFECYCLE_DRAIN_DOCUMENT)
  await page.locator(LIFECYCLE_DRAIN_MARKER).waitFor({ state: 'attached' })
  if (page.url() !== LIFECYCLE_DRAIN_URL) throw new Error('RuntimeDiagnosticDrainUrlMismatch')
}

export async function navigatePagesForLifecycleDrain(
  pages: readonly LifecycleDrainPage[],
): Promise<void> {
  const results = await Promise.allSettled(
    pages.filter((page) => !page.isClosed()).map(navigatePageForLifecycleDrain),
  )
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejected) throw lifecycleDrainError(rejected.reason)
}
