import type { ConnectionHttpProfile, ConnectionProfile, KeyId, ProfileId } from './types'

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

export interface ConnectionDispatchProfileProof {
  readonly profileId: ProfileId
  readonly kind: ConnectionProfile['kind']
  readonly baseUrl: string
  readonly apiKeyRef: KeyId | null
  readonly apiKeyFallbackRefs: readonly KeyId[]
  readonly defaultHeaders: Readonly<Record<string, string>>
  readonly openRouterApp: {
    readonly title: string
    readonly url: string
    readonly categories: readonly string[]
  } | null
  readonly supportsPrivacyScrape: boolean | null
  readonly capabilityOverride: {
    readonly modelId: string
    readonly value: DeepReadonly<
      NonNullable<ConnectionProfile['capabilityOverrides']>[string]
    > | null
  } | null
}

type ConnectionDispatchProfileSource = Pick<
  ConnectionProfile,
  | 'id'
  | 'kind'
  | 'baseUrl'
  | 'apiKeyRef'
  | 'apiKeyFallbackRefs'
  | 'defaultHeaders'
  | 'appTitle'
  | 'appUrl'
  | 'appCategories'
  | 'supportsPrivacyScrape'
  | 'capabilityOverrides'
>

export function connectionHttpProfile(profile: ConnectionProfile): ConnectionHttpProfile {
  return Object.freeze({
    kind: profile.kind,
    baseUrl: profile.baseUrl,
    defaultHeaders: Object.freeze({ ...profile.defaultHeaders }),
    appTitle: profile.appTitle,
    appUrl: profile.appUrl,
    ...(profile.appCategories
      ? { appCategories: Object.freeze([...profile.appCategories]) as string[] }
      : {}),
  })
}

export function connectionDispatchProfileProof(
  profile: ConnectionDispatchProfileSource,
  modelId: string,
): Readonly<ConnectionDispatchProfileProof> {
  const openRouter = profile.kind === 'openrouter'
  const fallbackRefs = connectionDispatchKeyRefs(profile).filter((ref) => ref !== profile.apiKeyRef)
  const capabilityOverride = profile.capabilityOverrides?.[modelId]
  return deepFreeze({
    profileId: profile.id,
    kind: profile.kind,
    baseUrl: profile.baseUrl.replace(/\/+$/u, ''),
    apiKeyRef: profile.apiKeyRef ?? null,
    apiKeyFallbackRefs: fallbackRefs,
    defaultHeaders: normalizedHeaders(profile.defaultHeaders),
    openRouterApp: openRouter
      ? {
          title: profile.appTitle,
          url: profile.appUrl,
          categories: [...(profile.appCategories ?? [])],
        }
      : null,
    supportsPrivacyScrape: openRouter ? profile.supportsPrivacyScrape : null,
    capabilityOverride:
      openRouter || modelId.length === 0
        ? null
        : {
            modelId,
            value: capabilityOverride === undefined ? null : structuredClone(capabilityOverride),
          },
  })
}

export function connectionDispatchKeyRefs(
  profile: Pick<ConnectionDispatchProfileSource, 'apiKeyRef' | 'apiKeyFallbackRefs'>,
): KeyId[] {
  const refs: KeyId[] = []
  const seen = new Set<KeyId>()
  if (profile.apiKeyRef !== undefined) {
    refs.push(profile.apiKeyRef)
    seen.add(profile.apiKeyRef)
  }
  for (const ref of profile.apiKeyFallbackRefs ?? []) {
    if (seen.has(ref)) continue
    refs.push(ref)
    seen.add(ref)
  }
  return refs
}

export function connectionDispatchFallbackKeyRefs(
  profile: Pick<ConnectionDispatchProfileSource, 'apiKeyRef' | 'apiKeyFallbackRefs'>,
): KeyId[] {
  return [...connectionDispatchFallbackKeyRefsIterable(profile)]
}

export function* connectionDispatchFallbackKeyRefsIterable(
  profile: Pick<ConnectionDispatchProfileSource, 'apiKeyRef' | 'apiKeyFallbackRefs'>,
): Iterable<KeyId> {
  const seen = new Set<KeyId>()
  if (profile.apiKeyRef !== undefined) seen.add(profile.apiKeyRef)
  for (const ref of profile.apiKeyFallbackRefs ?? []) {
    if (seen.has(ref)) continue
    seen.add(ref)
    yield ref
  }
}

function normalizedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const normalized = new Map<string, string>()
  for (const [name, value] of Object.entries(headers)) normalized.set(name.toLowerCase(), value)
  return Object.fromEntries([...normalized].sort(([left], [right]) => left.localeCompare(right)))
}

export function profileMatchesDispatchProof(
  profile: ConnectionProfile | undefined,
  proof: ConnectionDispatchProfileProof,
): boolean {
  const modelId = proof.capabilityOverride?.modelId ?? ''
  return (
    profile !== undefined &&
    dispatchProofValuesEqual(connectionDispatchProfileProof(profile, modelId), proof)
  )
}

function dispatchProofValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!dispatchProofValuesEqual(left[index], right[index])) return false
    }
    return true
  }
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const [index, key] of leftKeys.entries()) {
    if (key !== rightKeys[index]) return false
    const leftValue = (left as Record<string, unknown>)[key]
    const rightValue = (right as Record<string, unknown>)[key]
    if (!dispatchProofValuesEqual(leftValue, rightValue)) return false
  }
  return true
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
