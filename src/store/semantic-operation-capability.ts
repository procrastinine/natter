import type { ConfigurationDomainCommandKind } from './configuration-domain-contract'
import {
  type CapabilityTables,
  type FencedTransaction,
  type PhysicalStorageTableName,
  type PhysicalTransactionCapability,
  type PhysicalTransactionPlan,
  physicalStorageMutationAddress,
  physicalTransactionPlan,
} from './physical-storage-tables'
import type { StorageCompactionWriteAdmission } from './storage-compaction-state'
import {
  normalizeWorkspaceDependencies,
  type WorkspaceCommand,
  type WorkspaceDelta,
  type WorkspaceDeltaFact,
  type WorkspaceDependency,
} from './workspace-protocol'

const SEMANTIC_OPERATION_DESCRIPTOR = Symbol('SemanticOperationDescriptor')
const SEMANTIC_OPERATION_DELEGATION = Symbol('SemanticOperationDelegation')
const SEMANTIC_OPERATION_EXECUTION = Symbol('SemanticOperationExecution')
const SEMANTIC_OPERATION_EXACT_RECEIPT = Symbol('SemanticOperationExactReceipt')
const SEMANTIC_OPERATION_RECEIPT_FRAGMENT = Symbol('SemanticOperationReceiptFragment')
const SEMANTIC_OPERATION_COMMAND_LIFETIME_RECEIPT = Symbol(
  'SemanticOperationCommandLifetimeReceipt',
)
const semanticOperationReceiptAccumulators = new WeakMap<
  object,
  SemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>
>()

type WorkspaceCommandKind = WorkspaceCommand['kind']
export type ConfigurationSemanticOperationKind = `configuration:${ConfigurationDomainCommandKind}`
export type SemanticOperationKind = WorkspaceCommandKind | ConfigurationSemanticOperationKind
export type SemanticOperationEffectKind = WorkspaceDependency['kind']

export interface SemanticOperationCommandLifetimeReceipt {
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly databaseName: string
  readonly preconditions: readonly [
    {
      readonly kind: 'storage-compaction-write-admission'
      readonly commandPhysicalReads: 0
    },
  ]
  readonly physicalReads: readonly SemanticOperationPhysicalRead[]
  readonly exactPhysicalReads: readonly SemanticOperationExactPhysicalRead[]
  readonly [SEMANTIC_OPERATION_COMMAND_LIFETIME_RECEIPT]: true
}

export function semanticOperationCommandLifetimeReceipt(
  workspace: { readonly workspaceId: string; readonly replacementEpoch: number },
  databaseName: string,
  admission: StorageCompactionWriteAdmission,
): SemanticOperationCommandLifetimeReceipt {
  if (admission.databaseName !== databaseName) {
    throw new Error(
      `SemanticOperationCommandLifetimeDatabaseMismatch:${databaseName}:${admission.databaseName}`,
    )
  }
  const preconditions = Object.freeze([
    Object.freeze({
      kind: admission.kind,
      commandPhysicalReads: admission.commandPhysicalReads,
    }),
  ] as const)
  const physicalReads = Object.freeze([] as readonly SemanticOperationPhysicalRead[])
  const exactPhysicalReads = Object.freeze([] as readonly SemanticOperationExactPhysicalRead[])
  return Object.freeze({
    workspaceId: workspace.workspaceId,
    replacementEpoch: workspace.replacementEpoch,
    databaseName,
    preconditions,
    physicalReads,
    exactPhysicalReads,
    [SEMANTIC_OPERATION_COMMAND_LIFETIME_RECEIPT]: true as const,
  })
}

export function semanticOperationCommandLifetimeReceiptWithPhysicalReads(
  receipt: SemanticOperationCommandLifetimeReceipt,
  physicalReads: readonly SemanticOperationPhysicalRead[],
): SemanticOperationCommandLifetimeReceipt {
  assertSemanticOperationCommandLifetimeReceipt(receipt, {
    workspaceId: receipt.workspaceId,
    replacementEpoch: receipt.replacementEpoch,
    databaseName: receipt.databaseName,
  })
  const next = Object.freeze({
    workspaceId: receipt.workspaceId,
    replacementEpoch: receipt.replacementEpoch,
    databaseName: receipt.databaseName,
    preconditions: receipt.preconditions,
    physicalReads: aggregateSemanticOperationPhysicalReadIo([
      ...receipt.physicalReads,
      ...physicalReads,
    ]),
    exactPhysicalReads: receipt.exactPhysicalReads,
    [SEMANTIC_OPERATION_COMMAND_LIFETIME_RECEIPT]: true as const,
  })
  assertSemanticOperationCommandLifetimeReceipt(next, {
    workspaceId: next.workspaceId,
    replacementEpoch: next.replacementEpoch,
    databaseName: next.databaseName,
  })
  return next
}

export function semanticOperationCommandLifetimeReceiptWithPreflight(
  receipt: SemanticOperationCommandLifetimeReceipt,
  physicalReads: readonly SemanticOperationPhysicalRead[],
  exactPhysicalReads: readonly SemanticOperationExactPhysicalRead[],
): SemanticOperationCommandLifetimeReceipt {
  assertSemanticOperationCommandLifetimeReceipt(receipt, {
    workspaceId: receipt.workspaceId,
    replacementEpoch: receipt.replacementEpoch,
    databaseName: receipt.databaseName,
  })
  const next = Object.freeze({
    workspaceId: receipt.workspaceId,
    replacementEpoch: receipt.replacementEpoch,
    databaseName: receipt.databaseName,
    preconditions: receipt.preconditions,
    physicalReads: aggregateSemanticOperationPhysicalReadIo([
      ...receipt.physicalReads,
      ...physicalReads,
    ]),
    exactPhysicalReads: aggregateSemanticOperationPhysicalReads([
      ...receipt.exactPhysicalReads,
      ...exactPhysicalReads,
    ]),
    [SEMANTIC_OPERATION_COMMAND_LIFETIME_RECEIPT]: true as const,
  })
  assertSemanticOperationCommandLifetimeReceipt(next, {
    workspaceId: next.workspaceId,
    replacementEpoch: next.replacementEpoch,
    databaseName: next.databaseName,
  })
  return next
}

export function assertSemanticOperationCommandLifetimeReceipt(
  receipt: SemanticOperationCommandLifetimeReceipt,
  expected: {
    readonly workspaceId: string
    readonly replacementEpoch: number
    readonly databaseName: string
  },
): void {
  if (
    receipt[SEMANTIC_OPERATION_COMMAND_LIFETIME_RECEIPT] !== true ||
    receipt.workspaceId !== expected.workspaceId ||
    receipt.replacementEpoch !== expected.replacementEpoch ||
    receipt.databaseName !== expected.databaseName ||
    receipt.preconditions.length !== 1 ||
    receipt.preconditions[0].kind !== 'storage-compaction-write-admission' ||
    receipt.preconditions[0].commandPhysicalReads !== 0
  ) {
    throw new Error('SemanticOperationCommandLifetimeReceiptInvalid')
  }
  for (const read of receipt.physicalReads) {
    assertSemanticOperationPhysicalCount(read.requestCount, 'commandLifetimeReadRequests')
    assertSemanticOperationPhysicalCount(read.rowCount, 'commandLifetimeReadRows')
    assertSemanticOperationPhysicalCount(read.maxRequestRows, 'commandLifetimeReadBatch')
    assertSemanticOperationPhysicalCount(read.estimatedBytes, 'commandLifetimeReadBytes')
  }
  for (const read of receipt.exactPhysicalReads) {
    assertSemanticOperationPhysicalCount(read.requestCount, 'commandLifetimeExactReadRequests')
    assertSemanticOperationPhysicalCount(read.rowCount, 'commandLifetimeExactReadRows')
  }
}

export interface SemanticOperationDelegationCapability<
  Command extends WorkspaceCommand,
  ChildKind extends SemanticOperationKind,
> {
  readonly operationKind: Command['kind']
  childOperationKind(command: Command): ChildKind
  readonly [SEMANTIC_OPERATION_DELEGATION]: true
}

export function semanticOperationDelegationCapability<
  Command extends WorkspaceCommand,
  const ChildKind extends SemanticOperationKind,
