export interface ProductionModuleViolation {
  code: string
  detail: string
  path?: string
}

export interface ProductionModuleAuditResult {
  ok: boolean
  schemaVersion: unknown
  moduleCount: number
  classificationCount: number
  uniqueClassifiedModuleCount: number
  ingressCount: number
  domainCounts: Record<string, number>
  layerCounts: Record<string, number>
  missingPaths: string[]
  stalePaths: string[]
  duplicatePaths: Array<{ path: string; count: number }>
  violations: ProductionModuleViolation[]
}

export const DEFAULT_INVENTORY_PATH: string

export function enumerateProductionModules(rootDirectory: string): string[]

export function validateProductionModuleInventory(
  inventory: unknown,
  actualPaths: Iterable<string>,
): ProductionModuleAuditResult

export function auditProductionModuleInventory(
  rootDirectory?: string,
  inventoryPath?: string,
): ProductionModuleAuditResult
