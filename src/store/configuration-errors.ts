import type { PresetId } from '../core/types'

export class PresetMissingError extends Error {
  readonly presetId: PresetId

  constructor(presetId: PresetId) {
    super(`PresetMissing:${presetId}`)
    this.name = 'PresetMissingError'
    this.presetId = presetId
  }
}