>(definition: {
  readonly operationKind: Command['kind']
  childOperationKind(command: Command): ChildKind
}): SemanticOperationDelegationCapability<Command, ChildKind> {
  return Object.freeze({
    ...definition,
    [SEMANTIC_OPERATION_DELEGATION]: true as const,
  })
}

export interface SemanticOperationEffectKindContract {
  readonly kind: 'effect-kinds'
  readonly permitted: readonly SemanticOperationEffectKind[]
  requiredWhenMutated(tableNames: ReadonlySet<string>): readonly SemanticOperationEffectKind[]
}

export interface SemanticOperationExactInvalidationContract<ResourceInput, Receipt = undefined> {
  readonly kind: 'exact-invalidations'
  expected(
    input: ResourceInput,
    didMutateStorage: boolean,
    receipt: Receipt,
  ): readonly WorkspaceDependency[]
}

export type SemanticOperationEffectContract<ResourceInput, Receipt = undefined> =
  | SemanticOperationEffectKindContract
  | SemanticOperationExactInvalidationContract<ResourceInput, Receipt>

export type SemanticOperationExactPhysicalMutation = {
  readonly tableName: PhysicalStorageTableName
} & (
  | {
      readonly operation: 'write' | 'delete'
      readonly key: unknown
    }
  | {
      readonly operation: 'delete-group'
      readonly address: string
      readonly affectedRows: number
    }
)

interface SemanticOperationObservedPhysicalMutation {
  readonly tableName: string
  readonly operation: string
  readonly address?: string
  readonly affectedRows?: number
  readonly key?: unknown
}

export interface SemanticOperationExactPhysicalMutationContract<
  ResourceInput,
  Receipt = undefined,
> {
  expected(
    input: ResourceInput,
    didMutateStorage: boolean,
    receipt: Receipt,
  ): readonly SemanticOperationExactPhysicalMutation[]
}

export type SemanticOperationPhysicalReadOperation =
  | 'get'
  | 'get-many'
  | 'query'
  | 'open-cursor'
  | 'count'

export interface SemanticOperationExactPhysicalRead {
  readonly tableName: PhysicalStorageTableName
  readonly indexKind: 'primary' | 'secondary'
  readonly indexName?: string
  readonly operation: SemanticOperationPhysicalReadOperation
  readonly requestCount: number
  readonly rowCount: number
}

export interface SemanticOperationPhysicalRead extends SemanticOperationExactPhysicalRead {
  readonly maxRequestRows: number
  readonly estimatedBytes: number
}

export type SemanticOperationPhysicalWriteOperation = 'add' | 'put' | 'delete'

export interface SemanticOperationPhysicalWrite {
  readonly tableName: PhysicalStorageTableName
  readonly operation: SemanticOperationPhysicalWriteOperation
  readonly requestCount: number
  readonly rowCount: number
  readonly maxRequestRows: number
  readonly estimatedBytes: number
}

interface SemanticOperationObservedPhysicalWrite {
  readonly tableName: string
  readonly operation: string
  readonly requestCount: number
  readonly rowCount: number
  readonly maxRequestRows: number
}

export interface SemanticOperationExactPhysicalWriteContract<ResourceInput, Receipt = undefined> {
  readonly receiptSource: 'fragment' | 'exact-receipt'
  expected(
    input: ResourceInput,
    transactionExecuted: boolean,
    receipt: Receipt,
  ): readonly SemanticOperationPhysicalWrite[]
}

interface SemanticOperationObservedPhysicalRead {
  readonly tableName: string
  readonly indexKind: string
  readonly indexName?: string
  readonly operation: string
  readonly requestCount: number
  readonly rowCount: number
}

interface SemanticOperationObservedPhysicalReadIo extends SemanticOperationObservedPhysicalRead {
  readonly maxRequestRows: number
  readonly estimatedBytes: number
}

export interface SemanticOperationExactPhysicalReadContract<ResourceInput, Receipt = undefined> {
  expected(
    input: ResourceInput,
    transactionExecuted: boolean,
    receipt: Receipt,
  ): readonly SemanticOperationExactPhysicalRead[]
}

export type SemanticOperationReplayToken = string | number | boolean | null

export type SemanticOperationReplayLeafPlan =
  | {
      readonly kind: 'single-attempt'
      readonly reason:
        | 'billable-side-effect'
        | 'random-identity'
        | 'unfenced-relative-update'
        | 'non-replayable'
    }
  | {
      readonly kind: 'fenced-convergent'
      readonly owner: string
      readonly fence: readonly SemanticOperationReplayToken[]
      readonly desired: readonly SemanticOperationReplayToken[]
      readonly alreadyApplied:
        | 'return-current'
        | 'return-current-or-conflict'
        | 'return-already-applied'
    }
  | {
      readonly kind: 'append-by-key'
      readonly owner: string
      readonly fence: readonly SemanticOperationReplayToken[]
      readonly keys: readonly string[]
      readonly equality: 'canonical-equal-or-conflict'
      readonly lifecycle: 'active-writer'
    }
  | {
      readonly kind: 'durable-page-resume'
      readonly owner: string
      readonly cycle: SemanticOperationReplayToken
      readonly revision: SemanticOperationReplayToken
      readonly cursor: SemanticOperationReplayToken
      readonly doneMarker: string
      readonly limit: number
    }
  | {
      readonly kind: 'compare-and-swap'
      readonly owner: string
      readonly expected: readonly SemanticOperationReplayToken[]
      readonly desired: readonly SemanticOperationReplayToken[]
      readonly outcome: 'request' | 'applied' | 'rejected'
    }
  | {
      readonly kind: 'level-triggered-merge'
      readonly owner: string
      readonly target: readonly SemanticOperationReplayToken[]
      readonly desired: readonly SemanticOperationReplayToken[]
      readonly outcome: 'request' | 'applied' | 'already-applied' | 'terminal' | 'stale' | 'missing'
    }
  | {
      readonly kind: 'caller-at-most-once'
      readonly owner: string
      readonly target: readonly SemanticOperationReplayToken[]
      readonly localConvergence: 'canonical-equal-or-conflict'
      readonly recovery: 'resume-from-durable-phase'
      readonly outcome: 'request' | 'applied' | 'already-applied'
    }

export type SemanticOperationReplayPlan =
  | SemanticOperationReplayLeafPlan
  | {
      readonly kind: 'delegate'
      readonly operationKind: SemanticOperationKind
      readonly child: SemanticOperationReplayLeafPlan
    }

export type SemanticOperationReplayContract<ResourceInput, Receipt> =
  | {
      readonly kind: 'exact-plan'
      expected(input: ResourceInput): SemanticOperationReplayPlan
      observed(receipt: Receipt): SemanticOperationReplayPlan
    }
  | {
      readonly kind: 'receipt-proof'
      assert(input: ResourceInput, receipt: Receipt): void
    }
  | {
      readonly kind: 'caller-single-attempt'
      readonly plan: Extract<SemanticOperationReplayLeafPlan, { readonly kind: 'single-attempt' }>
    }

export interface SemanticOperationIoBound {
  readonly maxRequests: number
  readonly maxRows: number
  readonly maxBatchRows: number
  readonly maxBytes: number
}

export interface SemanticOperationPhysicalBounds {
  readonly reads: SemanticOperationIoBound
  readonly writes: SemanticOperationIoBound
}

export interface SemanticOperationExactPlan {
  readonly replay: SemanticOperationReplayPlan
  readonly bounds: SemanticOperationPhysicalBounds
}

export interface SemanticOperationExactReceipt<
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
  Plan extends SemanticOperationExactPlan | undefined = SemanticOperationExactPlan,
> {
  readonly plan: Plan
  readonly replay?: SemanticOperationReplayPlan
  readonly dependencies: readonly WorkspaceDependency[]
  readonly physicalMutations: readonly (SemanticOperationExactPhysicalMutation & {
    readonly tableName: Tables
  })[]
  readonly physicalReads: readonly (SemanticOperationExactPhysicalRead & {
    readonly tableName: Tables
  })[]
  readonly physicalReadIo: readonly (SemanticOperationPhysicalRead & {
    readonly tableName: Tables
  })[]
  readonly physicalWrites: readonly (SemanticOperationPhysicalWrite & {
    readonly tableName: Tables
  })[]
  readonly [SEMANTIC_OPERATION_EXACT_RECEIPT]: true
}

