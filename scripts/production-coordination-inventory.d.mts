export interface ProductionCoordinationSiteContract {
  readonly id: string
  readonly scope: string
  readonly bound: string
  readonly cleanup: string
  readonly installation?: string
  readonly removalOwner?: string
  readonly stage?: string
  readonly ownership?: string
  readonly gap?: string
  readonly [key: string]: unknown
}

export const MODULE_MUTABLE_STATE: readonly ProductionCoordinationSiteContract[]
export const RETAINED_COLLECTIONS: readonly ProductionCoordinationSiteContract[]
export const LIFECYCLE_EXTERNAL_INGRESS: readonly ProductionCoordinationSiteContract[]
export const LIFECYCLE_DIRECT_CALLS: readonly ProductionCoordinationSiteContract[]
export const COORDINATION_LIFECYCLE_EVENT_NAMES: readonly string[]
export const LIFECYCLE_PRIMITIVE_MODULES: Readonly<Record<string, readonly string[]>>
export const MUTABLE_MODULE_CONTRACTS: Readonly<Record<string, unknown>>
export const MODULE_COLLECTION_CONTRACTS: Readonly<Record<string, unknown>>
export const CONTROLLER_COLLECTION_CONTRACTS: Readonly<Record<string, unknown>>
export const ZUSTAND_COLLECTION_CONTRACTS: Readonly<Record<string, unknown>>
export const RETAINED_COLLECTION_IDS_BY_SCOPE: Readonly<{
  module: readonly string[]
  controller: readonly string[]
  zustand: readonly string[]
}>
