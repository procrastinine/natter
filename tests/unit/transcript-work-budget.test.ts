import { describe, expect, it } from 'vitest'
import type { MessageTreeNode } from '../../src/core/active-path'
import {
  type BranchPathDescriptor,
  type BranchPathTraversalMeasurement,
  createBranchPath,
  emptyBranchPath,
} from '../../src/core/branch-session'
import {
  growTranscriptWorkBudget,
  initialTranscriptWorkBudget,
  TRANSCRIPT_BODY_READ_BATCH_ROWS,
  transcriptRowFloorBudget,
  transcriptTailSpan,
} from '../../src/core/transcript-work-budget'
import type { ChatId, Message, MessageId } from '../../src/core/types'
import { splitMessageForStorage } from '../../src/store/message-storage'
import {
  retainTranscriptBodyWindowSpan,
  type TranscriptBodyPresentation,
  type TranscriptBodyTransition,
  type TranscriptBodyWindow,
  transcriptBodyWindowFindRow,
  transcriptBodyWindowPages,
  transcriptBodyWindowRows,
  transitionTranscriptBodyWindow,
} from '../../src/store/transcript-window'

describe('transcript work budgets', () => {
  it('extends growing paths with immutable indexed access across vector boundaries', () => {
    const headers = linearHeaders(4_096, { textChars: 1, renderCost: 1 })
    let path = emptyBranchPath<(typeof headers)[number]>()
    const retained: (typeof path)[] = []

    for (const header of headers) {
      if (path.length === 31 || path.length === 32 || path.length === 1_055) retained.push(path)
      path = path.append(header)
    }

    expect(retained.map((entry) => entry.length)).toEqual([31, 32, 1_055])
    expect(retained[1]?.leaf?.id).toBe('message-31')
    expect(path.length).toBe(4_096)
    expect(path.get('message-0')).toBe(headers[0])
    expect(path.get('message-1')).toBe(headers[1])
    expect(path.get('message-31')).toBe(headers[31])
    expect(path.get('message-32')).toBe(headers[32])
    expect(path.get('message-1_055')).toBeUndefined()
    expect(path.get('message-1055')).toBe(headers[1_055])
    expect(path.get('message-4095')).toBe(headers[4_095])
    expect(path.window({ offset: 1_020, limit: 80 }).nodes).toEqual(headers.slice(1_020, 1_100))
    expect(path.materializeNodes()).toEqual(headers)
    expect([...path.messageIds]).toEqual(headers.map((header) => header.id))

    const truncated = path.truncate('message-1055')
    const alternate = Object.freeze({
      ...(headers[1_056] as (typeof headers)[number]),
      id: 'message-alternate',
    })
    const sibling = truncated.append(alternate)
    expect(truncated.length).toBe(1_056)
    expect(truncated.get('message-1056')).toBeUndefined()
    expect(sibling.length).toBe(1_057)
    expect(sibling.leaf).toBe(alternate)
    expect(sibling.get('message-1056')).toBeUndefined()
    expect(path.get('message-4095')).toBe(headers[4_095])
  })

  it('finds a near-tip structural divergence without materializing the deep path', () => {
    const headers = linearHeaders(4_096, { textChars: 1, renderCost: 1 })
    const previous = createBranchPath(headers)
    const changedLeaf = Object.freeze({
      ...(headers[4_095] as (typeof headers)[number]),
      siblingIndex: 1,
    })
    const current = previous.replace(changedLeaf)
    const reads = { get: 0, indexOf: 0 }
    const measuredPrevious = poisonMaterializationAndMeasureLookups(previous, reads)

    expect(current.divergenceFrom(measuredPrevious)).toEqual({
      commonPrefixLength: 4_095,
      branchLength: 4_096,
      offset: 4_095,
      limit: 1,
      boundaryParentId: 'message-4094',
    })
    expect(reads).toEqual({ get: 2, indexOf: 2 })
  })

  it('keeps resident configuration to a row floor while the mounted viewport owns work limits', () => {
    const path = createBranchPath(linearHeaders(40, { textChars: 1_000_000, renderCost: 10_000 }))
    const shortPath = createBranchPath(linearHeaders(200, { textChars: 1, renderCost: 1 }))
    const resident = transcriptRowFloorBudget(10)
    const initial = initialTranscriptWorkBudget(10, 360)

    expect(resident).toEqual({
      minimumRowCount: 10,
      textCharLimit: 0,
      renderCostLimit: 0,
    })
    expect(transcriptTailSpan(path, resident)).toMatchObject({ offset: 30, limit: 10 })
    expect(transcriptTailSpan(shortPath, resident)).toMatchObject({ offset: 190, limit: 10 })
    expect(transcriptTailSpan(path, initial)).toMatchObject({ offset: 30, limit: 10 })
    expect(transcriptTailSpan(shortPath, initial).limit).toBeGreaterThan(10)
  })

  it('uses projected work and viewport overscan beyond the minimum row target', () => {
    const path = createBranchPath(linearHeaders(200, { textChars: 1, renderCost: 1 }))
    const span = transcriptTailSpan(path, initialTranscriptWorkBudget(10, 360))

    expect(span.limit).toBeGreaterThan(10)
    expect(span.limit).toBeLessThan(path.length)
  })

  it('grows both the row floor and work limits geometrically without capping branch length', () => {
    const path = createBranchPath(
      linearHeaders(2_000, { textChars: 1_000_000, renderCost: 10_000 }),
    )
    let budget = initialTranscriptWorkBudget(10, 360)
    const limits: number[] = []

    while (limits.at(-1) !== path.length) {
      limits.push(transcriptTailSpan(path, budget).limit)
      budget = growTranscriptWorkBudget(budget)
    }

    expect(limits).toEqual([10, 20, 40, 80, 160, 320, 640, 1_280, 2_000])
    expect(path.length).toBe(2_000)
  })

  it('recycles a deep resident window to the configured tail without full-path materialization', () => {
    const presentations = storedLinearRows(4_096)
    const path = createBranchPath(presentations.map((row) => row.header))
    const base = requireTransitionWindow(
      transitionTranscriptBodyWindow(path, presentations, null, null),
      'terminal',
    )
    const windowReads: Array<{ offset: number; limit: number }> = []
    const boundedPath = new Proxy(path, {
      get(target, property) {
        if (property === 'materializeNodes' || property === 'materializeIds') {
          return () => {
            throw new Error('FullPathMaterializationForbidden')
          }
        }
        if (property === 'window') {
          return (page: { offset: number; limit: number }) => {
            windowReads.push(page)
            return target.window(page)
          }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function'
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value
      },
    })
    const span = transcriptTailSpan(boundedPath, transcriptRowFloorBudget(10))
    const retained = retainTranscriptBodyWindowSpan(boundedPath, base, span)

    expect(retained).toMatchObject({ branchLength: 4_096, offset: 4_086, rowCount: 10 })
    expect(windowReads).toEqual([{ offset: 4_086, limit: 10 }])
    expect(
      [...transcriptBodyWindowPages(retained as TranscriptBodyWindow)].map((page) => page.rowCount),
    ).toEqual([10])
    const retainedRows = [...transcriptBodyWindowRows(retained as TranscriptBodyWindow)]
    expect(retainedRows.map((row) => row.header.id)).toEqual(
      presentations.slice(-10).map((row) => row.header.id),
    )
    expect(retainedRows.at(-1)?.message).toBe([...transcriptBodyWindowRows(base)].at(-1)?.message)
  })

  it('walks each predecessor once while background and geometric demand drain fixed pages', () => {
    const path = createBranchPath(mixedHeaders(4_096))
    const measurement: BranchPathTraversalMeasurement = { predecessorLinks: 0 }
    let budget = initialTranscriptWorkBudget(10, 360)
    let earliestOffset = path.length - 1
    let nextNewestMessageId = path.leaf?.parentId ?? null
    let pageCount = 0
    let roundCount = 0

    while (earliestOffset > 0) {
      const target = transcriptTailSpan(path, budget)
      if (roundCount === 0) expect(target.limit).toBe(10)
      while (earliestOffset > target.offset) {
        if (nextNewestMessageId === null) throw new Error('TranscriptBoundaryMissing')
        const page = path.backwardWindow(
          {
            endingAt: nextNewestMessageId,
            limit: Math.min(TRANSCRIPT_BODY_READ_BATCH_ROWS, earliestOffset - target.offset),
          },
          measurement,
        )
        expect(page.offset + page.limit).toBe(earliestOffset)
        earliestOffset = page.offset
        nextNewestMessageId = page.boundaryParentId
        pageCount += 1
      }
      budget = growTranscriptWorkBudget(budget)
      roundCount += 1
      if (roundCount > 16) throw new Error('TranscriptDemandDidNotConverge')
    }

    expect(path.length).toBeGreaterThan(128)
    expect(pageCount).toBeGreaterThan(128)
    expect(measurement.predecessorLinks).toBe(path.length - 1)
  })

  it('paints a cold deep destination from a bounded terminal window without materializing the path', () => {
    const presentations = storedLinearRows(4_096)
    const path = createBranchPath(presentations.map((row) => row.header))
    const backwardLimits: number[] = []
    const boundedPath = poisonFullMaterialization(path, backwardLimits)

    const transition = transitionTranscriptBodyWindow(
      boundedPath,
      Object.freeze([presentations[4_095] as TranscriptBodyPresentation]),
      null,
      null,
    )
    expect(transition.kind).toBe('terminal')
    const window = requireTransitionWindow(transition, 'terminal')

    expect(backwardLimits).toEqual([1])
    expect(window).toMatchObject({ branchLength: 4_096, offset: 4_095, rowCount: 1 })
    expect([...transcriptBodyWindowRows(window)].map((row) => row.header.id)).toEqual([
      presentations[4_095]?.header.id,
    ])
  })

  it('reuses only an exact retained suffix and stores transition pages in fixed-size chunks', () => {
    const presentations = storedLinearRows(60)
    const basePath = createBranchPath(presentations.map((row) => row.header))
    const baseTransition = transitionTranscriptBodyWindow(basePath, presentations, null, null)
    expect(baseTransition.kind).toBe('terminal')
    const base = requireTransitionWindow(baseTransition, 'terminal')
    const shared = presentations[58] as TranscriptBodyPresentation
    const sibling = storedPresentation(message('sibling-tip', shared.header.id, 60, 'sibling'))
    const siblingPath = basePath.truncate(shared.header.id).append(sibling.header)

    const switchedTransition = transitionTranscriptBodyWindow(
      siblingPath,
      Object.freeze([sibling]),
      base,
      basePath,
    )
    expect(switchedTransition.kind).toBe('exact')
    const switched = requireTransitionWindow(switchedTransition, 'exact')

    expect(switched).toMatchObject({ branchLength: 60, offset: 0, rowCount: 60 })
    expect([...transcriptBodyWindowPages(switched)].map((page) => page.rowCount)).toEqual([
      24, 24, 12,
    ])
    expect([...transcriptBodyWindowRows(switched)].at(-1)?.message).toMatchObject({
      id: sibling.message.id,
      content: sibling.message.content,
    })

    const changedShared = storedPresentation(
      Object.freeze({
        ...shared.message,
        content: [{ type: 'text' as const, text: 'changed' }],
      }),
      2,
    )
    const changedPath = basePath
      .truncate(shared.header.id)
      .replace(changedShared.header)
      .append(sibling.header)
    const invalidatedTransition = transitionTranscriptBodyWindow(
      changedPath,
      Object.freeze([sibling]),
      base,
      basePath,
    )
    expect(invalidatedTransition.kind).toBe('exact')
    const invalidated = requireTransitionWindow(invalidatedTransition, 'exact')
    expect(invalidated).toMatchObject({
      branchLength: 60,
      offset: 0,
      rowCount: 60,
      staleBodyCount: 1,
    })
    expect(transcriptBodyWindowFindRow(invalidated, shared.header.id)).toMatchObject({
      header: { bodyVersion: 2 },
      bodyVersion: 1,
      bodyExact: false,
    })
    expect(transcriptBodyWindowFindRow(invalidated, sibling.header.id)).toMatchObject({
      bodyVersion: 1,
      bodyExact: true,
      message: { content: sibling.message.content },
    })
  })

  it('describes a divergent suffix larger than one body-read page without filling the gap', () => {
    const presentations = storedLinearRows(80)
    const basePath = createBranchPath(presentations.map((row) => row.header))
    const baseTransition = transitionTranscriptBodyWindow(basePath, presentations, null, null)
    const base = requireTransitionWindow(baseTransition, 'terminal')
    const boundary = presentations[39] as TranscriptBodyPresentation
    const divergentPresentations: TranscriptBodyPresentation[] = []
    let divergentPath = basePath.truncate(boundary.header.id)
    let parentId = boundary.header.id

    for (let index = 40; index < 80; index += 1) {
      const row = storedPresentation(
        message(`divergent-${index}`, parentId, index, `divergent-${index}`),
      )
      divergentPresentations.push(row)
      divergentPath = divergentPath.append(row.header)
      parentId = row.header.id
    }

    const transition = transitionTranscriptBodyWindow(
      divergentPath,
      Object.freeze([divergentPresentations.at(-1) as TranscriptBodyPresentation]),
      base,
      basePath,
    )

    expect(transition.kind).toBe('divergent')
    if (transition.kind !== 'divergent') {
      throw new Error(`TranscriptTransitionExpected:divergent:received:${transition.kind}`)
    }
    expect(transition.suffix).toEqual({
      branchLength: 80,
      offset: 40,
      limit: 40,
      boundaryParentId: boundary.header.id,
    })
    expect(transition.commonPrefix).toMatchObject({ offset: 0, rowCount: 40 })
    expect(
      [...transcriptBodyWindowPages(transition.commonPrefix)].map((page) => page.rowCount),
    ).toEqual([24, 16])
    expect(transition.terminalFallback).toMatchObject({ offset: 79, rowCount: 1 })
  })
})

const STORED_CHAT_ID = 'stored-chat' as ChatId

function storedLinearRows(count: number): readonly TranscriptBodyPresentation[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      storedPresentation(
        message(
          `stored-${index}`,
          index === 0 ? null : `stored-${index - 1}`,
          index,
          `body-${index}`,
        ),
      ),
    ),
  )
}