export interface SemanticOperationReceiptFragment<
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
> {
  readonly dependencies: readonly WorkspaceDependency[]
  readonly physicalMutations: readonly (SemanticOperationExactPhysicalMutation & {
    readonly tableName: Tables
  })[]
  readonly physicalReads: readonly (SemanticOperationExactPhysicalRead & {
    readonly tableName: Tables
  })[]
  readonly physicalWrites: readonly (SemanticOperationPhysicalWrite & {
    readonly tableName: Tables
  })[]
  readonly [SEMANTIC_OPERATION_RECEIPT_FRAGMENT]: true
}

export interface SemanticOperationExactReceiptAccumulator<
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
> {
  absorb<FragmentTables extends Tables>(
    fragment: SemanticOperationReceiptFragment<FragmentTables>,
  ): void
  dependency(...dependencies: readonly WorkspaceDependency[]): void
  physicalMutation(
    mutation: SemanticOperationExactPhysicalMutation & { readonly tableName: Tables },
  ): void
  physicalRead(read: SemanticOperationExactPhysicalRead & { readonly tableName: Tables }): void
  physicalWrite(write: SemanticOperationPhysicalWrite & { readonly tableName: Tables }): void
  snapshotFragment(): SemanticOperationReceiptFragment<Tables>
  sealFragment(): SemanticOperationReceiptFragment<Tables>
  seal(plan: SemanticOperationExactPlan): SemanticOperationExactReceipt<Tables>
}

export function semanticOperationReceiptFragment<
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
>(facts: {
  readonly dependencies?: readonly WorkspaceDependency[]
  readonly physicalMutations?: readonly (SemanticOperationExactPhysicalMutation & {
    readonly tableName: Tables
  })[]
  readonly physicalReads?: readonly (SemanticOperationExactPhysicalRead & {
    readonly tableName: Tables
  })[]
  readonly physicalWrites?: readonly (SemanticOperationPhysicalWrite & {
    readonly tableName: Tables
  })[]
}): SemanticOperationReceiptFragment<Tables> {
  return Object.freeze({
    dependencies: Object.freeze([...(facts.dependencies ?? [])]),
    physicalMutations: Object.freeze([...(facts.physicalMutations ?? [])]),
    physicalReads: Object.freeze([...(facts.physicalReads ?? [])]),
    physicalWrites: Object.freeze([...(facts.physicalWrites ?? [])]),
    [SEMANTIC_OPERATION_RECEIPT_FRAGMENT]: true as const,
  })
}

export function createSemanticOperationExactReceiptAccumulator<
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
>(): SemanticOperationExactReceiptAccumulator<Tables> {
  const dependencies: WorkspaceDependency[] = []
  const physicalMutations = new Map<
    string,
    SemanticOperationExactPhysicalMutation & { readonly tableName: Tables }
  >()
  const physicalReads: (SemanticOperationExactPhysicalRead & {
    readonly tableName: Tables
  })[] = []
  const physicalWrites: (SemanticOperationPhysicalWrite & {
    readonly tableName: Tables
  })[] = []
  let sealed = false
  const assertOpen = () => {
    if (sealed) throw new Error('SemanticOperationExactReceiptAccumulatorSealed')
  }
  const snapshot = () => {
    assertOpen()
    return {
      dependencies: normalizeWorkspaceDependencies(dependencies),
      physicalMutations: [...physicalMutations.values()],
      physicalReads: aggregateSemanticOperationPhysicalReads(physicalReads),
      physicalWrites: aggregateSemanticOperationPhysicalWrites(physicalWrites),
    }
  }
  const finish = () => {
    const facts = snapshot()
    sealed = true
    return facts
  }
  return Object.freeze({
    absorb<FragmentTables extends Tables>(
      fragment: SemanticOperationReceiptFragment<FragmentTables>,
    ) {
      assertOpen()
      if (fragment[SEMANTIC_OPERATION_RECEIPT_FRAGMENT] !== true) {
        throw new Error('SemanticOperationReceiptFragmentInvalid')
      }
      dependencies.push(...fragment.dependencies)
      for (const mutation of fragment.physicalMutations) {
        accumulateSemanticOperationPhysicalMutation(
          physicalMutations,
          mutation as SemanticOperationExactPhysicalMutation & { readonly tableName: Tables },
        )
      }
      physicalReads.push(
        ...(fragment.physicalReads as readonly (SemanticOperationExactPhysicalRead & {
          readonly tableName: Tables
        })[]),
      )
      physicalWrites.push(
        ...(fragment.physicalWrites as readonly (SemanticOperationPhysicalWrite & {
          readonly tableName: Tables
        })[]),
      )
    },
    dependency(...values: readonly WorkspaceDependency[]) {
      assertOpen()
      dependencies.push(...values)
    },
    physicalMutation(
      mutation: SemanticOperationExactPhysicalMutation & { readonly tableName: Tables },
    ) {
      assertOpen()
      accumulateSemanticOperationPhysicalMutation(physicalMutations, mutation)
    },
    physicalRead(read: SemanticOperationExactPhysicalRead & { readonly tableName: Tables }) {
      assertOpen()
      physicalReads.push(read)
    },
    physicalWrite(write: SemanticOperationPhysicalWrite & { readonly tableName: Tables }) {
      assertOpen()
      physicalWrites.push(write)
    },
    snapshotFragment() {
      return semanticOperationReceiptFragment(snapshot())
    },
    sealFragment() {
      return semanticOperationReceiptFragment(finish())
    },
    seal(plan: SemanticOperationExactPlan) {
      return semanticOperationExactReceipt(plan, finish())
    },
  })
}

function aggregateSemanticOperationPhysicalWrites<Tables extends PhysicalStorageTableName>(
  writes: readonly (SemanticOperationPhysicalWrite & { readonly tableName: Tables })[],
): readonly (SemanticOperationPhysicalWrite & { readonly tableName: Tables })[] {
  const aggregated = new Map<
    string,
    {
      tableName: Tables
      operation: SemanticOperationPhysicalWriteOperation
      requestCount: number
      rowCount: number
      maxRequestRows: number
      estimatedBytes: number
    }
  >()
  for (const write of writes) {
    assertSemanticOperationPhysicalWrite(write)
    const key = `${write.tableName}\u0000${write.operation}`
    const current = aggregated.get(key)
    if (!current) {
      aggregated.set(key, { ...write })
      continue
    }
    current.requestCount = saturatingPhysicalCount(current.requestCount, write.requestCount)
    current.rowCount = saturatingPhysicalCount(current.rowCount, write.rowCount)
    current.maxRequestRows = Math.max(current.maxRequestRows, write.maxRequestRows)
    current.estimatedBytes = saturatingPhysicalCount(current.estimatedBytes, write.estimatedBytes)
  }
  return Object.freeze([...aggregated.values()].map((write) => Object.freeze(write)))
}

function assertSemanticOperationPhysicalWrite(write: SemanticOperationPhysicalWrite): void {
  assertSemanticOperationPhysicalCount(write.requestCount, 'writeRequests')
  assertSemanticOperationPhysicalCount(write.rowCount, 'writeRows')
  assertSemanticOperationPhysicalCount(write.maxRequestRows, 'writeBatch')
  assertSemanticOperationPhysicalCount(write.estimatedBytes, 'writeBytes')
  if (
    (write.requestCount === 0 &&
      (write.rowCount !== 0 || write.maxRequestRows !== 0 || write.estimatedBytes !== 0)) ||
    write.maxRequestRows > write.rowCount ||
    (write.requestCount > 0 &&
      Math.ceil(write.rowCount / write.requestCount) > write.maxRequestRows)
  ) {
    throw new Error('SemanticOperationPhysicalWriteInvalid')
  }
}

