export const MAX_STORAGE_MAINTENANCE_BATCH = 128

export function boundedMaintenanceLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('StorageMaintenanceLimitInvalid')
  }
  return Math.min(value, MAX_STORAGE_MAINTENANCE_BATCH)
}
