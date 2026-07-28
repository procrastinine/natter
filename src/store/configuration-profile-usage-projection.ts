import type { Chat, ChatPreset, ProfileId } from '../core/types'
import type { ConfigurationLink } from './configuration-domain-contract'
import { physicalStorageTables } from './physical-storage-tables'

export const CONFIGURATION_PROFILE_MANAGER_STATE_ID = 'profiles:manager'

export interface ConfigurationProfileManagerStateRow {
  readonly id: typeof CONFIGURATION_PROFILE_MANAGER_STATE_ID
  readonly revision: number
  readonly exactCount: number
}

export interface ConfigurationProfileUsageProjectionRow {
  readonly id: ProfileId
  readonly presetCount: number
  readonly activePresetCount: number
  readonly chatCount: number
  readonly activeChatCount: number
}

export type ConfigurationProfileUsageDelta = ConfigurationProfileUsageProjectionRow

export function configurationProfileUsageResourceName(profileId: ProfileId): string {
  return `configuration-target:profile:${profileId}`
}

export function configurationProfileUsageResourceNamesForLinks(
  links: readonly ConfigurationLink[],
): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        links
          .filter(
            (link) =>
              (link.ownerKind === 'chat' || link.ownerKind === 'chat-preset') &&
              link.targetKind === 'profile',
          )
          .map((link) => configurationProfileUsageResourceName(link.targetId)),
      ),
    ].sort(),
  )
}

export const CONFIGURATION_LINK_MUTATION_TRANSACTION_CAPABILITY = physicalStorageTables(
  'configurationLinks',
  'configurationProfileUsageRows',
  'configurationCatalogAggregates',
)

export function emptyConfigurationProfileManagerStateRow(): ConfigurationProfileManagerStateRow {
  return { id: CONFIGURATION_PROFILE_MANAGER_STATE_ID, revision: 0, exactCount: 0 }
}

export function emptyConfigurationProfileUsageProjectionRow(
  profileId: ProfileId,
): ConfigurationProfileUsageProjectionRow {
  return {
    id: profileId,
    presetCount: 0,
    activePresetCount: 0,
    chatCount: 0,
    activeChatCount: 0,
  }
}

export function configurationProfileUsageDeltas(
  current: readonly ConfigurationLink[],
  next: readonly ConfigurationLink[],
): readonly ConfigurationProfileUsageDelta[] {
  const deltas = new Map<ProfileId, ConfigurationProfileUsageProjectionRow>()
  addUsageContribution(deltas, current, -1)
  addUsageContribution(deltas, next, 1)
  return Object.freeze(
    [...deltas.values()].filter(
      (row) =>
        row.presetCount !== 0 ||
        row.activePresetCount !== 0 ||
        row.chatCount !== 0 ||
        row.activeChatCount !== 0,
    ),
  )
}

export function configurationProfileUsageProjectionRows(
  presets: readonly ChatPreset[],
  chats: readonly Chat[],
): readonly ConfigurationProfileUsageProjectionRow[] {
  const rows = new Map<ProfileId, ConfigurationProfileUsageProjectionRow>()
  const mutable = (profileId: ProfileId) => {
    const current = rows.get(profileId) ?? emptyConfigurationProfileUsageProjectionRow(profileId)
    const next = { ...current }
    rows.set(profileId, next)
    return next
  }
  for (const preset of presets) {
    const row = mutable(preset.connectionProfileId)
    row.presetCount += 1
    if (preset.archived !== true) row.activePresetCount += 1
  }
  for (const chat of chats) {
    const row = mutable(chat.settings.profileId)
    row.chatCount += 1
    if (chat.archived !== true) row.activeChatCount += 1
  }
  return Object.freeze([...rows.values()])
}

function addUsageContribution(
  deltas: Map<ProfileId, ConfigurationProfileUsageProjectionRow>,
  links: readonly ConfigurationLink[],
  direction: -1 | 1,
): void {
  const profileLinks = links.filter(
    (link) =>
      (link.ownerKind === 'chat' || link.ownerKind === 'chat-preset') &&
      link.targetKind === 'profile',
  )
  if (profileLinks.length > 1) throw new Error('ConfigurationProfileUsageOwnerAmbiguous')
  const link = profileLinks[0]
  if (!link) return
  if (typeof link.ownerActive !== 'boolean') {
    throw new Error(`ConfigurationProfileUsageOwnerStateMissing:${link.ownerKey}`)
  }
  const profileId = link.targetId
  const current = deltas.get(profileId) ?? emptyConfigurationProfileUsageProjectionRow(profileId)
  const activeDelta = link.ownerActive ? direction : 0
  deltas.set(
    profileId,
    link.ownerKind === 'chat-preset'
      ? {
          ...current,
          presetCount: current.presetCount + direction,
          activePresetCount: current.activePresetCount + activeDelta,
        }
      : {
          ...current,
          chatCount: current.chatCount + direction,
          activeChatCount: current.activeChatCount + activeDelta,
        },
  )
}
