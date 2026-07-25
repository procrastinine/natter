declare const browserWorkspaceBootstrapAuthorityBrand: unique symbol

export interface BrowserWorkspaceBootstrapAuthority {
  readonly attemptId: number
  readonly signal: AbortSignal
  readonly [browserWorkspaceBootstrapAuthorityBrand]: true
}

export class BrowserWorkspaceBootstrapAuthorityRegistry {
  private readonly activeAuthorities = new WeakSet<object>()
  private readonly authorityControllers = new WeakMap<object, AbortController>()
  private activeAuthority: BrowserWorkspaceBootstrapAuthority | null = null
  private nextAttemptId = 0

  begin(): BrowserWorkspaceBootstrapAuthority {
    if (this.activeAuthority) throw new Error('BrowserWorkspaceBootstrapAlreadyActive')
    const controller = new AbortController()
    const authority = Object.freeze({
      attemptId: ++this.nextAttemptId,
      signal: controller.signal,
    }) as BrowserWorkspaceBootstrapAuthority
    this.activeAuthorities.add(authority)
    this.authorityControllers.set(authority, controller)
    this.activeAuthority = authority
    return authority
  }

  assert(value: unknown): asserts value is BrowserWorkspaceBootstrapAuthority {
    this.assertOwned(value)
    if (value.signal.aborted) throw value.signal.reason
  }

  assertOwned(value: unknown): asserts value is BrowserWorkspaceBootstrapAuthority {
    if (
      typeof value !== 'object' ||
      value === null ||
      value !== this.activeAuthority ||
      !this.activeAuthorities.has(value)
    ) {
      throw new Error('BrowserWorkspaceBootstrapAuthorityInvalid')
    }
  }

  cancel(authority: BrowserWorkspaceBootstrapAuthority, reason: unknown): void {
    this.assertOwned(authority)
    this.authorityControllers.get(authority)?.abort(reason)
  }

  finish(authority: BrowserWorkspaceBootstrapAuthority): void {
    this.assertOwned(authority)
    this.activeAuthorities.delete(authority)
    this.authorityControllers.delete(authority)
    this.activeAuthority = null
  }
}

const bootstrapAuthorityRegistry: BrowserWorkspaceBootstrapAuthorityRegistry =
  new BrowserWorkspaceBootstrapAuthorityRegistry()

export function beginBrowserWorkspaceBootstrap(): BrowserWorkspaceBootstrapAuthority {
  return bootstrapAuthorityRegistry.begin()
}

export function assertBrowserWorkspaceBootstrapAuthority(
  value: unknown,
): asserts value is BrowserWorkspaceBootstrapAuthority {
  bootstrapAuthorityRegistry.assert(value)
}

export function assertBrowserWorkspaceBootstrapAuthorityOwned(
  value: unknown,
): asserts value is BrowserWorkspaceBootstrapAuthority {
  bootstrapAuthorityRegistry.assertOwned(value)
}

export function cancelBrowserWorkspaceBootstrap(
  authority: BrowserWorkspaceBootstrapAuthority,
  reason: unknown,
): void {
  bootstrapAuthorityRegistry.cancel(authority, reason)
}

export function finishBrowserWorkspaceBootstrap(
  authority: BrowserWorkspaceBootstrapAuthority,
): void {
  bootstrapAuthorityRegistry.finish(authority)
}