function message(id: MessageId, parentId: MessageId | null, index: number, text: string): Message {
  return Object.freeze({
    id,
    chatId: STORED_CHAT_ID,
    parentId,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: index,
    createdAt: index,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text' as const, text }],
    nodeVersion: 0,
    deleted: false,
  })
}

function storedPresentation(message: Message, bodyVersion = 1): TranscriptBodyPresentation {
  const { header } = splitMessageForStorage(message, { bodyVersion })
  return Object.freeze({ header, message, bodyVersion })
}

function poisonFullMaterialization<T extends MessageTreeNode>(
  path: BranchPathDescriptor<T>,
  backwardLimits: number[],
): BranchPathDescriptor<T> {
  return new Proxy(path, {
    get(target, property) {
      if (property === 'materializeNodes' || property === 'materializeIds') {
        return () => {
          throw new Error('FullPathMaterializationForbidden')
        }
      }
      if (property === 'backwardWindow') {
        return (page: { endingAt: MessageId; limit: number }) => {
          backwardLimits.push(page.limit)
          return target.backwardWindow(page)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value
    },
  })
}

function poisonMaterializationAndMeasureLookups<T extends MessageTreeNode>(
  path: BranchPathDescriptor<T>,
  reads: { get: number; indexOf: number },
): BranchPathDescriptor<T> {
  return new Proxy(path, {
    get(target, property) {
      if (property === 'materializeNodes' || property === 'materializeIds') {
        return () => {
          throw new Error('FullPathMaterializationForbidden')
        }
      }
      if (property === 'get') {
        return (messageId: MessageId) => {
          reads.get += 1
          return target.get(messageId)
        }
      }
      if (property === 'indexOf') {
        return (messageId: MessageId) => {
          reads.indexOf += 1
          return target.indexOf(messageId)
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function'
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value
    },
  })
}

function requireTransitionWindow<K extends 'exact' | 'terminal'>(
  transition: TranscriptBodyTransition,
  kind: K,
): TranscriptBodyWindow {
  if (transition.kind !== kind) {
    throw new Error(`TranscriptTransitionExpected:${kind}:received:${transition.kind}`)
  }
  return transition.window
}

function linearHeaders(
  count: number,
  work: { readonly textChars: number; readonly renderCost: number },
) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    siblingIndex: 0,
    createdAt: index,
    deleted: false,
    bodyTextCharCount: work.textChars,
    bodyRenderCost: work.renderCost,
  }))
}

function mixedHeaders(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `mixed-${index}`,
    parentId: index === 0 ? null : `mixed-${index - 1}`,
    siblingIndex: 0,
    createdAt: index,
    deleted: false,
    bodyTextCharCount: index % 3 === 0 ? 2_000_000 : 8,
    bodyRenderCost: index % 3 === 0 ? 20_000 : 1,
  }))
}
