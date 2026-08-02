import { sameValue } from '../lib/same-value'
import {
  reasoningCarrierDescriptorEquals,
  reasoningCarrierDescriptorFromCarrier,
  reasoningCarrierPayloadLength,
  reasoningVisiblePartEquals,
} from './reasoning-envelope'
import type {
  Message,
  MessageAttemptOwner,
  OpaqueReasoningCarrierV2Descriptor,
  ProviderOutputItem,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
  ReasoningVisiblePartV2,
} from './types'

export type ReasoningAuthoringOperation =
  | Readonly<{
      kind: 'visible-create'
      owner: MessageAttemptOwner
      part: ReasoningVisiblePartV2
    }>
  | Readonly<{
      kind: 'visible-replace'
      member: Extract<ReasoningMemberRef, { kind: 'visible' }>
      expected: ReasoningVisiblePartV2
      next: ReasoningVisiblePartV2
    }>
  | Readonly<{
      kind: 'visible-delete'
      member: Extract<ReasoningMemberRef, { kind: 'visible' }>
      expected: ReasoningVisiblePartV2
    }>
  | Readonly<{
      kind: 'carrier-set-hidden'
      member: Extract<ReasoningMemberRef, { kind: 'carrier' }>
      expected: OpaqueReasoningCarrierV2Descriptor
      hidden: boolean
    }>
  | Readonly<{
      kind: 'carrier-delete'
      member: Extract<ReasoningMemberRef, { kind: 'carrier' }>
      expected: OpaqueReasoningCarrierV2Descriptor
    }>

export type ReasoningAuthoringEntry =
  | Readonly<{
      kind: 'visible'
      owner: MessageAttemptOwner
      part: ReasoningVisiblePartV2
    }>
  | Readonly<{
      kind: 'carrier'
      owner: MessageAttemptOwner
      carrier: OpaqueReasoningCarrierV2Descriptor
      payloadLength: number
    }>

export interface ReasoningAuthoringProjection {
  readonly owners: readonly MessageAttemptOwner[]
  readonly entries: readonly ReasoningAuthoringEntry[]
}

export type ProviderOutputAuthoringOperation =
  | Readonly<{
      kind: 'provider-output-create'
      owner: MessageAttemptOwner
      item: ProviderOutputItem
    }>
  | Readonly<{
      kind: 'provider-output-replace'
      member: ProviderOutputMemberRef
      expected: ProviderOutputItem
      next: ProviderOutputItem
    }>
  | Readonly<{
      kind: 'provider-output-delete'
      member: ProviderOutputMemberRef
      expected: ProviderOutputItem
    }>

export type ProviderOutputAuthoringEntry = Readonly<{
  editorId: string
  owner: MessageAttemptOwner
  item: ProviderOutputItem
  member?: ProviderOutputMemberRef
  original?: ProviderOutputItem
}>

export interface ProviderOutputAuthoringProjection {
  readonly owners: readonly MessageAttemptOwner[]
  readonly entries: readonly ProviderOutputAuthoringEntry[]
}

export interface MessageBodyAuthoringOperations {
  readonly reasoning?: readonly ReasoningAuthoringOperation[]
  readonly providerOutput?: readonly ProviderOutputAuthoringOperation[]
}

export function projectReasoningAuthoring(message: Message): ReasoningAuthoringProjection {
  const owners = appliedAttemptOwners(message)
  const entries: ReasoningAuthoringEntry[] = []
  const generationOwner = owners[0]
  if (!generationOwner) throw new Error('MessageGenerationOwnerMissing')
  appendOwner(entries, generationOwner, message.reasoningEnvelope)
  for (const attempt of message.continuationAttempts ?? []) {
    if (attempt.application.kind !== 'applied') continue
    const owner = { kind: 'continuation', streamId: attempt.streamId } as const
    appendOwner(entries, owner, attempt.reasoningEnvelope)
  }
  return { owners, entries }
}

export function projectProviderOutputAuthoring(
  message: Message,
): ProviderOutputAuthoringProjection {
  const owners = appliedAttemptOwners(message)
  const entries: ProviderOutputAuthoringEntry[] = []
  const generationOwner = owners[0]
  if (!generationOwner) throw new Error('MessageGenerationOwnerMissing')
  appendProviderOutputOwner(entries, generationOwner, message.providerOutputItems)
  for (const attempt of message.continuationAttempts ?? []) {
    if (attempt.application.kind !== 'applied') continue
    appendProviderOutputOwner(
      entries,
      { kind: 'continuation', streamId: attempt.streamId },
      attempt.providerOutputItems,
    )
  }
  return { owners, entries }
}

