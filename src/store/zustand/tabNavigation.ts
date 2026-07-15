import { newId } from '../../lib/ulid'

const tabNavigationAuthorityBrand: unique symbol = Symbol('TabNavigationAuthority')

export interface TabNavigationAuthority {
  readonly revision: string
  readonly [tabNavigationAuthorityBrand]: true
}

let currentAuthority: TabNavigationAuthority | null = null
let nextRevision = 0n
const tabRevisionPrefix = newId()

export function claimTabNavigation(): TabNavigationAuthority {
  nextRevision += 1n
  const authority = Object.freeze({
    revision: `${tabRevisionPrefix}:${nextRevision.toString()}`,
    [tabNavigationAuthorityBrand]: true as const,
  })
  currentAuthority = authority
  return authority
}

export function isTabNavigationCurrent(authority: TabNavigationAuthority): boolean {
  return currentAuthority === authority
}

export function consumeTabNavigation(authority: TabNavigationAuthority): boolean {
  if (currentAuthority !== authority) return false
  currentAuthority = null
  return true
}

export function invalidateTabNavigation(): void {
  currentAuthority = null
}
