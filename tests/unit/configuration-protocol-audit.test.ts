import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadProtocolContractFactBundle } from '../helpers/protocol-contract-facts'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-configuration-protocol.mjs')).href
const INVENTORY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/configuration-protocol-inventory.mjs'),
).href

interface ConfigurationProtocolInventory {
  readonly CONFIGURATION_COMMANDS: Readonly<Record<string, ConfigurationCommandRecord>>
  readonly CONFIGURATION_OPTIMISTIC_STAGE_VARIANTS: readonly string[]
}

interface ConfigurationCommandRecord {
  readonly owners: readonly string[]
  readonly status: string
  readonly gap?: string
}

interface ConfigurationProtocolReport {
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly commandVariants: number
  readonly constructorSites: number
  readonly reachableCommands: number
  readonly resultVariants: number
  readonly resultConstructorSites: number
  readonly resultMappings: number
  readonly gaps: Array<{ variant: string; rationale: string }>
  readonly problems: string[]
}

let canonicalInventory: ConfigurationProtocolInventory
let sourceFacts: unknown
let evaluateConfigurationProtocol: (
  inventory: ConfigurationProtocolInventory,
  mode: 'inventory' | 'enforce',
  facts?: unknown,
) => ConfigurationProtocolReport

beforeAll(async () => {
  const audit = (await import(AUDIT_URL)) as {
    evaluateConfigurationProtocol: typeof evaluateConfigurationProtocol
    buildConfigurationProtocolSourceFacts(): unknown
  }
  canonicalInventory = (await import(INVENTORY_URL)) as ConfigurationProtocolInventory
  evaluateConfigurationProtocol = audit.evaluateConfigurationProtocol
  sourceFacts = (await loadProtocolContractFactBundle<{ readonly configuration: unknown }>())
    .configuration
}, 30_000)

describe('nested configuration protocol audit', () => {
  it('closes the current protocol structure with every operation reachable', () => {
    const result = runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      commandVariants: 44,
      constructorSites: 47,
      reachableCommands: 44,
      resultVariants: 13,
      resultConstructorSites: 107,
      resultMappings: 44,
      problems: [],
    })
    expect(result.report.gaps).toEqual([])
  })

  it('passes enforcement mode with no unresolved operations', () => {
    const result = runAudit('enforce')

    expect(result.status).toBe(0)
    expect(result.report.ok).toBe(true)
    expect(result.report.structurallyValid).toBe(true)
    expect(result.report.gaps).toEqual([])
  })

  it('rejects a stale or missing command classification', () => {
    const result = runAudit('inventory', {
      ...canonicalInventory,
      CONFIGURATION_COMMANDS: omit(canonicalInventory.CONFIGURATION_COMMANDS, 'connection.create'),
    })

    expect(result.status).toBe(1)
    expect(result.report.problems).toContain(
      'command inventory variants: unclassified connection.create',
    )
  })

  it('rejects constructor ownership claims that do not match typed production sites', () => {
    const connectionCreate = canonicalInventory.CONFIGURATION_COMMANDS['connection.create']
    if (!connectionCreate) throw new Error('ConfigurationConnectionCreateFixtureMissing')
    const result = runAudit('inventory', {
      ...canonicalInventory,
      CONFIGURATION_COMMANDS: {
        ...canonicalInventory.CONFIGURATION_COMMANDS,
        'connection.create': {
          ...connectionCreate,
          owners: ['src/store/not-an-owner.ts#fake'],
        },
      },
    })

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'connection.create: constructor owners: missing src/store/not-an-owner.ts#fake',
        'connection.create: constructor owners: unclassified src/store/configuration-domain.ts#createConfigurationApplication.createConnection',
      ]),
    )
  })

  it('rejects optimistic-stage drift while result coverage stays source-derived', () => {
    const result = runAudit('inventory', {
      ...canonicalInventory,
      CONFIGURATION_OPTIMISTIC_STAGE_VARIANTS:
        canonicalInventory.CONFIGURATION_OPTIMISTIC_STAGE_VARIANTS.slice(1),
    })

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'optimistic stage variants: unclassified chat.settings-fields-patch',
      ]),
    )
  })
})

function runAudit(
  mode: 'inventory' | 'enforce',
  inventory: ConfigurationProtocolInventory = canonicalInventory,
) {
  const report = evaluateConfigurationProtocol(inventory, mode, sourceFacts)
  return { status: report.ok ? 0 : 1, report }
}

function omit<T>(value: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key))
}
