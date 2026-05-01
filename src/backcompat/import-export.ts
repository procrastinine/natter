import {
  assertNatterExportEnvelope,
  type NatterExportEnvelope,
} from '../core/import-export/schema'

export function migrateNatterExportEnvelope(value: unknown): NatterExportEnvelope {
  assertNatterExportEnvelope(value)
  return value
}