export function planReasoningAuthoringOperations(
  initial: readonly ReasoningAuthoringEntry[],
  next: readonly ReasoningAuthoringEntry[],
): ReasoningAuthoringOperation[] {
  const initialByKey = new Map(initial.map((entry) => [entryKey(entry), entry]))
  const nextByKey = new Map(next.map((entry) => [entryKey(entry), entry]))
  const operations: ReasoningAuthoringOperation[] = []
  const invalidatedVisibleIds = new Set<string>()
  for (const entry of initial) {
    if (entry.kind !== 'visible') continue
    const updated = nextByKey.get(entryKey(entry))
    if (
      updated?.kind !== 'visible' ||
      updated.part.kind !== entry.part.kind ||
      updated.part.text !== entry.part.text
    ) {
      invalidatedVisibleIds.add(entry.part.id)
    }
  }

  for (const entry of initial) {
    const key = entryKey(entry)
    const updated = nextByKey.get(key)
    if (
      entry.kind === 'carrier' &&
      (entry.carrier.kind === 'anthropic-signature' ||
        entry.carrier.kind === 'gemini-thought-signature') &&
      entry.carrier.bindsVisiblePartId !== undefined &&
      invalidatedVisibleIds.has(entry.carrier.bindsVisiblePartId)
    ) {
      continue
    }
    if (!updated) {
      if (entry.kind === 'visible') {
        operations.push({
          kind: 'visible-delete',
          member: { owner: entry.owner, kind: 'visible', id: entry.part.id },
          expected: entry.part,
        })
      } else {
        operations.push({
          kind: 'carrier-delete',
          member: { owner: entry.owner, kind: 'carrier', id: entry.carrier.id },
          expected: entry.carrier,
        })
      }
      continue
    }
    if (entry.kind === 'visible') {
      if (updated.kind !== 'visible') throw new Error(`ReasoningAuthoringKindChanged:${key}`)
      if (!reasoningVisiblePartEquals(entry.part, updated.part)) {
        operations.push({
          kind: 'visible-replace',
          member: { owner: entry.owner, kind: 'visible', id: entry.part.id },
          expected: entry.part,
          next: updated.part,
        })
      }
      continue
    }
    if (updated.kind !== 'carrier') throw new Error(`ReasoningAuthoringKindChanged:${key}`)
    const { hidden: _initialHidden, ...carrierWithoutHidden } = entry.carrier
    const allowed =
      updated.carrier.hidden === true
        ? { ...carrierWithoutHidden, hidden: true as const }
        : carrierWithoutHidden
    if (!reasoningCarrierDescriptorEquals(allowed, updated.carrier)) {
      throw new Error(`ReasoningCarrierAuthoringMetadataChanged:${entry.carrier.id}`)
    }
    if (entry.carrier.hidden !== updated.carrier.hidden) {
      operations.push({
        kind: 'carrier-set-hidden',
        member: { owner: entry.owner, kind: 'carrier', id: entry.carrier.id },
        expected: entry.carrier,
        hidden: updated.carrier.hidden === true,
      })
    }
  }

  for (const entry of next) {
    if (initialByKey.has(entryKey(entry))) continue
    if (entry.kind !== 'visible') throw new Error('ReasoningCarrierCreationUnsupported')
    operations.push({ kind: 'visible-create', owner: entry.owner, part: entry.part })
  }
  return operations
}

export function reasoningAuthoringEntryKey(entry: ReasoningAuthoringEntry): string {
  return entryKey(entry)
}

export function planProviderOutputAuthoringOperations(
  initial: readonly ProviderOutputAuthoringEntry[],
  next: readonly ProviderOutputAuthoringEntry[],
): ProviderOutputAuthoringOperation[] {
  const initialById = new Map(initial.map((entry) => [entry.editorId, entry]))
  const nextById = new Map(next.map((entry) => [entry.editorId, entry]))
  const replacements: ProviderOutputAuthoringOperation[] = []
  const deletions: Extract<ProviderOutputAuthoringOperation, { kind: 'provider-output-delete' }>[] =
    []
  const creations: ProviderOutputAuthoringOperation[] = []

  for (const entry of initial) {
    if (!entry.member || !entry.original) throw new Error('StoredProviderOutputIdentityMissing')
    const updated = nextById.get(entry.editorId)
    if (!updated) {
      deletions.push({
        kind: 'provider-output-delete',
        member: entry.member,
        expected: entry.original,
      })
      continue
    }
    if (
      !sameAttemptOwner(entry.owner, updated.owner) ||
      updated.member?.itemIndex !== entry.member.itemIndex
    ) {
      throw new Error(`ProviderOutputAuthoringIdentityChanged:${entry.editorId}`)
    }
    if (!providerOutputItemEquals(entry.item, updated.item)) {
      replacements.push({
        kind: 'provider-output-replace',
        member: entry.member,
        expected: entry.original,
        next: markProviderOutputEdited(entry.original, updated.item),
      })
    }
  }

  for (const entry of next) {
    if (initialById.has(entry.editorId)) continue
    if (entry.member || entry.original) throw new Error('NewProviderOutputHasStoredIdentity')
    creations.push({
      kind: 'provider-output-create',
      owner: entry.owner,
      item: { ...entry.item, edited: true },
    })
  }

  deletions.sort((left, right) => {
    const ownerOrder = ownerKey(left.member.owner).localeCompare(ownerKey(right.member.owner))
    return ownerOrder === 0 ? right.member.itemIndex - left.member.itemIndex : ownerOrder
  })
  return [...replacements, ...deletions, ...creations]
}