function saturatingPhysicalCount(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function accumulateSemanticOperationPhysicalMutation<Tables extends PhysicalStorageTableName>(
  mutations: Map<string, SemanticOperationExactPhysicalMutation & { readonly tableName: Tables }>,
  mutation: SemanticOperationExactPhysicalMutation & { readonly tableName: Tables },
): void {
  const address =
    mutation.operation === 'delete-group'
      ? mutation.address
      : physicalStorageMutationAddress(mutation.tableName, mutation.key)
  const current = mutations.get(address)
  if (
    current?.operation === 'delete-group' &&
    mutation.operation === 'delete-group' &&
    current.tableName === mutation.tableName
  ) {
    mutations.set(address, {
      ...mutation,
      affectedRows: current.affectedRows + mutation.affectedRows,
    })
    return
  }
  mutations.set(address, mutation)
}

export function bindSemanticOperationExactReceiptAccumulator<
  Tables extends PhysicalStorageTableName,
>(transaction: object, accumulator: SemanticOperationExactReceiptAccumulator<Tables>): () => void {
  const identity = semanticOperationReceiptTransactionIdentity(transaction)
  if (semanticOperationReceiptAccumulators.has(identity)) {
    throw new Error('SemanticOperationExactReceiptAccumulatorAlreadyBound')
  }
  semanticOperationReceiptAccumulators.set(
    identity,
    accumulator as SemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>,
  )
  let active = true
  return () => {
    if (!active) return
    active = false
    semanticOperationReceiptAccumulators.delete(identity)
  }
}

export function absorbSemanticOperationReceiptFragment<Tables extends PhysicalStorageTableName>(
  transaction: object,
  fragment: SemanticOperationReceiptFragment<Tables>,
): void {
  semanticOperationReceiptAccumulators
    .get(semanticOperationReceiptTransactionIdentity(transaction))
    ?.absorb(fragment)
}

export function boundSemanticOperationExactReceiptAccumulator<
  Tables extends PhysicalStorageTableName,
>(transaction: object): SemanticOperationExactReceiptAccumulator<Tables> | undefined {
  return semanticOperationReceiptAccumulators.get(
    semanticOperationReceiptTransactionIdentity(transaction),
  ) as SemanticOperationExactReceiptAccumulator<Tables> | undefined
}

export function hasSemanticOperationExactReceiptAccumulator(transaction: object): boolean {
  return semanticOperationReceiptAccumulators.has(
    semanticOperationReceiptTransactionIdentity(transaction),
  )
}

function semanticOperationReceiptTransactionIdentity(transaction: object): object {
  const idbTransaction = (transaction as { readonly idbtrans?: unknown }).idbtrans
  return typeof idbTransaction === 'object' && idbTransaction !== null
    ? idbTransaction
    : transaction
}

export async function withSemanticOperationExactReceiptAccumulator<
  Tables extends PhysicalStorageTableName,
  Result,
>(
  transaction: object,
  operation: (
    accumulator: SemanticOperationExactReceiptAccumulator<Tables>,
  ) => Promise<Result> | Result,
): Promise<Result> {
  const accumulator = createSemanticOperationExactReceiptAccumulator<Tables>()
  const unbind = bindSemanticOperationExactReceiptAccumulator(transaction, accumulator)
  try {
    return await operation(accumulator)
  } finally {
    unbind()
  }
}

export interface SemanticOperationPhysicalWriteCollection<Result> {
  readonly value: Result
  readonly fragment?: SemanticOperationReceiptFragment<PhysicalStorageTableName>
}

export async function collectSemanticOperationPhysicalWrites<Result>(
  transaction: object,
  receiptSource:
    | SemanticOperationExactPhysicalWriteContract<unknown, unknown>['receiptSource']
    | undefined,
  operation: () => Promise<Result> | Result,
): Promise<SemanticOperationPhysicalWriteCollection<Result>> {
  if (receiptSource !== 'exact-receipt') return { value: await operation() }
  return withSemanticOperationExactReceiptAccumulator(transaction, async (accumulator) => {
    const value = await operation()
    return { value, fragment: accumulator.sealFragment() }
  })
}

export function attachSemanticOperationPhysicalIo<Receipt>(
  receipt: Receipt,
  fragment: SemanticOperationReceiptFragment<PhysicalStorageTableName> | undefined,
  physicalReads: readonly SemanticOperationObservedPhysicalReadIo[],
): Receipt {
  if (!fragment && physicalReads.length === 0) return receipt
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    (receipt as { readonly [SEMANTIC_OPERATION_EXACT_RECEIPT]?: unknown })[
      SEMANTIC_OPERATION_EXACT_RECEIPT
    ] !== true
  ) {
    throw new Error('SemanticOperationExactReceiptMissing')
  }
  const exact = receipt as unknown as SemanticOperationExactReceipt<
    PhysicalStorageTableName,
    SemanticOperationExactPlan | undefined
  >
  if (exact.physicalWrites.length > 0) {
    throw new Error('SemanticOperationExactReceiptPhysicalWritesAlreadyAttached')
  }
  if (exact.physicalReadIo.length > 0) {
    throw new Error('SemanticOperationExactReceiptPhysicalReadsAlreadyAttached')
  }
  return semanticOperationExactReceipt(exact.plan, {
    ...(!exact.plan && exact.replay ? { replay: exact.replay } : {}),
    dependencies: exact.dependencies,
    physicalMutations: exact.physicalMutations,
    physicalReads: exact.physicalReads,
    physicalReadIo: physicalReads as readonly SemanticOperationPhysicalRead[],
    physicalWrites: fragment?.physicalWrites ?? exact.physicalWrites,
  }) as Receipt
}

export function attachSemanticOperationExactPhysicalReads<Receipt>(
  receipt: Receipt,
  physicalReads: readonly SemanticOperationExactPhysicalRead[],
): Receipt {
  if (physicalReads.length === 0) return receipt
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    (receipt as { readonly [SEMANTIC_OPERATION_EXACT_RECEIPT]?: unknown })[
      SEMANTIC_OPERATION_EXACT_RECEIPT
    ] !== true
  ) {
    throw new Error('SemanticOperationExactReceiptMissing')
  }
  const exact = receipt as unknown as SemanticOperationExactReceipt<
    PhysicalStorageTableName,
    SemanticOperationExactPlan | undefined
  >
  return semanticOperationExactReceipt(exact.plan, {
    ...(!exact.plan && exact.replay ? { replay: exact.replay } : {}),
    dependencies: exact.dependencies,
    physicalMutations: exact.physicalMutations,
    physicalReads: [...exact.physicalReads, ...physicalReads],
    physicalReadIo: exact.physicalReadIo,
    physicalWrites: exact.physicalWrites,
  }) as Receipt
}

export function semanticOperationReceiptFragmentPhysicalMutationContract<
  ResourceInput,
  Tables extends PhysicalStorageTableName,
>(): SemanticOperationExactPhysicalMutationContract<
  ResourceInput,
  SemanticOperationReceiptFragment<Tables>
> {
  return Object.freeze({
    expected: (
      _input: ResourceInput,
      didMutateStorage: boolean,
      receipt: SemanticOperationReceiptFragment<Tables>,
    ) => (didMutateStorage ? receipt.physicalMutations : []),
  })
}

export function semanticOperationReceiptFragmentPhysicalWriteContract<
  ResourceInput,
  Tables extends PhysicalStorageTableName,
>(): SemanticOperationExactPhysicalWriteContract<
  ResourceInput,
  SemanticOperationReceiptFragment<Tables>
> {
  return Object.freeze({
    receiptSource: 'fragment' as const,
    expected: (
      _input: ResourceInput,
      transactionExecuted: boolean,
      receipt: SemanticOperationReceiptFragment<Tables>,
    ) => (transactionExecuted ? receipt.physicalWrites : []),
  })
}

export function semanticOperationExactPlan(definition: {
  readonly replay: SemanticOperationReplayPlan
  readonly bounds: SemanticOperationPhysicalBounds
}): SemanticOperationExactPlan {
  assertSemanticOperationIoBound(definition.bounds.reads)
  assertSemanticOperationIoBound(definition.bounds.writes)
  return Object.freeze({
    replay: freezeSemanticOperationReplayPlan(definition.replay),
    bounds: Object.freeze({
      reads: Object.freeze({ ...definition.bounds.reads }),
      writes: Object.freeze({ ...definition.bounds.writes }),
    }),
  })
}

