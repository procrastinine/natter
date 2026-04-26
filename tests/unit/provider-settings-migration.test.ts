import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { filterEndpointsByPrivacy } from '../../src/core/privacy-filter'
import {
  DEFAULT_OPENROUTER_PROVIDER_SORT,
  migrateLegacyProviderSettings,
} from '../../src/core/provider-settings-migration'
import type { ChatSettings, DataPolicy, ModelEndpoint } from '../../src/core/types'
import { buildPickerRows } from '../../src/ui/settings/provider-picker-rows'

const CLEAN: DataPolicy = {
  training: false,
  trainingOpenRouter: false,
  retainsPrompts: false,
  canPublish: false,
  termsOfServiceURL: '',
  privacyPolicyURL: '',
}

const USER_IDS: DataPolicy = {
  ...CLEAN,
  requiresUserIDs: true,
}

function settings(patch: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: 'profile-1',
    model: 'anthropic/claude-opus-4.7',
    ...patch,
  }
}

function endpoint(provider_name: string, provider_slug: string, policy: DataPolicy): ModelEndpoint {
  return {
    provider_name,
    provider_slug,
    supported_parameters: ['provider', 'temperature'],
    context_length: 200_000,
    pricing: {},
    data_policy: policy,
  }
}

describe('migrateLegacyProviderSettings', () => {
  it('moves legacy privacy ignore refs into exact providerPrefs refs and clears old fields', () => {
    const endpoints = [
      endpoint('Amazon Bedrock', 'amazon-bedrock', CLEAN),
      endpoint('Anthropic', 'anthropic', USER_IDS),
      endpoint('Anthropic', 'anthropic/2', USER_IDS),
    ]
    const old = settings({
      privacy: {
        ...cloneDefaultChatSettings().privacy,
        ignoreProviders: ['Anthropic'],
        onlyProviders: [],
      },
    })

    const migrated = migrateLegacyProviderSettings(old, {
      model: old.model,
      endpoints,
      policies: {},
    })

    expect(migrated.changed).toBe(true)
    expect(migrated.settings.privacy.ignoreProviders).toEqual([])
    expect(migrated.settings.privacy.onlyProviders).toEqual([])
    expect(migrated.settings.providerPrefs?.ignoreOverridesFilter).toBe(true)
    expect(migrated.settings.providerPrefs?.ignore).toEqual(['anthropic', 'anthropic/2'])

    const filter = filterEndpointsByPrivacy({
      model: migrated.settings.model,
      endpoints,
      policies: {},
      privacy: migrated.settings.privacy,
    })
    const rows = buildPickerRows(endpoints, filter, {
      providerPrefs: migrated.settings.providerPrefs,
      privacy: migrated.settings.privacy,
    })
    expect(rows.map((row) => [row.endpoint.provider_slug, row.state])).toEqual([
      ['amazon-bedrock', 'kept'],
      ['anthropic', 'auto-excluded'],
      ['anthropic/2', 'auto-excluded'],
    ])
  })

  it('preserves old onlyProviders as explicit ignored endpoint refs when endpoint cache is available', () => {
    const endpoints = [
      endpoint('Amazon Bedrock', 'amazon-bedrock', CLEAN),
      endpoint('Anthropic', 'anthropic', USER_IDS),
      endpoint('Anthropic', 'anthropic/2', USER_IDS),
    ]
    const old = settings({
      privacy: {
        ...cloneDefaultChatSettings().privacy,
        ignoreProviders: [],
        onlyProviders: ['Anthropic'],
      },
    })

    const migrated = migrateLegacyProviderSettings(old, {
      model: old.model,
      endpoints,
      policies: {},
    })

    expect(migrated.settings.privacy.ignoreProviders).toEqual([])
    expect(migrated.settings.privacy.onlyProviders).toEqual([])
    expect(migrated.settings.providerPrefs?.ignoreOverridesFilter).toBe(true)
    expect(migrated.settings.providerPrefs?.ignore).toEqual(['amazon-bedrock'])
  })

  it('clears old privacy fields even when endpoint cache is missing', () => {
    const old = settings({
      privacy: {
        ...cloneDefaultChatSettings().privacy,
        ignoreProviders: ['Anthropic'],
        onlyProviders: ['Amazon Bedrock'],
      },
    })

    const migrated = migrateLegacyProviderSettings(old)

    expect(migrated.settings.privacy.ignoreProviders).toEqual([])
    expect(migrated.settings.privacy.onlyProviders).toEqual([])
    expect(migrated.settings.providerPrefs?.ignore).toEqual(['Anthropic'])
    expect(migrated.settings.providerPrefs?.only).toEqual(['Amazon Bedrock'])
    expect(migrated.settings.providerPrefs?.ignoreOverridesFilter).toBe(true)
  })

  it('converts stale providerPrefs.only into the visible ignore-list model once endpoints are known', () => {
    const endpoints = [
      endpoint('Amazon Bedrock', 'amazon-bedrock', CLEAN),
      endpoint('Anthropic', 'anthropic', USER_IDS),
      endpoint('Anthropic', 'anthropic/2', USER_IDS),
    ]
    const old = settings({
      providerPrefs: {
        only: ['anthropic'],
      },
    })

    const migrated = migrateLegacyProviderSettings(old, {
      model: old.model,
      endpoints,
      policies: {},
    })

    expect(migrated.changed).toBe(true)
    expect(migrated.settings.providerPrefs?.only).toBeUndefined()
    expect(migrated.settings.providerPrefs?.ignoreOverridesFilter).toBe(true)
    expect(migrated.settings.providerPrefs?.ignore).toEqual(['amazon-bedrock', 'anthropic/2'])
  })

  it('moves legacy providerPrefs privacy knobs into the visible privacy settings', () => {
    const old = settings({
      privacy: {
        ...cloneDefaultChatSettings().privacy,
        denyDataCollection: false,
        zdrOnly: false,
      },
      providerPrefs: {
        dataCollection: 'deny',
        zdr: true,
        sort: 'price',
      },
    })

    const migrated = migrateLegacyProviderSettings(old)

    expect(migrated.changed).toBe(true)
    expect(migrated.settings.privacy.denyDataCollection).toBe(true)
    expect(migrated.settings.privacy.zdrOnly).toBe(true)
    expect(migrated.settings.providerPrefs?.dataCollection).toBeUndefined()
    expect(migrated.settings.providerPrefs?.zdr).toBeUndefined()
    expect(migrated.settings.providerPrefs?.sort).toBe('price')
  })

  it('adds the OpenRouter default provider sort when requested', () => {
    const old = settings()

    const migrated = migrateLegacyProviderSettings(old, {
      defaultSort: DEFAULT_OPENROUTER_PROVIDER_SORT,
    })

    expect(migrated.changed).toBe(true)
    expect(migrated.settings.providerPrefs).toEqual({ sort: 'price' })
  })

  it('canonicalizes legacy provider sort aliases without dropping partition:none', () => {
    const nitro = migrateLegacyProviderSettings(
      settings({
        providerPrefs: { sort: 'nitro' } as unknown as NonNullable<ChatSettings['providerPrefs']>,
      }),
      { defaultSort: DEFAULT_OPENROUTER_PROVIDER_SORT },
    )
    expect(nitro.settings.providerPrefs?.sort).toBe('throughput')

    const modelPartition = migrateLegacyProviderSettings(
      settings({
        providerPrefs: {
          sort: { by: 'latency', partition: 'model' },
        },
      }),
      { defaultSort: DEFAULT_OPENROUTER_PROVIDER_SORT },
    )
    expect(modelPartition.settings.providerPrefs?.sort).toBe('latency')

    const globalPartition = migrateLegacyProviderSettings(
      settings({
        providerPrefs: {
          sort: { by: 'throughput', partition: 'none' },
        },
      }),
      { defaultSort: DEFAULT_OPENROUTER_PROVIDER_SORT },
    )
    expect(globalPartition.changed).toBe(false)
    expect(globalPartition.settings.providerPrefs?.sort).toEqual({
      by: 'throughput',
      partition: 'none',
    })
  })
})
