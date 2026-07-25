import type { IndexableTypeArray, IndexableTypeArrayReadonly } from 'dexie'

export type ExactCompoundPrefixRange = readonly [
  lower: IndexableTypeArray,
  upper: IndexableTypeArray,
  includeLower: true,
  includeUpper: false,
]

export type ScalarCompoundIndexRange = ExactCompoundPrefixRange

export function exactCompoundPrefixBetween(
  prefix: IndexableTypeArrayReadonly,
): ExactCompoundPrefixRange {
  if (prefix.length === 0) throw new Error('CompoundIndexPrefixRequired')
  return [[...prefix], [...prefix, []], true, false]
}

export function scalarCompoundIndexBetween(
  lowerPrefix: IndexableTypeArrayReadonly,
  upperPrefix: IndexableTypeArrayReadonly,
  componentCount: number,
): ScalarCompoundIndexRange {
  if (
    !Number.isSafeInteger(componentCount) ||
    componentCount < 1 ||
    lowerPrefix.length > componentCount ||
    upperPrefix.length > componentCount
  ) {
    throw new Error('ScalarCompoundIndexRangeInvalid')
  }
  return [
    [
      ...lowerPrefix,
      ...Array.from(
        { length: componentCount - lowerPrefix.length },
        () => Number.NEGATIVE_INFINITY,
      ),
    ],
    [...upperPrefix, ...Array.from({ length: componentCount - upperPrefix.length }, () => [])],
    true,
    false,
  ]
}

export function exactCompoundPrefixKeyRange(prefix: IndexableTypeArrayReadonly): IDBKeyRange {
  const [lower, upper] = exactCompoundPrefixBetween(prefix)
  return IDBKeyRange.bound(lower, upper, false, true)
}

export function scalarCompoundIndexKeyRange(
  lowerPrefix: IndexableTypeArrayReadonly,
  upperPrefix: IndexableTypeArrayReadonly,
  componentCount: number,
): IDBKeyRange {
  const [lower, upper] = scalarCompoundIndexBetween(lowerPrefix, upperPrefix, componentCount)
  return IDBKeyRange.bound(lower, upper, false, true)
}