function freezeSemanticOperationReplayTokens(
  values: readonly SemanticOperationReplayToken[],
): readonly SemanticOperationReplayToken[] {
  for (const value of values) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      (typeof value !== 'number' || !Number.isSafeInteger(value))
    ) {
      throw new Error('SemanticOperationReplayTokenInvalid')
    }
  }
  return Object.freeze([...values])
}

function freezeSemanticOperationReplayLeafPlan(
  plan: SemanticOperationReplayLeafPlan,
): SemanticOperationReplayLeafPlan {
  switch (plan.kind) {
    case 'single-attempt':
      return Object.freeze({ ...plan })
    case 'fenced-convergent':
      return Object.freeze({
        ...plan,
        fence: freezeSemanticOperationReplayTokens(plan.fence),
        desired: freezeSemanticOperationReplayTokens(plan.desired),
      })
    case 'append-by-key':
      return Object.freeze({
        ...plan,
        fence: freezeSemanticOperationReplayTokens(plan.fence),
        keys: Object.freeze([...plan.keys]),
      })
    case 'durable-page-resume':
      if (!Number.isSafeInteger(plan.limit) || plan.limit <= 0) {
        throw new Error('SemanticOperationReplayLimitInvalid')
      }
      freezeSemanticOperationReplayTokens([plan.cycle, plan.revision, plan.cursor])
      return Object.freeze({ ...plan })
    case 'compare-and-swap':
      return Object.freeze({
        ...plan,
        expected: freezeSemanticOperationReplayTokens(plan.expected),
        desired: freezeSemanticOperationReplayTokens(plan.desired),
      })
    case 'level-triggered-merge':
      return Object.freeze({
        ...plan,
        target: freezeSemanticOperationReplayTokens(plan.target),
        desired: freezeSemanticOperationReplayTokens(plan.desired),
      })
    case 'caller-at-most-once':
      return Object.freeze({
        ...plan,
        target: freezeSemanticOperationReplayTokens(plan.target),
      })
  }
}

function freezeSemanticOperationReplayPlan(
  plan: SemanticOperationReplayPlan,
): SemanticOperationReplayPlan {
  if (plan.kind !== 'delegate') return freezeSemanticOperationReplayLeafPlan(plan)
  return Object.freeze({
    ...plan,
    child: freezeSemanticOperationReplayLeafPlan(plan.child),
  })
}

export function semanticOperationExactReceiptReplayContract<
  ResourceInput,
  Tables extends PhysicalStorageTableName = PhysicalStorageTableName,
>(
  expected: (input: ResourceInput) => SemanticOperationReplayPlan,
): SemanticOperationReplayContract<
  ResourceInput,
  SemanticOperationExactReceipt<Tables, SemanticOperationExactPlan | undefined>
> {
  return Object.freeze({
    kind: 'exact-plan' as const,
    expected,
    observed: (
      receipt: SemanticOperationExactReceipt<Tables, SemanticOperationExactPlan | undefined>,
    ) => {
      if (!receipt.replay) throw new Error('SemanticOperationExactReplayPlanMissing')
      return receipt.replay
    },
  })
}

export function semanticOperationExactReceiptReplayProofContract<ResourceInput>(
  assert: (input: ResourceInput, receipt: SemanticOperationExactReceipt) => void,
): SemanticOperationReplayContract<ResourceInput, SemanticOperationExactReceipt> {
  return Object.freeze({
    kind: 'receipt-proof' as const,
    assert,
  })
}

export function semanticOperationCallerSingleAttemptReplayContract<ResourceInput, Receipt>(
  reason: Extract<SemanticOperationReplayLeafPlan, { readonly kind: 'single-attempt' }>['reason'],
): Extract<
  SemanticOperationReplayContract<ResourceInput, Receipt>,
  { readonly kind: 'caller-single-attempt' }
> {
  return Object.freeze({
    kind: 'caller-single-attempt' as const,
    plan: Object.freeze({ kind: 'single-attempt' as const, reason }),
  })
}

function aggregateSemanticOperationPhysicalReads<Tables extends PhysicalStorageTableName>(
  reads: readonly (SemanticOperationExactPhysicalRead & { readonly tableName: Tables })[],
): readonly (SemanticOperationExactPhysicalRead & { readonly tableName: Tables })[] {
  const aggregated = new Map<
    string,
    {
      tableName: Tables
      indexKind: SemanticOperationExactPhysicalRead['indexKind']
      indexName?: string
      operation: SemanticOperationPhysicalReadOperation
      requestCount: number
      rowCount: number
    }
  >()
  for (const read of reads) {
    const key = `${read.tableName}\u0000${read.indexKind}\u0000${read.indexName ?? ''}\u0000${read.operation}`
    const current = aggregated.get(key)
    if (!current) {
      aggregated.set(key, {
        tableName: read.tableName,
        indexKind: read.indexKind,
        ...(read.indexName ? { indexName: read.indexName } : {}),
        operation: read.operation,
        requestCount: read.requestCount,
        rowCount: read.rowCount,
      })
      continue
    }
    current.requestCount += read.requestCount
    current.rowCount += read.rowCount
  }
  return Object.freeze(
    [...aggregated.values()].map((read) =>
      Object.freeze({
        tableName: read.tableName,
        indexKind: read.indexKind,
        ...(read.indexName ? { indexName: read.indexName } : {}),
        operation: read.operation,
        requestCount: read.requestCount,
        rowCount: read.rowCount,
      }),
    ),
  )
}

function aggregateSemanticOperationPhysicalReadIo<Tables extends PhysicalStorageTableName>(
  reads: readonly (SemanticOperationPhysicalRead & { readonly tableName: Tables })[],
): readonly (SemanticOperationPhysicalRead & { readonly tableName: Tables })[] {
  const aggregated = new Map<
    string,
    SemanticOperationPhysicalRead & { readonly tableName: Tables }
  >()
  for (const read of reads) {
    const key = `${read.tableName}\u0000${read.indexKind}\u0000${read.indexName ?? ''}\u0000${read.operation}`
    const current = aggregated.get(key)
    if (!current) {
      aggregated.set(key, { ...read })
      continue
    }
    aggregated.set(key, {
      ...current,
      requestCount: saturatingPhysicalCount(current.requestCount, read.requestCount),
      rowCount: saturatingPhysicalCount(current.rowCount, read.rowCount),
      maxRequestRows: Math.max(current.maxRequestRows, read.maxRequestRows),
      estimatedBytes: saturatingPhysicalCount(current.estimatedBytes, read.estimatedBytes),
    })
  }
  return Object.freeze(
    [...aggregated.values()].map((read) =>
      Object.freeze({
        tableName: read.tableName,
        indexKind: read.indexKind,
        ...(read.indexName ? { indexName: read.indexName } : {}),
        operation: read.operation,
        requestCount: read.requestCount,
        rowCount: read.rowCount,
        maxRequestRows: read.maxRequestRows,
        estimatedBytes: read.estimatedBytes,
      }),
    ),
  )
}

export function semanticOperationExactReceipt<
  Tables extends PhysicalStorageTableName,
  Plan extends SemanticOperationExactPlan | undefined,
>(
  plan: Plan,
  facts: {
    readonly replay?: SemanticOperationReplayPlan
    readonly dependencies: readonly WorkspaceDependency[]
    readonly physicalMutations: readonly (SemanticOperationExactPhysicalMutation & {
      readonly tableName: Tables
    })[]
    readonly physicalReads: readonly (SemanticOperationExactPhysicalRead & {
      readonly tableName: Tables
    })[]
    readonly physicalReadIo?: readonly (SemanticOperationPhysicalRead & {
      readonly tableName: Tables
    })[]
    readonly physicalWrites?: readonly (SemanticOperationPhysicalWrite & {
      readonly tableName: Tables
    })[]
  },
): SemanticOperationExactReceipt<Tables, Plan> {
  const physicalReadIo = aggregateSemanticOperationPhysicalReadIo(facts.physicalReadIo ?? [])
  const physicalWrites = aggregateSemanticOperationPhysicalWrites(facts.physicalWrites ?? [])
  if (plan && facts.replay) throw new Error('SemanticOperationReplayPlanDuplicated')
  const replay = plan?.replay ?? facts.replay
  if (plan) {
    assertSemanticOperationReadFactsWithinBound(physicalReadIo, plan.bounds.reads)
    assertSemanticOperationWriteFactsWithinBound(physicalWrites, plan.bounds.writes)
  }
  return Object.freeze({
    plan,
    ...(replay ? { replay: freezeSemanticOperationReplayPlan(replay) } : {}),
    dependencies: Object.freeze([...facts.dependencies]),
    physicalMutations: Object.freeze([...facts.physicalMutations]),
    physicalReads: Object.freeze([...facts.physicalReads]),
    physicalReadIo,
    physicalWrites,
    [SEMANTIC_OPERATION_EXACT_RECEIPT]: true as const,
  })
}

