import type { MessageRole } from './types'

export interface ContextSelectionItem {
  readonly role: MessageRole
}

export interface UserAnchoredContextGroups<T> {
  readonly preamble: readonly T[]
  readonly pairs: readonly (readonly T[])[]
}

export interface ContextPairCostRequest {
  readonly pairIndex: number
  readonly direction: 'forward' | 'backward'
}

export interface ContextPairSelection {
  readonly headPairCount: number
  readonly tailStart: number
  readonly totalPairCount: number
}

interface ContextPairSelectionInput {
  readonly pairCount: number
  readonly keepFirstPairs: number
  readonly requiredTailPairs?: number
  readonly availableTokens: number
}

export function groupUserAnchoredContextItems<T extends ContextSelectionItem>(
  items: readonly T[],
): UserAnchoredContextGroups<T> {
  const preamble: T[] = []
  const pairs: T[][] = []
  let current: T[] | null = null
  for (const item of items) {
    if (item.role === 'user') {
      if (current) pairs.push(current)
      current = [item]
    } else if (current) {
      current.push(item)
    } else {
      preamble.push(item)
    }
  }
  if (current) pairs.push(current)
  return { preamble, pairs }
}

export function selectContextPairs(
  input: ContextPairSelectionInput & {
    readonly pairCost: (request: ContextPairCostRequest) => number
  },
): ContextPairSelection {
  const machine = contextPairSelectionMachine(input)
  let step = machine.next()
  while (!step.done) step = machine.next(input.pairCost(step.value))
  return step.value
}

export async function selectContextPairsLazily(
  input: ContextPairSelectionInput & {
    readonly pairCost: (request: ContextPairCostRequest) => Promise<number>
  },
): Promise<ContextPairSelection> {
  const machine = contextPairSelectionMachine(input)
  let step = machine.next()
  while (!step.done) step = machine.next(await input.pairCost(step.value))
  return step.value
}

function* contextPairSelectionMachine(
  input: ContextPairSelectionInput,
): Generator<ContextPairCostRequest, ContextPairSelection, number> {
  const pairCount = Math.max(0, Math.floor(input.pairCount))
  const requiredTailPairs = Math.min(
    Math.max(0, Math.floor(input.requiredTailPairs ?? 0)),
    pairCount,
  )
  const requiredTailStart = pairCount - requiredTailPairs
  const costs = new Map<number, number>()
  let requiredTailTokens = 0
  for (let pairIndex = pairCount - 1; pairIndex >= requiredTailStart; pairIndex -= 1) {
    const cost = Math.max(0, yield { pairIndex, direction: 'backward' })
    costs.set(pairIndex, cost)
    requiredTailTokens += cost
  }
  let headPairCount = Math.min(Math.max(0, Math.floor(input.keepFirstPairs)), requiredTailStart)
  let headTokens = 0
  for (let pairIndex = 0; pairIndex < headPairCount; pairIndex += 1) {
    const cost = Math.max(0, yield { pairIndex, direction: 'forward' })
    costs.set(pairIndex, cost)
    headTokens += cost
  }
  const headBudget = Math.max(0, input.availableTokens - requiredTailTokens)
  while (headPairCount > 0 && headTokens > headBudget) {
    headPairCount -= 1
    headTokens -= costs.get(headPairCount) ?? 0
  }

  const remaining = Math.max(0, input.availableTokens - requiredTailTokens - headTokens)
  let tailStart = requiredTailStart
  let optionalTailTokens = 0
  for (let pairIndex = requiredTailStart - 1; pairIndex >= headPairCount; pairIndex -= 1) {
    let cost = costs.get(pairIndex)
    if (cost === undefined) {
      cost = Math.max(0, yield { pairIndex, direction: 'backward' })
      costs.set(pairIndex, cost)
    }
    if (optionalTailTokens + cost > remaining) break
    optionalTailTokens += cost
    tailStart = pairIndex
  }

  return { headPairCount, tailStart, totalPairCount: pairCount }
}
