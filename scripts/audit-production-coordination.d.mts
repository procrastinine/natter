import type { ProductionCoordinationSiteContract } from './production-coordination-inventory.mjs'

export interface ProductionCoordinationInventory {
  readonly MODULE_MUTABLE_STATE: readonly ProductionCoordinationSiteContract[]
  readonly RETAINED_COLLECTIONS: readonly ProductionCoordinationSiteContract[]
  readonly LIFECYCLE_EXTERNAL_INGRESS: readonly ProductionCoordinationSiteContract[]
  readonly LIFECYCLE_DIRECT_CALLS: readonly ProductionCoordinationSiteContract[]
  readonly COORDINATION_LIFECYCLE_EVENT_NAMES: readonly string[]
  readonly LIFECYCLE_PRIMITIVE_MODULES: Readonly<Record<string, readonly string[]>>
  readonly MUTABLE_MODULE_CONTRACTS: Readonly<Record<string, unknown>>
}

export interface ProductionCoordinationDiscoveryEntry {
  readonly id: string
  readonly kind: string
}

export interface ProductionCoordinationDiscovery {
  readonly sourceFiles: number
  readonly discovered: {
    readonly moduleMutableState: readonly ProductionCoordinationDiscoveryEntry[]
    readonly retainedCollections: readonly ProductionCoordinationDiscoveryEntry[]
    readonly lifecycleExternalIngress: readonly ProductionCoordinationDiscoveryEntry[]
    readonly lifecycleDirectCalls: readonly ProductionCoordinationDiscoveryEntry[]
  }
}

export interface ProductionCoordinationReportEntry extends ProductionCoordinationDiscoveryEntry {
  readonly domain: string | null
  readonly scope?: string
  readonly bound?: string
  readonly cleanup?: string
  readonly installation?: string
  readonly removalOwner?: string
  readonly stage?: string
  readonly ownership?: string
}

export interface ProductionCoordinationReportSection {
  readonly count: number
  readonly domainCounts: Readonly<Record<string, number>>
  readonly scopeCounts: Readonly<Record<string, number>>
  readonly unclassified: string[]
  readonly stale: string[]
  readonly entries: ProductionCoordinationReportEntry[]
}

export interface ProductionCoordinationAuditReport {
  readonly sourceFiles: number
  readonly architectureViolations: string[]
  readonly problems: string[]
  readonly moduleMutableState: ProductionCoordinationReportSection
  readonly retainedCollections: ProductionCoordinationReportSection
  readonly lifecycleExternalIngress: ProductionCoordinationReportSection
  readonly lifecycleDirectCalls: ProductionCoordinationReportSection
}

export function discoverProductionCoordination(options?: {
  root?: string
  inventory?: ProductionCoordinationInventory
}): ProductionCoordinationDiscovery

export function evaluateProductionCoordination(options: {
  discovery: ProductionCoordinationDiscovery
  inventory?: ProductionCoordinationInventory
  moduleInventory?: {
    classifications: readonly {
      domain: string
      paths: readonly string[]
    }[]
  }
}): ProductionCoordinationAuditReport