export function semanticOperationExactMutationReceiptContracts<
  ResourceInput,
  Tables extends PhysicalStorageTableName,
  Plan extends SemanticOperationExactPlan | undefined = undefined,
>(): {
  readonly exactPhysicalMutations: SemanticOperationExactPhysicalMutationContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables, Plan>
  >
  readonly exactPhysicalWrites: SemanticOperationExactPhysicalWriteContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables, Plan>
  >
} {
  return Object.freeze({
    exactPhysicalMutations: Object.freeze({
      expected: (
        _input: ResourceInput,
        didMutateStorage: boolean,
        receipt: SemanticOperationExactReceipt<Tables, Plan>,
      ) => (didMutateStorage ? receipt.physicalMutations : []),
    }),
    exactPhysicalWrites: Object.freeze({
      receiptSource: 'exact-receipt' as const,
      expected: (
        _input: ResourceInput,
        transactionExecuted: boolean,
        receipt: SemanticOperationExactReceipt<Tables, Plan>,
      ) => (transactionExecuted ? receipt.physicalWrites : []),
    }),
  })
}

export function semanticOperationExactMutationAndInvalidationReceiptContracts<
  ResourceInput,
  Tables extends PhysicalStorageTableName,
  Plan extends SemanticOperationExactPlan | undefined = undefined,
>(): {
  readonly exactInvalidations: SemanticOperationExactInvalidationContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables, Plan>
  >
  readonly exactPhysicalMutations: SemanticOperationExactPhysicalMutationContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables, Plan>
  >
  readonly exactPhysicalWrites: SemanticOperationExactPhysicalWriteContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables, Plan>
  >
} {
  return Object.freeze({
    exactInvalidations: Object.freeze({
      kind: 'exact-invalidations' as const,
      expected: (
        _input: ResourceInput,
        didMutateStorage: boolean,
        receipt: SemanticOperationExactReceipt<Tables, Plan>,
      ) => (didMutateStorage ? receipt.dependencies : []),
    }),
    ...semanticOperationExactMutationReceiptContracts<ResourceInput, Tables, Plan>(),
  })
}

export function semanticOperationExactReceiptPhysicalReadContract<
  ResourceInput,
  Tables extends PhysicalStorageTableName,
  Plan extends SemanticOperationExactPlan | undefined,
>(): SemanticOperationExactPhysicalReadContract<
  ResourceInput,
  SemanticOperationExactReceipt<Tables, Plan>
> {
  return Object.freeze({
    expected: (
      _input: ResourceInput,
      transactionExecuted: boolean,
      receipt: SemanticOperationExactReceipt<Tables, Plan>,
    ) => (transactionExecuted ? receipt.physicalReads : []),
  })
}

function assertSemanticOperationReadFactsWithinBound(
  reads: readonly SemanticOperationPhysicalRead[],
  bound: SemanticOperationIoBound,
): void {
  let requests = 0
  let rows = 0
  let bytes = 0
  for (const read of reads) {
    assertSemanticOperationPhysicalCount(read.requestCount, 'readRequests')
    assertSemanticOperationPhysicalCount(read.rowCount, 'readRows')
    assertSemanticOperationPhysicalCount(read.maxRequestRows, 'readBatch')
    assertSemanticOperationPhysicalCount(read.estimatedBytes, 'readBytes')
    if (
      (read.requestCount === 0 &&
        (read.rowCount !== 0 || read.maxRequestRows !== 0 || read.estimatedBytes !== 0)) ||
      read.maxRequestRows > read.rowCount ||
      (read.requestCount > 0 && Math.ceil(read.rowCount / read.requestCount) > read.maxRequestRows)
    ) {
      throw new Error('SemanticOperationPhysicalBoundExceeded:readBatch')
    }
    if (read.maxRequestRows > bound.maxBatchRows) {
      throw semanticOperationPhysicalBoundError(
        'readBatch',
        read.maxRequestRows,
        bound.maxBatchRows,
      )
    }
    requests = saturatingPhysicalCount(requests, read.requestCount)
    rows = saturatingPhysicalCount(rows, read.rowCount)
    bytes = saturatingPhysicalCount(bytes, read.estimatedBytes)
  }
  if (requests > bound.maxRequests) {
    throw semanticOperationPhysicalBoundError(
      'readRequests',
      requests,
      bound.maxRequests,
      reads.map(
        (read) =>
          `${read.tableName}.${read.indexName ?? ':id'}.${read.operation}=${read.requestCount}`,
      ),
    )
  }
  if (rows > bound.maxRows) {
    throw semanticOperationPhysicalBoundError('readRows', rows, bound.maxRows)
  }
  if (bytes > bound.maxBytes) {
    throw semanticOperationPhysicalBoundError('readBytes', bytes, bound.maxBytes)
  }
}

function assertSemanticOperationWriteFactsWithinBound(
  writes: readonly SemanticOperationPhysicalWrite[],
  bound: SemanticOperationIoBound,
): void {
  let requests = 0
  let rows = 0
  let bytes = 0
  for (const write of writes) {
    assertSemanticOperationPhysicalWrite(write)
    if (write.maxRequestRows > bound.maxBatchRows) {
      throw semanticOperationPhysicalBoundError(
        'writeBatch',
        write.maxRequestRows,
        bound.maxBatchRows,
      )
    }
    requests = saturatingPhysicalCount(requests, write.requestCount)
    rows = saturatingPhysicalCount(rows, write.rowCount)
    bytes = saturatingPhysicalCount(bytes, write.estimatedBytes)
  }
  if (requests > bound.maxRequests) {
    throw semanticOperationPhysicalBoundError('writeRequests', requests, bound.maxRequests)
  }
  if (rows > bound.maxRows) {
    throw semanticOperationPhysicalBoundError('writeRows', rows, bound.maxRows)
  }
  if (bytes > bound.maxBytes) {
    throw semanticOperationPhysicalBoundError('writeBytes', bytes, bound.maxBytes)
  }
}

function semanticOperationPhysicalBoundError(
  name: string,
  observed: number,
  maximum: number,
  details: readonly string[] = [],
): Error {
  return new Error(
    `SemanticOperationPhysicalBoundExceeded:${name}:${observed}:${maximum}${details.length > 0 ? `:${details.join(',')}` : ''}`,
  )
}

function assertSemanticOperationPhysicalCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`SemanticOperationPhysicalCountInvalid:${name}`)
  }
}

export function semanticOperationExactReceiptContracts<
  ResourceInput,
  Tables extends PhysicalStorageTableName,
>(): {
  readonly effects: SemanticOperationExactInvalidationContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables>
  >
  readonly exactPhysicalMutations: SemanticOperationExactPhysicalMutationContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables>
  >
  readonly exactPhysicalReads: SemanticOperationExactPhysicalReadContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables>
  >
  readonly exactPhysicalWrites: SemanticOperationExactPhysicalWriteContract<
    ResourceInput,
    SemanticOperationExactReceipt<Tables>
  >
} {
  return Object.freeze({
    effects: Object.freeze({
      kind: 'exact-invalidations' as const,
      expected: (
        _input: ResourceInput,
        didMutateStorage: boolean,
        receipt: SemanticOperationExactReceipt<Tables>,
      ) => (didMutateStorage ? receipt.dependencies : []),
    }),
    exactPhysicalMutations: Object.freeze({
      expected: (
        _input: ResourceInput,
        didMutateStorage: boolean,
        receipt: SemanticOperationExactReceipt<Tables>,
      ) => (didMutateStorage ? receipt.physicalMutations : []),
    }),
    exactPhysicalReads: semanticOperationExactReceiptPhysicalReadContract<
      ResourceInput,
      Tables,
      SemanticOperationExactPlan
    >(),
    exactPhysicalWrites: Object.freeze({
      receiptSource: 'exact-receipt' as const,
      expected: (
        _input: ResourceInput,
        transactionExecuted: boolean,
        receipt: SemanticOperationExactReceipt<Tables>,
      ) => (transactionExecuted ? receipt.physicalWrites : []),
    }),
  })
}

