import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadProtocolContractFactBundle } from '../helpers/protocol-contract-facts'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(resolve(ROOT, 'scripts/audit-durable-command-pipeline.mjs')).href
const INVENTORY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/durable-command-pipeline-inventory.mjs'),
).href

interface PipelineStage {
  readonly status: string
  readonly proof?: string | readonly string[]
  readonly reason?: string
}

type PipelineRecord = Readonly<Record<string, PipelineStage>>

interface DurableCommandPipelineInventory {
  readonly WORKSPACE_COMMAND_PIPELINES: Readonly<Record<string, PipelineRecord>>
  readonly CONFIGURATION_COMMAND_PIPELINES: Readonly<Record<string, PipelineRecord>>
  readonly MANUAL_WRITE_MARKER_OWNER_COUNTS: Readonly<Record<string, number>>
  readonly DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS: Readonly<Record<string, number>>
  readonly WRITE_DETECTION_ARCHITECTURE: Readonly<Record<string, unknown>>
  readonly REQUIRED_PIPELINE_STAGES: readonly string[]
}

interface DurableCommandPipelineReport {
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly workspaceCommands: number
  readonly workspaceConstructorSites: number
  readonly configurationCommands: number
  readonly configurationConstructorSites: number
  readonly configurationConstructorGaps: number
  readonly pipelineRecords: number
  readonly requiredStages: number
  readonly stageCells: number
  readonly gapCells: number
  readonly observedCells: number
  readonly manualMarkerOwners: number
  readonly manualMarkerCalls: number
  readonly directTransactionOwners: number
  readonly directTransactionCalls: number
  readonly physicalTables: string[]
  readonly limitations: string[]
  readonly problems: string[]
}

let canonicalInventory: DurableCommandPipelineInventory
let sourceFacts: unknown
let evaluateDurableCommandPipeline: (
  inventory: DurableCommandPipelineInventory,
  mode: 'inventory' | 'enforce',
  options?: Readonly<Record<string, unknown>>,
  facts?: unknown,
) => DurableCommandPipelineReport

beforeAll(async () => {
  const audit = (await import(AUDIT_URL)) as {
    evaluateDurableCommandPipeline: typeof evaluateDurableCommandPipeline
    buildDurableCommandPipelineSourceFacts(): unknown
  }
  canonicalInventory = (await import(INVENTORY_URL)) as DurableCommandPipelineInventory
  evaluateDurableCommandPipeline = audit.evaluateDurableCommandPipeline
  sourceFacts = (await loadProtocolContractFactBundle<{ readonly durable: unknown }>()).durable
}, 30_000)

describe('durable command commit pipeline audit', () => {
  it('inventories every command and every required pipeline stage without hiding gaps', () => {
    const result = runAudit('inventory')

    expect(result.status).toBe(0)
    expect(result.report).toMatchObject({
      ok: true,
      structurallyValid: true,
      workspaceCommands: 65,
      workspaceConstructorSites: 74,
      configurationCommands: 51,
      configurationConstructorSites: 44,
      configurationConstructorGaps: 10,
      pipelineRecords: 116,
      requiredStages: 15,
      stageCells: 1740,
      gapCells: 1054,
      observedCells: 686,
      manualMarkerOwners: 0,
      manualMarkerCalls: 0,
      directTransactionOwners: 2,
      directTransactionCalls: 3,
      problems: [],
    })
    expect(result.report.physicalTables).toHaveLength(45)
    expect(result.report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('command-to-helper-to-table completeness remains unproven'),
        expect.stringContaining('semantic meaning of each mutated table is not inferred'),
      ]),
    )
  })

  it('makes the explicit architectural gaps fatal in enforcement mode', () => {
    const result = runAudit('enforce')

    expect(result.status).toBe(1)
    expect(result.report.structurallyValid).toBe(true)
    expect(result.report.ok).toBe(false)
    expect(result.report.gapCells).toBe(1054)
  })

  it('rejects stale variants, incomplete paths, transaction bypasses, false publication claims, and handler drift', () => {
    const touchViewed = omit(
      {
        ...canonicalInventory.WORKSPACE_COMMAND_PIPELINES['chat.touch-viewed'],
        handler: { status: 'observed', proof: 'notARealTouchHandler' },
        writeDetection: { status: 'gap', reason: 'claimed manual' },
        broadcast: { status: 'gap', reason: 'claimed manual' },
      },
      'tables',
    )
    const result = runAudit('inventory', {
      ...canonicalInventory,
      WORKSPACE_COMMAND_PIPELINES: {
        ...omit(canonicalInventory.WORKSPACE_COMMAND_PIPELINES, 'chat.fork'),
        'chat.touch-viewed': touchViewed,
      },
      DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS: Object.fromEntries(
        Object.entries(canonicalInventory.DIRECT_COMMAND_TRANSACTION_OWNER_COUNTS).slice(1),
      ),
      WRITE_DETECTION_ARCHITECTURE: {
        mechanism: 'manual-marker',
        status: 'gap',
        reason: '',
      },
    })

    expect(result.status).toBe(1)
    expect(result.report.problems).toEqual(
      expect.arrayContaining([
        'workspace command pipeline variants: missing chat.fork',
        'workspace chat.touch-viewed: pipeline stages: missing tables',
        'workspace chat.touch-viewed: missing stage tables',
        'workspace chat.touch-viewed: dispatch handler missing notARealTouchHandler',
        'workspace chat.touch-viewed: transaction-derived write detection must be observed',
        'workspace chat.touch-viewed: committed-write broadcast must be observed',
        'write-detection architecture must use the transaction-local mutation journal',
        'transaction-local write detection must remain observed',
        'transaction-local write detection needs proof',
        expect.stringContaining('direct command transaction owners: unclassified'),
      ]),
    )
  })
})

function runAudit(
  mode: 'inventory' | 'enforce',
  inventory: DurableCommandPipelineInventory = canonicalInventory,
) {
  const report = evaluateDurableCommandPipeline(inventory, mode, {}, sourceFacts)
  return { status: report.ok ? 0 : 1, report }
}

function omit<T>(value: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key))
}
