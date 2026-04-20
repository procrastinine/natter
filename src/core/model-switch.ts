// Helper for "change model on an existing chat" that preserves settings
// the new model still supports and seeds reasonable defaults for newly-
// available controls. See `plan/07-discovery.md §7.2` step 8 (validation)
// and the user's "keep settings the same when supported, default the new
// ones" request.
//
// The rule of thumb:
// 1. Validate the current settings against the new capability (drops
//    unsupported params, clamps enum values). See `validateChatSettings`.
// 2. For controls that were NOT previously set but the new model newly
//    supports, leave them at "absent" so the ParamForm shows
//    `default`. We avoid forcing a concrete value onto the user — the
//    control is visible and they can opt in.
// 3. Reasoning and verbosity stay absent unless the user already set
//    them; newly-available controls should surface as `default`, not as
//    an auto-selected concrete wire value.
// 4. Caching: if the new model supports cache_control but the stored
//    anthropicCache is `off`, leave it off.

import type { EffectiveCapability } from './capabilities'
import { validateChatSettings } from './capabilities'
import type { ChatSettings } from './types'

// Transition `stored` into a valid shape under `newCap`. Returns the
// adjusted settings plus the list of fields that changed as a result.
export interface ModelSwitchResult {
  settings: ChatSettings
  changed: boolean
  droppedFields: string[]
}

export function adaptSettingsForCapability(
  stored: ChatSettings,
  newCap: EffectiveCapability,
): ModelSwitchResult {
  const validated = validateChatSettings(stored, newCap)
  return {
    settings: validated.settings,
    changed: validated.changed,
    droppedFields: validated.issues.map((i) => i.field),
  }
}