export function providerOutputItemEquals(
  left: ProviderOutputItem,
  right: ProviderOutputItem,
): boolean {
  return sameValue(left, right)
}

export function preserveProviderSealedFields(original: unknown, edited: unknown): unknown {
  if (!original || typeof original !== 'object') return edited
  if (!edited || typeof edited !== 'object') return edited
  if (Array.isArray(original)) {
    if (!Array.isArray(edited)) return edited
    return edited.map((child, index) => preserveProviderSealedFields(original[index], child))
  }
  if (Array.isArray(edited)) return edited
  const next: Record<string, unknown> = { ...(edited as Record<string, unknown>) }
  for (const [key, originalChild] of Object.entries(original)) {
    if (PROVIDER_SEALED_FIELD_NAMES.has(key)) {
      next[key] = originalChild
    } else if (key in next) {
      next[key] = preserveProviderSealedFields(originalChild, next[key])
    }
  }
  return next
}

function appendOwner(
  entries: ReasoningAuthoringEntry[],
  owner: MessageAttemptOwner,
  envelope: Message['reasoningEnvelope'],
): void {
  if (!envelope) return
  for (const part of envelope.visible) entries.push({ kind: 'visible', owner, part })
  for (const carrier of envelope.carriers) {
    entries.push({
      kind: 'carrier',
      owner,
      carrier: reasoningCarrierDescriptorFromCarrier(carrier),
      payloadLength: reasoningCarrierPayloadLength(carrier),
    })
  }
}

function appendProviderOutputOwner(
  entries: ProviderOutputAuthoringEntry[],
  owner: MessageAttemptOwner,
  items: readonly ProviderOutputItem[] | undefined,
): void {
  for (const [itemIndex, item] of (items ?? []).entries()) {
    entries.push({
      editorId: `stored:${ownerKey(owner)}:${itemIndex}`,
      owner,
      item,
      member: { owner, itemIndex },
      original: item,
    })
  }
}

function appliedAttemptOwners(message: Message): MessageAttemptOwner[] {
  const owners: MessageAttemptOwner[] = [{ kind: 'generation' }]
  for (const attempt of message.continuationAttempts ?? []) {
    if (attempt.application.kind === 'applied') {
      owners.push({ kind: 'continuation', streamId: attempt.streamId })
    }
  }
  return owners
}

function markProviderOutputEdited(
  original: ProviderOutputItem,
  edited: ProviderOutputItem,
): ProviderOutputItem {
  const sealedItem = preserveProviderSealedFields(original.item, edited.item)
  const next: ProviderOutputItem = {
    ...edited,
    item: sealedItem,
  }
  const { hidden: _originalHidden, edited: _originalEdited, ...originalBody } = original
  const { hidden: _nextHidden, edited: _nextEdited, ...nextBody } = next
  if (original.edited === true || !sameValue(originalBody, nextBody)) next.edited = true
  else delete next.edited
  return next
}

function sameAttemptOwner(left: MessageAttemptOwner, right: MessageAttemptOwner): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'generation' ||
      (right.kind === 'continuation' && left.streamId === right.streamId))
  )
}

const PROVIDER_SEALED_FIELD_NAMES = new Set(['encrypted_content', 'thoughtSignature', 'signature'])

function ownerKey(owner: MessageAttemptOwner): string {
  return owner.kind === 'generation' ? 'generation' : `continuation:${owner.streamId}`
}

function entryKey(entry: ReasoningAuthoringEntry): string {
  const id = entry.kind === 'visible' ? entry.part.id : entry.carrier.id
  return `${ownerKey(entry.owner)}:${entry.kind}:${id}`
}