function assertSemanticOperationIoBound(bound: SemanticOperationIoBound): void {
  for (const [name, value] of Object.entries(bound)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`SemanticOperationPhysicalBoundInvalid:${name}`)
    }
  }
  if (bound.maxBatchRows > bound.maxRows) {
    throw new Error('SemanticOperationPhysicalBoundInvalid:maxBatchRows')
  }
}

export interface SemanticOperationDescriptor<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt = undefined,
> {
  readonly operationKind: Kind
  readonly transaction: PhysicalTransactionPlan<Tables>
  resources(input: ResourceInput): readonly string[]
  readonly permittedWrites: readonly Tables[]
  readonly requiredWritesWhenMutated: readonly Tables[]
  readonly effects: SemanticOperationEffectContract<ResourceInput, Receipt>
  readonly exactInvalidations?: SemanticOperationExactInvalidationContract<ResourceInput, Receipt>
  readonly exactPhysicalMutations?: SemanticOperationExactPhysicalMutationContract<
    ResourceInput,
    Receipt
  >
  readonly exactPhysicalReads?: SemanticOperationExactPhysicalReadContract<ResourceInput, Receipt>
  readonly exactPhysicalWrites?: SemanticOperationExactPhysicalWriteContract<ResourceInput, Receipt>
  readonly replay?: SemanticOperationReplayContract<ResourceInput, Receipt>
  readonly [SEMANTIC_OPERATION_DESCRIPTOR]: true
}

export function semanticOperationDescriptor<
  const Kind extends SemanticOperationKind,
  const TransactionCapability extends PhysicalTransactionCapability,
  ResourceInput,
  Receipt = undefined,
>(definition: {
  readonly operationKind: Kind
  readonly transaction: TransactionCapability
  resources(input: ResourceInput): readonly string[]
  readonly permittedWrites: readonly CapabilityTables<TransactionCapability>[]
  readonly requiredWritesWhenMutated: readonly CapabilityTables<TransactionCapability>[]
  readonly effects: SemanticOperationEffectContract<ResourceInput, Receipt>
  readonly exactInvalidations?: SemanticOperationExactInvalidationContract<ResourceInput, Receipt>
  readonly exactPhysicalMutations?: SemanticOperationExactPhysicalMutationContract<
    ResourceInput,
    Receipt
  >
  readonly exactPhysicalReads?: SemanticOperationExactPhysicalReadContract<ResourceInput, Receipt>
  readonly exactPhysicalWrites?: SemanticOperationExactPhysicalWriteContract<ResourceInput, Receipt>
  readonly replay?: SemanticOperationReplayContract<ResourceInput, Receipt>
}): SemanticOperationDescriptor<
  Kind,
  CapabilityTables<TransactionCapability>,
  ResourceInput,
  Receipt
> {
  const transactionTables = new Set<string>(definition.transaction.tableNames)
  for (const tableName of definition.permittedWrites) {
    if (!transactionTables.has(tableName)) {
      throw new Error(`SemanticOperationWriteOutsideTransaction:${tableName}`)
    }
  }
  for (const tableName of definition.requiredWritesWhenMutated) {
    if (!definition.permittedWrites.includes(tableName)) {
      throw new Error(`SemanticOperationRequiredWriteNotPermitted:${tableName}`)
    }
  }
  return Object.freeze({
    operationKind: definition.operationKind,
    transaction: physicalTransactionPlan(definition.transaction),
    resources: definition.resources,
    permittedWrites: freezeValues(definition.permittedWrites),
    requiredWritesWhenMutated: freezeValues(definition.requiredWritesWhenMutated),
    effects: Object.freeze({ ...definition.effects }),
    ...(definition.exactInvalidations
      ? { exactInvalidations: Object.freeze({ ...definition.exactInvalidations }) }
      : {}),
    ...(definition.exactPhysicalMutations
      ? { exactPhysicalMutations: Object.freeze({ ...definition.exactPhysicalMutations }) }
      : {}),
    ...(definition.exactPhysicalReads
      ? { exactPhysicalReads: Object.freeze({ ...definition.exactPhysicalReads }) }
      : {}),
    ...(definition.exactPhysicalWrites
      ? { exactPhysicalWrites: Object.freeze({ ...definition.exactPhysicalWrites }) }
      : {}),
    ...(definition.replay ? { replay: Object.freeze({ ...definition.replay }) } : {}),
    [SEMANTIC_OPERATION_DESCRIPTOR]: true as const,
  })
}

export function semanticOperationResourceNames<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  input: ResourceInput,
): readonly string[] {
  return Object.freeze([...new Set(descriptor.resources(input))].sort())
}

export function assertSemanticOperationWrites<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  tableNames: ReadonlySet<string>,
  didMutateStorage: boolean,
): void {
  const permitted = new Set<string>(descriptor.permittedWrites)
  for (const tableName of tableNames) {
    if (!permitted.has(tableName)) throw new Error(`SemanticOperationWriteUndeclared:${tableName}`)
  }
  if (!didMutateStorage) return
  for (const tableName of descriptor.requiredWritesWhenMutated) {
    if (!tableNames.has(tableName)) throw new Error(`SemanticOperationWriteMissing:${tableName}`)
  }
}

export function assertSemanticOperationEffectKinds<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  observed: ReadonlySet<SemanticOperationEffectKind>,
  tableNames: ReadonlySet<string>,
  didMutateStorage: boolean,
): void {
  if (descriptor.effects.kind === 'exact-invalidations') return
  const permitted = new Set(descriptor.effects.permitted)
  for (const kind of observed) {
    if (!permitted.has(kind)) throw new Error(`SemanticOperationEffectUndeclared:${kind}`)
  }
  if (!didMutateStorage) return
  for (const kind of descriptor.effects.requiredWhenMutated(tableNames)) {
    if (!permitted.has(kind)) throw new Error(`SemanticOperationEffectContractInvalid:${kind}`)
    if (!observed.has(kind)) throw new Error(`SemanticOperationEffectMissing:${kind}`)
  }
}

export function assertSemanticOperationReplay<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  input: ResourceInput,
  receipt: Receipt,
): void {
  if (!descriptor.replay) return
  if (descriptor.replay.kind === 'caller-single-attempt') return
  if (descriptor.replay.kind === 'receipt-proof') {
    descriptor.replay.assert(input, receipt)
    return
  }
  const expected = canonicalValue(descriptor.replay.expected(input))
  const observed = canonicalValue(descriptor.replay.observed(receipt))
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error('SemanticOperationReplayPlanMismatch')
  }
}

export function assertSemanticOperationEffects<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  delta: WorkspaceDelta,
  tableNames: ReadonlySet<string>,
  didMutateStorage: boolean,
): void {
  assertSemanticOperationEffectKinds(
    descriptor,
    new Set([
      ...delta.invalidations.map((dependency) => dependency.kind),
      ...delta.facts.flatMap(dependencyKindsForFact),
    ]),
    tableNames,
    didMutateStorage,
  )
}

export function assertSemanticOperationExactInvalidations<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  input: ResourceInput,
  observed: readonly WorkspaceDependency[],
  didMutateStorage: boolean,
  receipt: Receipt = undefined as Receipt,
): void {
  const exactInvalidations =
    descriptor.exactInvalidations ??
    (descriptor.effects.kind === 'exact-invalidations' ? descriptor.effects : undefined)
  if (!exactInvalidations) return
  const expectedDependencies = exactInvalidations.expected(input, didMutateStorage, receipt)
  const expected = canonicalDependencyVector(expectedDependencies)
  const publication = canonicalDependencyVector(
    normalizeWorkspaceDependencies(expectedDependencies),
  )
  if (JSON.stringify(publication) !== JSON.stringify(expected)) {
    throw new Error('SemanticOperationInvalidationContractNotPublicationStable')
  }
  const actual = canonicalDependencyVector(observed)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `SemanticOperationInvalidationMismatch:${JSON.stringify(expected)}:${JSON.stringify(actual)}`,
    )
  }
}

