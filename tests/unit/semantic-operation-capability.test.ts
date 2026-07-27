import { describe, expect, it } from 'vitest'
import { planMutationSemanticOperation } from '../../src/store/browser-mutation-plan'
import { physicalStorageTables } from '../../src/store/physical-storage-tables'
import {
  assertSemanticOperationEffectKinds,
  assertSemanticOperationEffects,
  assertSemanticOperationExactInvalidations,
  assertSemanticOperationExactPhysicalMutations,
  assertSemanticOperationExactPhysicalReads,
  assertSemanticOperationExactPhysicalWrites,
  assertSemanticOperationReplay,
  assertSemanticOperationWrites,
  createSemanticOperationExactReceiptAccumulator,
  hasSemanticOperationExactReceiptAccumulator,
  semanticOperationCallerSingleAttemptReplayContract,
  semanticOperationDescriptor,
  semanticOperationExactPlan,
  semanticOperationExactReceipt,
  semanticOperationExactReceiptContracts,
  semanticOperationExactReceiptReplayContract,
  semanticOperationExactReceiptReplayProofContract,
  semanticOperationExecution,
  semanticOperationExecutionParts,
  semanticOperationReceiptFragment,
  semanticOperationReceiptFragmentPhysicalWriteContract,
  semanticOperationResourceNames,
  withSemanticOperationExactReceiptAccumulator,
} from '../../src/store/semantic-operation-capability'
import type { WorkspaceCommand } from '../../src/store/workspace-protocol'