export function assertSemanticOperationExactPhysicalMutations<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  input: ResourceInput,
  observed: readonly SemanticOperationObservedPhysicalMutation[],
  successfulMutations: number,
  receipt: Receipt = undefined as Receipt,
): void {
  if (!descriptor.exactPhysicalMutations) return
  const didMutateStorage = successfulMutations > 0
  const expected = canonicalPhysicalMutationVector(
    descriptor.exactPhysicalMutations.expected(input, didMutateStorage, receipt),
  )
  const actual = canonicalPhysicalMutationVector(observed)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `SemanticOperationPhysicalMutationMismatch:${JSON.stringify(expected)}:${JSON.stringify(actual)}`,
    )
  }
}

export function assertSemanticOperationExactPhysicalReads<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  input: ResourceInput,
  observed: readonly SemanticOperationObservedPhysicalRead[],
  transactionExecuted: boolean,
  receipt: Receipt = undefined as Receipt,
): void {
  if (!descriptor.exactPhysicalReads) return
  const expected = canonicalPhysicalReadVector(
    descriptor.exactPhysicalReads.expected(input, transactionExecuted, receipt),
  )
  const actual = canonicalPhysicalReadVector(observed)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `SemanticOperationPhysicalReadMismatch:${JSON.stringify(expected)}:${JSON.stringify(actual)}`,
    )
  }
}

export function assertSemanticOperationExactPhysicalWrites<
  Kind extends SemanticOperationKind,
  Tables extends PhysicalStorageTableName,
  ResourceInput,
  Receipt,
>(
  descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
  input: ResourceInput,
  observed: readonly SemanticOperationObservedPhysicalWrite[],
  transactionExecuted: boolean,
  receipt: Receipt = undefined as Receipt,
): void {
  if (!descriptor.exactPhysicalWrites) return
  const expected = canonicalPhysicalWriteVector(
    descriptor.exactPhysicalWrites.expected(input, transactionExecuted, receipt),
  )
  const actual = canonicalPhysicalWriteVector(observed)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `SemanticOperationPhysicalWriteMismatch:${JSON.stringify(expected)}:${JSON.stringify(actual)}`,
    )
  }
}

function dependencyKindsForFact(fact: WorkspaceDeltaFact): readonly SemanticOperationEffectKind[] {
  switch (fact.kind) {
    case 'chat-deleted':
      return ['chat']
    case 'conversation-created':
      return ['chat', 'sidebar', 'message-header', 'message-body', 'message-preview', 'child-slot']
    case 'sidebar-row-changed':
    case 'sidebar-row-deleted':
      return ['sidebar']
    case 'attachment-row-changed':
    case 'attachment-row-deleted':
      return ['attachment']
    case 'attempt-target-committed':
      return ['stream-lease', 'message-body']
    case 'attempt-stop-requested':
      return ['stream-lease']
    case 'message-revision':
      return fact.changed.body ? ['message-header', 'message-body'] : ['message-header']
  }
}

function freezeValues<Value>(values: readonly Value[]): readonly Value[] {
  return Object.freeze([...new Set(values)])
}

function canonicalDependencyVector(
  dependencies: readonly WorkspaceDependency[],
): readonly Record<string, unknown>[] {
  return dependencies
    .map((dependency) => {
      const normalized = normalizeWorkspaceDependencies([dependency])
      if (normalized.length !== 1) {
        return canonicalRecord(dependency as unknown as Record<string, unknown>)
      }
      return canonicalRecord(normalized[0] as unknown as Record<string, unknown>)
    })
    .sort(compareCanonicalValues)
}

function canonicalPhysicalMutationVector(
  mutations: readonly SemanticOperationObservedPhysicalMutation[],
): readonly Record<string, unknown>[] {
  return mutations
    .map((mutation) =>
      canonicalRecord({
        tableName: mutation.tableName,
        operation: mutation.operation,
        ...(mutation.operation === 'delete-group'
          ? { address: mutation.address, affectedRows: mutation.affectedRows }
          : { key: mutation.key }),
      }),
    )
    .sort(compareCanonicalValues)
}

function canonicalPhysicalReadVector(
  reads: readonly SemanticOperationObservedPhysicalRead[],
): readonly Record<string, unknown>[] {
  return reads
    .map((read) =>
      canonicalRecord({
        tableName: read.tableName,
        indexKind: read.indexKind,
        ...(read.indexName ? { indexName: read.indexName } : {}),
        operation: read.operation,
        requestCount: read.requestCount,
        rowCount: read.rowCount,
      }),
    )
    .sort(compareCanonicalValues)
}

function canonicalPhysicalWriteVector(
  writes: readonly SemanticOperationObservedPhysicalWrite[],
): readonly Record<string, unknown>[] {
  const aggregated = new Map<
    string,
    {
      tableName: string
      operation: string
      requestCount: number
      rowCount: number
      maxRequestRows: number
    }
  >()
  for (const write of writes) {
    const key = `${write.tableName}\u0000${write.operation}`
    const current = aggregated.get(key)
    if (!current) {
      aggregated.set(key, {
        tableName: write.tableName,
        operation: write.operation,
        requestCount: write.requestCount,
        rowCount: write.rowCount,
        maxRequestRows: write.maxRequestRows,
      })
      continue
    }
    current.requestCount = saturatingPhysicalCount(current.requestCount, write.requestCount)
    current.rowCount = saturatingPhysicalCount(current.rowCount, write.rowCount)
    current.maxRequestRows = Math.max(current.maxRequestRows, write.maxRequestRows)
  }
  return [...aggregated.values()]
    .map((write) => canonicalRecord(write))
    .sort(compareCanonicalValues)
}

function canonicalRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        Array.isArray(entry)
          ? entry.map(canonicalValue)
          : entry && typeof entry === 'object'
            ? canonicalRecord(entry as Record<string, unknown>)
            : entry,
      ]),
  )
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return canonicalRecord(value as Record<string, unknown>)
  }
  return value
}

function compareCanonicalValues(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right))
}

export interface SemanticOperationExecution<Result, Receipt> {
  readonly value: Result
  readonly receipt: Receipt
  readonly [SEMANTIC_OPERATION_EXECUTION]: true
}

export type SemanticOperationRunnerValue<Result, Receipt> = [Receipt] extends [undefined]
  ? Result
  : SemanticOperationExecution<Result, Receipt>

export type SemanticOperationRunner<
  Tables extends PhysicalStorageTableName,
  Result,
  Receipt = undefined,
> = (
  tx: FencedTransaction<Tables>,
) =>
  | Promise<SemanticOperationRunnerValue<Result, Receipt>>
  | SemanticOperationRunnerValue<Result, Receipt>

export function semanticOperationExecution<Result, Receipt>(
  value: Result,
  receipt: Receipt,
): SemanticOperationExecution<Result, Receipt> {
  return Object.freeze({
    value,
    receipt,
    [SEMANTIC_OPERATION_EXECUTION]: true,
  })
}

export function semanticOperationExecutionParts<Result, Receipt>(
  execution: SemanticOperationRunnerValue<Result, Receipt>,
): { readonly value: Result; readonly receipt: Receipt } {
  if (isSemanticOperationExecution<Result, Receipt>(execution)) return execution
  return { value: execution as Result, receipt: undefined as Receipt }
}

function isSemanticOperationExecution<Result, Receipt>(
  value: unknown,
): value is SemanticOperationExecution<Result, Receipt> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [SEMANTIC_OPERATION_EXECUTION]?: unknown })[
      SEMANTIC_OPERATION_EXECUTION
    ] === true
  )
}

export function configurationSemanticOperationKind(
  kind: ConfigurationDomainCommandKind,
): ConfigurationSemanticOperationKind {
  return `configuration:${kind}`
}