describe('semantic operation capabilities', () => {
  const descriptor = semanticOperationDescriptor({
    operationKind: 'chat.touch-viewed',
    transaction: physicalStorageTables('chatSidebarAggregates', 'chatSidebarRows', 'chats'),
    resources: (chatIds: readonly string[]) => chatIds.map((chatId) => `chat-meta:${chatId}`),
    permittedWrites: ['chatSidebarAggregates', 'chatSidebarRows', 'chats'],
    requiredWritesWhenMutated: ['chats'],
    effects: {
      kind: 'effect-kinds',
      permitted: ['chat', 'sidebar'],
      requiredWhenMutated: () => ['chat', 'sidebar'],
    },
  })

  it('owns and normalizes the exact lock and transaction scope', () => {
    expect(semanticOperationResourceNames(descriptor, ['b', 'a', 'b'])).toEqual([
      'chat-meta:a',
      'chat-meta:b',
    ])
    expect(descriptor.transaction.tableNames).toEqual([
      'chatSidebarAggregates',
      'chatSidebarRows',
      'chats',
    ])
    expect(Object.isFrozen(descriptor)).toBe(true)
  })

  it('unwraps only executions created by the private typed receipt constructor', () => {
    const receipt = Object.freeze({ profileIds: ['profile-a'] })
    const execution = semanticOperationExecution('saved', receipt)

    const parts = semanticOperationExecutionParts(execution)
    expect(parts.value).toBe('saved')
    expect(parts.receipt).toBe(receipt)
    const ordinary = { value: 'domain-value', receipt: 'domain-receipt' }
    expect(semanticOperationExecutionParts<typeof ordinary, undefined>(ordinary)).toEqual({
      value: ordinary,
      receipt: undefined,
    })
  })

  it('seals independent constructive fragments into one normalized exact receipt', () => {
    const plan = semanticOperationExactPlan({
      replay: { kind: 'single-attempt', reason: 'non-replayable' },
      bounds: {
        reads: { maxRequests: 2, maxRows: 2, maxBatchRows: 1, maxBytes: 100 },
        writes: { maxRequests: 1, maxRows: 1, maxBatchRows: 1, maxBytes: 100 },
      },
    })
    const receipt = createSemanticOperationExactReceiptAccumulator<'messages'>()
    receipt.absorb(
      semanticOperationReceiptFragment({
        dependencies: [{ kind: 'message-header', messageIds: ['message'] }],
        physicalMutations: [{ tableName: 'messages', operation: 'write', key: 'message' }],
        physicalReads: [
          {
            tableName: 'messages',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          },
        ],
      }),
    )
    receipt.physicalRead({
      tableName: 'messages',
      indexKind: 'primary',
      operation: 'get',
      requestCount: 1,
      rowCount: 1,
    })
    receipt.physicalMutation({
      tableName: 'messages',
      operation: 'write',
      key: 'message',
    })
    const snapshot = receipt.snapshotFragment()
    receipt.dependency({ kind: 'message-body', messageIds: ['message'] })

    const sealed = receipt.seal(plan)
    expect(snapshot.dependencies).toEqual([{ kind: 'message-header', messageIds: ['message'] }])
    expect(sealed.dependencies).toEqual([
      { kind: 'message-header', messageIds: ['message'] },
      { kind: 'message-body', messageIds: ['message'] },
    ])
    expect(sealed.physicalMutations).toEqual([
      { tableName: 'messages', operation: 'write', key: 'message' },
    ])
    expect(sealed.physicalReads).toEqual([
      {
        tableName: 'messages',
        indexKind: 'primary',
        operation: 'get',
        requestCount: 2,
        rowCount: 2,
      },
    ])
    expect(() => receipt.dependency({ kind: 'message-body', messageIds: ['message'] })).toThrow(
      'SemanticOperationExactReceiptAccumulatorSealed',
    )
  })

  it('binds one constructive fragment accumulator only for the transaction lifetime', async () => {
    const transaction = {}
    const fragment = await withSemanticOperationExactReceiptAccumulator(transaction, (receipt) => {
      expect(hasSemanticOperationExactReceiptAccumulator(transaction)).toBe(true)
      receipt.physicalMutation({
        tableName: 'messages',
        operation: 'write',
        key: 'message',
      })
      receipt.physicalWrite({
        tableName: 'messages',
        operation: 'put',
        requestCount: 1,
        rowCount: 2,
        maxRequestRows: 2,
        estimatedBytes: 80,
      })
      receipt.physicalWrite({
        tableName: 'messages',
        operation: 'put',
        requestCount: 1,
        rowCount: 1,
        maxRequestRows: 1,
        estimatedBytes: 40,
      })
      return receipt.sealFragment()
    })

    expect(fragment.physicalMutations).toEqual([
      { tableName: 'messages', operation: 'write', key: 'message' },
    ])
    expect(fragment.physicalWrites).toEqual([
      {
        tableName: 'messages',
        operation: 'put',
        requestCount: 2,
        rowCount: 3,
        maxRequestRows: 2,
        estimatedBytes: 120,
      },
    ])
    expect(hasSemanticOperationExactReceiptAccumulator(transaction)).toBe(false)
    await expect(
      withSemanticOperationExactReceiptAccumulator(transaction, () => {
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(hasSemanticOperationExactReceiptAccumulator(transaction)).toBe(false)
  })

  it('compares aggregated constructive write requests with independent request observations', () => {
    const exactWrites = semanticOperationDescriptor({
      operationKind: 'chat.touch-viewed',
      transaction: physicalStorageTables('chats'),
      resources: () => ['chat-meta:chat'],
      permittedWrites: ['chats'],
      requiredWritesWhenMutated: ['chats'],
      effects: {
        kind: 'effect-kinds',
        permitted: ['chat'],
        requiredWhenMutated: () => ['chat'],
      },
      exactPhysicalWrites: semanticOperationReceiptFragmentPhysicalWriteContract<
        undefined,
        'chats'
      >(),
    })
    const receipt = semanticOperationReceiptFragment({
      physicalWrites: [
        {
          tableName: 'chats',
          operation: 'put',
          requestCount: 2,
          rowCount: 3,
          maxRequestRows: 2,
          estimatedBytes: 120,
        },
      ],
    })
    const observed = [
      {
        tableName: 'chats',
        operation: 'put',
        requestCount: 1,
        rowCount: 2,
        maxRequestRows: 2,
        estimatedBytes: 80,
      },
      {
        tableName: 'chats',
        operation: 'put',
        requestCount: 1,
        rowCount: 1,
        maxRequestRows: 1,
        estimatedBytes: 40,
      },
    ] as const

    expect(() =>
      assertSemanticOperationExactPhysicalWrites(exactWrites, undefined, observed, true, receipt),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalWrites(
        exactWrites,
        undefined,
        [{ ...observed[0], rowCount: 1 }, observed[1]],
        true,
        receipt,
      ),
    ).toThrow('SemanticOperationPhysicalWriteMismatch')
  })

  it('rejects missing and undeclared physical writes before commit', () => {
    expect(() =>
      assertSemanticOperationWrites(descriptor, new Set(['chatSidebarRows']), true),
    ).toThrow('SemanticOperationWriteMissing:chats')
    expect(() =>
      assertSemanticOperationWrites(descriptor, new Set(['chats', 'messageBodies']), true),
    ).toThrow('SemanticOperationWriteUndeclared:messageBodies')
    expect(() =>
      assertSemanticOperationWrites(descriptor, new Set(['chats', 'chatSidebarRows']), true),
    ).not.toThrow()
  })

  it('keeps read access distinct from write permission', () => {
    const planning = planMutationSemanticOperation(
      { kind: 'attempt.prepare', input: {} as never } satisfies WorkspaceCommand,
      [],
      {
        captureGenerationPlanningSnapshot: true,
        planningProfileId: 'profile',
      },
      {
        readTableNames: ['attachmentRefEdges'],
        writeTableNames: ['storageRetentionState'],
      },
    )

    expect(planning.descriptor.transaction.tableNames).toEqual(
      expect.arrayContaining([
        'profiles',
        'settings',
        'attachmentRefEdges',
        'storageRetentionState',
      ]),
    )
    expect(planning.descriptor.permittedWrites).toEqual(['storageRetentionState'])
    expect(() =>
      assertSemanticOperationWrites(planning.descriptor, new Set(['profiles']), true),
    ).toThrow('SemanticOperationWriteUndeclared:profiles')
    expect(() =>
      assertSemanticOperationWrites(planning.descriptor, new Set(['storageRetentionState']), true),
    ).not.toThrow()
  })

  it('compiles scope permissions and exact occurrence writes in one pass', () => {
    const topology = planMutationSemanticOperation(
      {
        kind: 'message.delete',
        mode: 'single',
        input: {} as never,
      } satisfies WorkspaceCommand,
      [{ kind: 'children', chatId: 'chat', parentId: null }],
    )
    expect(topology.descriptor.permittedWrites).toEqual(['childLists', 'childSlotMembers'])
    expect(() =>
      assertSemanticOperationWrites(topology.descriptor, new Set(['messages']), true),
    ).toThrow('SemanticOperationWriteUndeclared:messages')
    expect(() =>
      assertSemanticOperationEffectKinds(
        topology.descriptor,
        new Set(['child-slot']),
        new Set(['childLists']),
        true,
      ),
    ).not.toThrow()
    expect(topology.descriptor.replay).toBeUndefined()
    const exactOccurrence = semanticOperationExactReceipt(undefined, {
      dependencies: [],
      physicalMutations: [
        {
          tableName: 'childLists',
          operation: 'write',
          key: ['chat', null],
        },
      ],
      physicalReads: [],
      physicalWrites: [
        {
          tableName: 'childLists',
          operation: 'put',
          requestCount: 1,
          rowCount: 1,
          maxRequestRows: 1,
          estimatedBytes: 64,
        },
      ],
    })
    expect(exactOccurrence.plan).toBeUndefined()
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(
        topology.descriptor,
        undefined,
        [{ tableName: 'childLists', operation: 'write', key: ['chat', null] }],
        1,
        exactOccurrence,
      ),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalWrites(
        topology.descriptor,
        undefined,
        [
          {
            tableName: 'childLists',
            operation: 'put',
            requestCount: 1,
            rowCount: 1,
            maxRequestRows: 1,
          },
        ],
        true,
        exactOccurrence,
      ),
    ).not.toThrow()

    const message = planMutationSemanticOperation(
      { kind: 'attempt.prepare', input: {} as never } satisfies WorkspaceCommand,
      [{ kind: 'message', messageId: 'message' }],
      {
        streamFence: { streamId: 'stream', fence: {} as never },
        streamCanonicalCommit: { streamId: 'stream' } as never,
        settingReadKeys: ['token-calibration'],
      },
    )
    expect(message.descriptor.permittedWrites).toEqual(
      expect.arrayContaining([
        'chatSidebarAggregates',
        'chatSidebarRows',
        'chats',
        'messageBodies',
        'messagePreviews',
        'messages',
        'streamLeases',
      ]),
    )
    expect(semanticOperationResourceNames(message.descriptor, undefined)).toEqual([
      'message:message',
      'setting:token-calibration',
      'stream-journal:stream',
    ])
    expect(() =>
      assertSemanticOperationEffectKinds(
        message.descriptor,
        new Set(['message-body', 'stream-lease']),
        new Set(['messageBodies', 'streamLeases']),
        true,
      ),
    ).not.toThrow()
  })

  it('rejects descriptors that permit writes outside their transaction', () => {
    expect(() =>
      semanticOperationDescriptor({
        operationKind: 'chat.touch-viewed',
        transaction: physicalStorageTables('chats'),
        resources: () => ['chat-meta:chat'],
        permittedWrites: ['chatSidebarRows'] as never,
        requiredWritesWhenMutated: [],
        effects: {
          kind: 'effect-kinds',
          permitted: [],
          requiredWhenMutated: () => [],
        },
      }),
    ).toThrow('SemanticOperationWriteOutsideTransaction:chatSidebarRows')
  })

  it('rejects missing, undeclared, and contradictory semantic effects before commit', () => {
    expect(() =>
      assertSemanticOperationEffects(
        descriptor,
        {
          facts: [{ kind: 'sidebar-row-changed', chatId: 'a' }],
          invalidations: [],
        },
        new Set(['chats']),
        true,
      ),
    ).toThrow('SemanticOperationEffectMissing:chat')

    expect(() =>
      assertSemanticOperationEffects(
        descriptor,
        {
          facts: [{ kind: 'sidebar-row-changed', chatId: 'a' }],
          invalidations: [{ kind: 'message-body', messageIds: ['message'] }],
        },
        new Set(['chats']),
        true,
      ),
    ).toThrow('SemanticOperationEffectUndeclared:message-body')

    const contradictory = semanticOperationDescriptor({
      ...descriptor,
      transaction: physicalStorageTables('chatSidebarAggregates', 'chatSidebarRows', 'chats'),
      effects: {
        kind: 'effect-kinds',
        permitted: ['chat'],
        requiredWhenMutated: () => ['sidebar'],
      },
    })
    expect(() =>
      assertSemanticOperationEffects(
        contradictory,
        { facts: [], invalidations: [] },
        new Set(['chats']),
        true,
      ),
    ).toThrow('SemanticOperationEffectContractInvalid:sidebar')
  })

  it('requires exact invalidation identity and cardinality, including no-ops', () => {
    const exact = semanticOperationDescriptor({
      operationKind: 'configuration:global-preference.set',
      transaction: physicalStorageTables('settings'),
      resources: (input: { readonly keys: readonly string[] }) =>
        input.keys.map((key) => `setting:${key}`),
      permittedWrites: ['settings'],
      requiredWritesWhenMutated: ['settings'],
      effects: {
        kind: 'exact-invalidations',
        expected: (input, mutated) =>
          mutated ? [{ kind: 'setting' as const, keys: input.keys }] : [],
      },
      exactPhysicalMutations: {
        expected: (input, mutated) =>
          mutated
            ? input.keys.map((key) => ({
                tableName: 'settings' as const,
                operation: 'write' as const,
                key,
              }))
            : [],
      },
    })
    const input = { keys: ['a', 'b'] }

    expect(() =>
      assertSemanticOperationExactInvalidations(
        exact,
        input,
        [{ kind: 'setting', keys: ['b', 'a'] }],
        true,
      ),
    ).not.toThrow()
    for (const observed of [
      [
        { kind: 'setting' as const, keys: ['a', 'b'] },
        { kind: 'setting' as const, keys: ['a', 'b'] },
      ],
      [{ kind: 'setting' as const }],
      [{ kind: 'setting' as const, keys: ['a'] }],
    ]) {
      expect(() => assertSemanticOperationExactInvalidations(exact, input, observed, true)).toThrow(
        'SemanticOperationInvalidationMismatch',
      )
    }
    expect(() =>
      assertSemanticOperationExactInvalidations(
        exact,
        input,
        [{ kind: 'setting', keys: ['a', 'b'] }],
        false,
      ),
    ).toThrow('SemanticOperationInvalidationMismatch')
  })

  it('requires exact physical setting identities without conflating repeated writes', () => {
    const exact = semanticOperationDescriptor({
      operationKind: 'configuration:recent-model.clear',
      transaction: physicalStorageTables('settings'),
      resources: (keys: readonly string[]) => keys.map((key) => `setting:${key}`),
      permittedWrites: ['settings'],
      requiredWritesWhenMutated: ['settings'],
      effects: {
        kind: 'exact-invalidations',
        expected: (keys, mutated) => (mutated ? [{ kind: 'setting' as const, keys }] : []),
      },
      exactPhysicalMutations: {
        expected: (keys, mutated) =>
          mutated
            ? keys.map((key) => ({
                tableName: 'settings' as const,
                operation: 'write' as const,
                key,
              }))
            : [],
      },
    })
    const keys = ['recent', 'recency']
    const writes = keys.map((key) => ({
      tableName: 'settings',
      operation: 'write' as const,
      key,
    }))

    expect(() =>
      assertSemanticOperationExactPhysicalMutations(exact, keys, writes, 2),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(
        exact,
        keys,
        [
          { tableName: 'settings', operation: 'delete', key: 'recent' },
          { tableName: 'settings', operation: 'write', key: 'recency' },
        ],
        2,
      ),
    ).toThrow('SemanticOperationPhysicalMutationMismatch')
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(exact, keys, writes.slice(0, 1), 2),
    ).toThrow('SemanticOperationPhysicalMutationMismatch')
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(exact, keys, writes, 3),
    ).not.toThrow()
    expect(() => assertSemanticOperationExactPhysicalMutations(exact, keys, writes, 0)).toThrow(
      'SemanticOperationPhysicalMutationMismatch',
    )
  })

  it('preserves ordered compound primary keys while dependency selectors remain set-like', () => {
    const exact = semanticOperationDescriptor({
      operationKind: 'configuration:global-preference.set',
      transaction: physicalStorageTables('settings'),
      resources: () => ['setting:compound'],
      permittedWrites: ['settings'],
      requiredWritesWhenMutated: ['settings'],
      effects: {
        kind: 'exact-invalidations',
        expected: () => [{ kind: 'setting' as const, keys: ['a', 'b'] }],
      },
      exactPhysicalMutations: {
        expected: () => [
          {
            tableName: 'settings' as const,
            operation: 'write' as const,
            key: ['parent', 'child'],
          },
        ],
      },
    })

    expect(() =>
      assertSemanticOperationExactInvalidations(
        exact,
        undefined,
        [{ kind: 'setting', keys: ['b', 'a'] }],
        true,
      ),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(
        exact,
        undefined,
        [
          {
            tableName: 'settings',
            operation: 'write',
            key: ['parent', 'child'],
          },
        ],
        1,
      ),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(
        exact,
        undefined,
        [
          {
            tableName: 'settings',
            operation: 'write',
            key: ['child', 'parent'],
          },
        ],
        1,
      ),
    ).toThrow('SemanticOperationPhysicalMutationMismatch')
  })

  it('keeps grouped-delete affected rows in the exact mutation identity', () => {
    const exact = semanticOperationDescriptor({
      operationKind: 'maintenance.prune-terminal-stream-journals',
      transaction: physicalStorageTables('streamChunks'),
      resources: () => ['stream-journal:stream'],
      permittedWrites: ['streamChunks'],
      requiredWritesWhenMutated: ['streamChunks'],
      effects: {
        kind: 'exact-invalidations',
        expected: () => [],
      },
      exactPhysicalMutations: {
        expected: () => [
          {
            tableName: 'streamChunks' as const,
            operation: 'delete-group' as const,
            address: 'streamChunks\u0000stream',
            affectedRows: 3,
          },
        ],
      },
    })
    const observed = [
      {
        tableName: 'streamChunks',
        operation: 'delete-group',
        address: 'streamChunks\u0000stream',
        affectedRows: 3,
      },
    ] as const

    expect(() =>
      assertSemanticOperationExactPhysicalMutations(exact, undefined, observed, 3),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(exact, undefined, observed, 1),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(
        exact,
        undefined,
        [{ ...observed[0], affectedRows: 2 }],
        3,
      ),
    ).toThrow('SemanticOperationPhysicalMutationMismatch')
  })

  it('carries one frozen exact plan and receipt through the existing execution seam', () => {
    const plan = semanticOperationExactPlan({
      replay: {
        kind: 'append-by-key',
        owner: 'stream:stream',
        fence: ['owner', 'fence', 1, 1],
        keys: ['stream:1'],
        equality: 'canonical-equal-or-conflict',
        lifecycle: 'active-writer',
      },
      bounds: {
        reads: { maxRequests: 1, maxRows: 1, maxBatchRows: 1, maxBytes: 128 },
        writes: { maxRequests: 1, maxRows: 1, maxBatchRows: 1, maxBytes: 128 },
      },
    })
    const receipt = semanticOperationExactReceipt(plan, {
      dependencies: [{ kind: 'stream-chunks', streamIds: ['stream'] }],
      physicalMutations: [
        {
          tableName: 'streamChunks',
          operation: 'write',
          key: ['stream', 1],
        },
      ],
      physicalReads: [
        {
          tableName: 'streamChunks',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        },
      ],
    })
    const exact = semanticOperationDescriptor({
      operationKind: 'stream.append-journal-frames',
      transaction: physicalStorageTables('streamChunks'),
      resources: () => ['stream-journal:stream'],
      permittedWrites: ['streamChunks'],
      requiredWritesWhenMutated: ['streamChunks'],
      ...semanticOperationExactReceiptContracts<undefined, 'streamChunks'>(),
      replay: semanticOperationExactReceiptReplayContract(() => plan.replay),
    })
    const execution = semanticOperationExecution('appended', receipt)
    const parts = semanticOperationExecutionParts(execution)

    expect(parts.receipt).toBe(receipt)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.replay)).toBe(true)
    expect(Object.isFrozen(plan.bounds.reads)).toBe(true)
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(() =>
      assertSemanticOperationExactInvalidations(
        exact,
        undefined,
        [{ kind: 'stream-chunks', streamIds: ['stream'] }],
        true,
        parts.receipt,
      ),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalMutations(
        exact,
        undefined,
        [
          {
            tableName: 'streamChunks',
            operation: 'write',
            key: ['stream', 1],
          },
        ],
        1,
        parts.receipt,
      ),
    ).not.toThrow()
    expect(() =>
      assertSemanticOperationExactPhysicalReads(
        exact,
        undefined,
        [
          {
            tableName: 'streamChunks',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          },
        ],
        true,
        parts.receipt,
      ),
    ).not.toThrow()
    expect(() => assertSemanticOperationReplay(exact, undefined, parts.receipt)).not.toThrow()
    expect(() =>
      assertSemanticOperationReplay(
        semanticOperationDescriptor({
          operationKind: 'stream.append-journal-frames',
          transaction: physicalStorageTables('streamChunks'),
          resources: () => ['stream-journal:stream'],
          permittedWrites: ['streamChunks'],
          requiredWritesWhenMutated: ['streamChunks'],
          ...semanticOperationExactReceiptContracts<undefined, 'streamChunks'>(),
          replay: semanticOperationExactReceiptReplayContract(() => ({
            kind: 'single-attempt',
            reason: 'non-replayable',
          })),
        }),
        undefined,
        parts.receipt,
      ),
    ).toThrow('SemanticOperationReplayPlanMismatch')
    expect(() =>
      semanticOperationExactPlan({
        replay: { kind: 'single-attempt', reason: 'non-replayable' },
        bounds: {
          reads: { maxRequests: -1, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
          writes: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
        },
      }),
    ).toThrow('SemanticOperationPhysicalBoundInvalid:maxRequests')
    expect(() =>
      semanticOperationExactPlan({
        replay: { kind: 'single-attempt', reason: 'non-replayable' },
        bounds: {
          reads: {
            maxRequests: 0,
            maxRows: 0,
            maxBatchRows: 0,
            maxBytes: Number.POSITIVE_INFINITY,
          },
          writes: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
        },
      }),
    ).toThrow('SemanticOperationPhysicalBoundInvalid:maxBytes')
  })

  it('carries replay evidence without fabricating a physical-I/O bound', () => {
    const replay = {
      kind: 'fenced-convergent',
      owner: 'stream:one',
      fence: ['owner', 1],
      desired: ['finalize', 'message'],
      alreadyApplied: 'return-current-or-conflict',
    } as const
    const receipt = semanticOperationExactReceipt(undefined, {
      replay,
      dependencies: [],
      physicalMutations: [],
      physicalReads: [],
    })
    const replayOnly = semanticOperationDescriptor({
      operationKind: 'attempt.finalize',
      transaction: physicalStorageTables('streamLeases'),
      resources: () => ['stream:one'],
      permittedWrites: ['streamLeases'],
      requiredWritesWhenMutated: [],
      effects: { kind: 'effect-kinds', permitted: [], requiredWhenMutated: () => [] },
      replay: semanticOperationExactReceiptReplayContract(() => replay),
    })

    expect(receipt.plan).toBeUndefined()
    expect(receipt.replay).toEqual(replay)
    expect(Object.isFrozen(receipt.replay)).toBe(true)
    expect(() => assertSemanticOperationReplay(replayOnly, undefined, receipt)).not.toThrow()
  })

  it('runs a receipt-owned replay proof instead of equating copied request plans', () => {
    const plan = semanticOperationExactPlan({
      replay: {
        kind: 'compare-and-swap',
        owner: 'stream:one',
        expected: [3],
        desired: [10],
        outcome: 'applied',
      },
      bounds: {
        reads: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
        writes: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
      },
    })
    const receipt = semanticOperationExactReceipt(plan, {
      dependencies: [],
      physicalMutations: [],
      physicalReads: [],
    })
    let observedInput: string | undefined
    const exact = semanticOperationDescriptor({
      operationKind: 'stream.renew',
      transaction: physicalStorageTables('streamLeases'),
      resources: (streamId: string) => [`stream-journal:${streamId}`],
      permittedWrites: ['streamLeases'],
      requiredWritesWhenMutated: ['streamLeases'],
      ...semanticOperationExactReceiptContracts<string, 'streamLeases'>(),
      replay: semanticOperationExactReceiptReplayProofContract<string>((input, observed) => {
        observedInput = input
        if (observed.plan.replay.kind !== 'compare-and-swap') {
          throw new Error('ExpectedCompareAndSwapReplay')
        }
      }),
    })

    expect(() => assertSemanticOperationReplay(exact, 'one', receipt)).not.toThrow()
    expect(observedInput).toBe('one')
    expect(() =>
      assertSemanticOperationReplay(
        semanticOperationDescriptor({
          operationKind: 'stream.renew',
          transaction: physicalStorageTables('streamLeases'),
          resources: (streamId: string) => [`stream-journal:${streamId}`],
          permittedWrites: ['streamLeases'],
          requiredWritesWhenMutated: ['streamLeases'],
          ...semanticOperationExactReceiptContracts<string, 'streamLeases'>(),
          replay: semanticOperationExactReceiptReplayProofContract<string>(() => {
            throw new Error('ReceiptReplayRejected')
          }),
        }),
        'one',
        receipt,
      ),
    ).toThrow('ReceiptReplayRejected')
  })

  it('records caller-owned single-attempt policy without fabricating receipt convergence', () => {
    const replay = semanticOperationCallerSingleAttemptReplayContract<undefined, undefined>(
      'unfenced-relative-update',
    )
    const singleAttempt = semanticOperationDescriptor({
      operationKind: 'configuration:chat-preset.move',
      transaction: physicalStorageTables('presets'),
      resources: () => ['preset-order'],
      permittedWrites: ['presets'],
      requiredWritesWhenMutated: ['presets'],
      effects: {
        kind: 'effect-kinds',
        permitted: ['chat'],
        requiredWhenMutated: () => ['chat'],
      },
      replay,
    })

    expect(replay).toEqual({
      kind: 'caller-single-attempt',
      plan: { kind: 'single-attempt', reason: 'unfenced-relative-update' },
    })
    expect(Object.isFrozen(replay)).toBe(true)
    expect(Object.isFrozen(replay.plan)).toBe(true)
    expect(() => assertSemanticOperationReplay(singleAttempt, undefined, undefined)).not.toThrow()
  })

  it('rejects exact receipt facts that exceed declared request, row, or batch bounds', () => {
    const plan = semanticOperationExactPlan({
      replay: { kind: 'single-attempt', reason: 'non-replayable' },
      bounds: {
        reads: { maxRequests: 1, maxRows: 2, maxBatchRows: 1, maxBytes: 128 },
        writes: { maxRequests: 1, maxRows: 2, maxBatchRows: 1, maxBytes: 128 },
      },
    })
    const receipt = (overrides: {
      readonly physicalReadIo?: Parameters<
        typeof semanticOperationExactReceipt
      >[1]['physicalReadIo']
      readonly physicalWrites?: Parameters<
        typeof semanticOperationExactReceipt
      >[1]['physicalWrites']
    }) =>
      semanticOperationExactReceipt(plan, {
        dependencies: [],
        physicalMutations: [],
        physicalReads: [],
        physicalReadIo: overrides.physicalReadIo ?? [],
        physicalWrites: overrides.physicalWrites ?? [],
      })

    expect(() =>
      receipt({
        physicalReadIo: [
          {
            tableName: 'settings',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 2,
            rowCount: 2,
            maxRequestRows: 1,
            estimatedBytes: 100,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:readRequests')
    expect(() =>
      receipt({
        physicalReadIo: [
          {
            tableName: 'settings',
            indexKind: 'primary',
            operation: 'get-many',
            requestCount: 1,
            rowCount: 2,
            maxRequestRows: 2,
            estimatedBytes: 100,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:readBatch')
    expect(() =>
      receipt({
        physicalReadIo: [
          {
            tableName: 'settings',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
            maxRequestRows: 1,
            estimatedBytes: 129,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:readBytes')
    expect(() =>
      receipt({
        physicalWrites: [
          {
            tableName: 'settings',
            operation: 'put',
            requestCount: 2,
            rowCount: 2,
            maxRequestRows: 1,
            estimatedBytes: 100,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:writeRequests')
    expect(() =>
      receipt({
        physicalWrites: [
          {
            tableName: 'settings',
            operation: 'put',
            requestCount: 1,
            rowCount: 2,
            maxRequestRows: 2,
            estimatedBytes: 100,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:writeBatch')
    expect(() =>
      receipt({
        physicalWrites: [
          {
            tableName: 'settings',
            operation: 'put',
            requestCount: 1,
            rowCount: 1,
            maxRequestRows: 1,
            estimatedBytes: 129,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:writeBytes')
    const rowBoundPlan = semanticOperationExactPlan({
      replay: { kind: 'single-attempt', reason: 'non-replayable' },
      bounds: {
        reads: { maxRequests: 0, maxRows: 0, maxBatchRows: 0, maxBytes: 0 },
        writes: { maxRequests: 2, maxRows: 2, maxBatchRows: 2, maxBytes: 128 },
      },
    })
    expect(() =>
      semanticOperationExactReceipt(rowBoundPlan, {
        dependencies: [],
        physicalMutations: [],
        physicalReads: [],
        physicalWrites: [
          {
            tableName: 'settings',
            operation: 'put',
            requestCount: 2,
            rowCount: 3,
            maxRequestRows: 2,
            estimatedBytes: 100,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:writeRows')
    expect(() =>
      receipt({
        physicalReadIo: [
          {
            tableName: 'settings',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 0,
            rowCount: 1,
            maxRequestRows: 1,
            estimatedBytes: 1,
          },
        ],
      }),
    ).toThrow('SemanticOperationPhysicalBoundExceeded:readBatch')
  })

  it('requires exact physical read method, index, request count, and addressed rows', () => {
    const exact = semanticOperationDescriptor({
      operationKind: 'configuration:global-preference.set',
      transaction: physicalStorageTables('settings'),
      resources: (keys: readonly string[]) => keys.map((key) => `setting:${key}`),
      permittedWrites: ['settings'],
      requiredWritesWhenMutated: ['settings'],
      effects: {
        kind: 'exact-invalidations',
        expected: () => [],
      },
      exactPhysicalReads: {
        expected: (keys, executed) =>
          executed
            ? [
                {
                  tableName: 'settings' as const,
                  indexKind: 'primary' as const,
                  operation: 'get-many' as const,
                  requestCount: 1,
                  rowCount: keys.length,
                },
              ]
            : [],
      },
    })
    const keys = ['a', 'b']
    const read = {
      tableName: 'settings',
      indexKind: 'primary',
      operation: 'get-many',
      requestCount: 1,
      rowCount: 2,
    } as const
    const reads = [read]

    expect(() => assertSemanticOperationExactPhysicalReads(exact, keys, reads, true)).not.toThrow()
    for (const observed of [
      [{ ...read, operation: 'query' }],
      [{ ...read, indexKind: 'secondary', indexName: 'key' }],
      [{ ...read, requestCount: 2 }],
      [{ ...read, rowCount: 1 }],
      [...reads, read],
    ]) {
      expect(() => assertSemanticOperationExactPhysicalReads(exact, keys, observed, true)).toThrow(
        'SemanticOperationPhysicalReadMismatch',
      )
    }
    expect(() => assertSemanticOperationExactPhysicalReads(exact, keys, [], false)).not.toThrow()
    expect(() => assertSemanticOperationExactPhysicalReads(exact, keys, reads, false)).toThrow(
      'SemanticOperationPhysicalReadMismatch',
    )
  })
})
