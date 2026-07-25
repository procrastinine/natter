import type { ChatId, Message, MessageId } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import {
  type MessageHeaderRow,
  type MessagePresentation,
  rebaseHydratedMessageHeader,
} from './message-storage'
import { generationMessageReadProofMatchesHeader, type WorkspaceFence } from './repository'
import type { PreparedGenerationPrompt } from './workspace-protocol'

export interface GenerationPromptMaterialObservation extends WorkspaceFence {
  readonly material: readonly (MessagePresentation | undefined)[]
}

export type GenerationPromptMaterialLoader = (
  headers: readonly MessageHeaderRow[],
  signal: AbortSignal,
) => Promise<GenerationPromptMaterialObservation>

export interface GenerationPromptMaterialLease extends WorkspaceFence {
  readonly chatId: ChatId
  seed(fence: WorkspaceFence, presentations: readonly MessagePresentation[]): void
  seal(fence: WorkspaceFence, prompt: PreparedGenerationPrompt): void
  covers(fence: WorkspaceFence, headers: readonly MessageHeaderRow[]): boolean
  read(
    fence: WorkspaceFence,
    headers: readonly MessageHeaderRow[],
    loader: GenerationPromptMaterialLoader,
    signal?: AbortSignal,
  ): Promise<readonly MessagePresentation[]>
  release(): void
}

export interface WorkspaceMessageMaterialCoordinator extends WorkspaceFence {
  acquirePrompt(
    chatId: ChatId,
    capturedHeaders: readonly MessageHeaderRow[],
    onRelease?: (lease: GenerationPromptMaterialLease) => void,
  ): GenerationPromptMaterialLease
  read(
    fence: WorkspaceFence,
    headers: readonly MessageHeaderRow[],
    loader: GenerationPromptMaterialLoader,
    signal?: AbortSignal,
  ): Promise<readonly (MessagePresentation | undefined)[]>
  reserve(
    fence: WorkspaceFence,
    headers: readonly MessageHeaderRow[],
  ): WorkspaceMessageMaterialReservation
  release(): void
}

export interface WorkspaceMessageMaterialReservation extends WorkspaceFence {
  release(): void
}

export const GENERATION_MATERIAL_PAGE_ROWS = 16
export const GENERATION_MATERIAL_PAGE_TEXT_CHARS = 256_000

export function createWorkspaceMessageMaterialCoordinator(
  fence: WorkspaceFence,
): WorkspaceMessageMaterialCoordinator {
  return new TabWorkspaceMessageMaterialCoordinator(fence)
}

export function createGenerationPromptMaterialLease(
  fence: WorkspaceFence,
  chatId: ChatId,
  capturedHeaders: readonly MessageHeaderRow[],
  onRelease: (lease: GenerationPromptMaterialLease) => void = () => undefined,
): GenerationPromptMaterialLease {
  const coordinator = createWorkspaceMessageMaterialCoordinator(fence)
  return coordinator.acquirePrompt(chatId, capturedHeaders, (lease) => {
    onRelease(lease)
    coordinator.release()
  })
}

interface SharedMaterialLoad {
  readonly header: MessageHeaderRow
  readonly value: Promise<MessagePresentation | undefined>
  readonly batch: SharedMaterialBatch
}

interface SharedMaterialBatch {
  readonly controller: AbortController
  readonly value: Promise<GenerationPromptMaterialObservation>
  references: number
  settled: boolean
}

type PromptMaterialIdentity = string & { readonly __promptMaterialIdentity: unique symbol }

class TabWorkspaceMessageMaterialCoordinator implements WorkspaceMessageMaterialCoordinator {
  readonly workspaceId: string
  readonly replacementEpoch: number
  private readonly workspaceAbort = new AbortController()
  private readonly leases = new Set<PerAttemptGenerationPromptMaterialLease>()
  private readonly reservations = new Set<TabWorkspaceMessageMaterialReservation>()
  private readonly claimIdentitiesByLease = new Map<
    PerAttemptGenerationPromptMaterialLease,
    ReadonlySet<PromptMaterialIdentity>
  >()
  private readonly claimCounts = new Map<PromptMaterialIdentity, number>()
  private readonly retainedByIdentity = new Map<PromptMaterialIdentity, MessagePresentation>()
  private readonly loadingByIdentity = new Map<PromptMaterialIdentity, SharedMaterialLoad>()
  private readonly activeBatches = new Set<SharedMaterialBatch>()
  private released = false

  constructor(fence: WorkspaceFence) {
    this.workspaceId = fence.workspaceId
    this.replacementEpoch = fence.replacementEpoch
  }

  acquirePrompt(
    chatId: ChatId,
    capturedHeaders: readonly MessageHeaderRow[],
    onRelease: (lease: GenerationPromptMaterialLease) => void = () => undefined,
  ): GenerationPromptMaterialLease {
    if (this.released) throw new Error('WorkspaceMessageMaterialCoordinatorReleased')
    const lease = new PerAttemptGenerationPromptMaterialLease(
      this,
      chatId,
      capturedHeaders,
      onRelease,
    )
    this.leases.add(lease)
    this.claimsChanged(lease)
    return lease
  }

  async read(
    fence: WorkspaceFence,
    headers: readonly MessageHeaderRow[],
    loader: GenerationPromptMaterialLoader,
    signal?: AbortSignal,
  ): Promise<readonly (MessagePresentation | undefined)[]> {
    this.assertFence(fence)
    if (this.released) throw new Error('WorkspaceMessageMaterialCoordinatorReleased')
    assertMaterialHeaders(headers)
    signal?.throwIfAborted()
    const rows: Array<MessagePresentation | undefined> = []
    for (const page of generationMaterialPages(headers)) {
      const values = new Map<MessageId, Promise<MessagePresentation | undefined>>()
      const batches = new Set<SharedMaterialBatch>()
      const unloaded: MessageHeaderRow[] = []
      for (const header of page) {
        const retained = this.retained(header)
        if (retained) {
          values.set(header.id, Promise.resolve(retained))
          continue
        }
        const loading = this.loading(header)
        if (loading) {
          values.set(header.id, loading.value)
          batches.add(loading.batch)
          continue
        }
        unloaded.push(header)
      }
      if (unloaded.length > 0) {
        const batch = this.startBatch(unloaded, loader)
        batches.add(batch)
        for (let index = 0; index < unloaded.length; index += 1) {
          const header = unloaded[index] as MessageHeaderRow
          const value = batch.value.then((observation) => {
            this.assertFence(observation)
            const presentation = observation.material[index]
            const normalized = presentation
              ? normalizeMaterialPresentation(presentation, header)
              : undefined
            if (normalized) this.retainIfClaimed(normalized)
            return normalized ?? presentation
          })
          const loading: SharedMaterialLoad = { header, value, batch }
          const identity = promptMaterialIdentity(header)
          this.loadingByIdentity.set(identity, loading)
          values.set(header.id, value)
          void value.catch(() => undefined).finally(() => this.removeLoading(identity, loading))
        }
      }
      for (const batch of batches) batch.references += 1
      try {
        const pageRows = await awaitWithAbort(
          Promise.all(
            page.map((header) => {
              const value = values.get(header.id)
              if (!value) throw new Error(`WorkspaceMessageMaterialLoadMissing:${header.id}`)
              return value
            }),
          ),
          signal,
        )
        rows.push(...pageRows)
      } finally {
        for (const batch of batches) this.releaseBatch(batch)
      }
    }
    signal?.throwIfAborted()
    return Object.freeze(rows)
  }

  reserve(
    fence: WorkspaceFence,
    headers: readonly MessageHeaderRow[],
  ): WorkspaceMessageMaterialReservation {
    this.assertFence(fence)
    if (this.released) throw new Error('WorkspaceMessageMaterialCoordinatorReleased')
    assertMaterialHeaders(headers)
    const reservation = new TabWorkspaceMessageMaterialReservation(
      this,
      headers.map(promptMaterialIdentity),
    )
    this.reservations.add(reservation)
    this.addClaims(reservation.identities)
    return reservation
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.workspaceAbort.abort(new Error('WorkspaceMessageMaterialCoordinatorReleased'))
    for (const lease of [...this.leases]) lease.release()
    for (const reservation of [...this.reservations]) reservation.release()
    this.leases.clear()
    this.reservations.clear()
    this.claimIdentitiesByLease.clear()
    this.claimCounts.clear()
    this.retainedByIdentity.clear()
    this.loadingByIdentity.clear()
    this.activeBatches.clear()
  }

  seedClaimed(
    lease: PerAttemptGenerationPromptMaterialLease,
    fence: WorkspaceFence,
    presentations: readonly MessagePresentation[],
  ): void {
    this.assertFence(fence)
    if (this.released || !this.leases.has(lease)) return
    for (const presentation of presentations) {
      const header = lease.claimedHeader(presentation.header.id)
      if (!header) continue
      const normalized = normalizeMaterialPresentation(presentation, header)
      if (normalized) this.retainIfClaimed(normalized)
    }
  }

  claimsChanged(lease: PerAttemptGenerationPromptMaterialLease): void {
    if (!this.leases.has(lease)) return
    const previous = this.claimIdentitiesByLease.get(lease) ?? new Set()
    const next = new Set(lease.claimedMaterialIdentities())
    for (const identity of previous) {
      if (next.has(identity)) continue
      const count = (this.claimCounts.get(identity) ?? 0) - 1
      if (count > 0) this.claimCounts.set(identity, count)
      else this.claimCounts.delete(identity)
    }
    for (const identity of next) {
      if (!previous.has(identity))
        this.claimCounts.set(identity, (this.claimCounts.get(identity) ?? 0) + 1)
    }
    this.claimIdentitiesByLease.set(lease, next)
    this.pruneRetained()
  }

  removeLease(lease: PerAttemptGenerationPromptMaterialLease): void {
    const identities = this.claimIdentitiesByLease.get(lease) ?? []
    for (const identity of identities) {
      const count = (this.claimCounts.get(identity) ?? 0) - 1
      if (count > 0) this.claimCounts.set(identity, count)
      else this.claimCounts.delete(identity)
    }
    this.claimIdentitiesByLease.delete(lease)
    this.leases.delete(lease)
    this.pruneRetained()
  }

  removeReservation(reservation: TabWorkspaceMessageMaterialReservation): void {
    if (!this.reservations.delete(reservation)) return
    this.removeClaims(reservation.identities)
    this.pruneRetained()
  }

  private assertFence(fence: WorkspaceFence): void {
    if (
      fence.workspaceId !== this.workspaceId ||
      fence.replacementEpoch !== this.replacementEpoch
    ) {
      throw new Error('WorkspaceMessageMaterialFenceMismatch')
    }
  }

  private retained(header: MessageHeaderRow): MessagePresentation | undefined {
    const presentation = this.retainedByIdentity.get(promptMaterialIdentity(header))
    return presentation ? normalizeMaterialPresentation(presentation, header) : undefined
  }

  private loading(header: MessageHeaderRow): SharedMaterialLoad | undefined {
    return this.loadingByIdentity.get(promptMaterialIdentity(header))
  }

  private retainIfClaimed(presentation: MessagePresentation): void {
    const identity = promptMaterialIdentity(presentation.header)
    if (!this.claimCounts.has(identity)) return
    this.retainedByIdentity.set(identity, presentation)
  }

  private addClaims(identities: Iterable<PromptMaterialIdentity>): void {
    for (const identity of identities) {
      this.claimCounts.set(identity, (this.claimCounts.get(identity) ?? 0) + 1)
    }
  }

  private removeClaims(identities: Iterable<PromptMaterialIdentity>): void {
    for (const identity of identities) {
      const count = (this.claimCounts.get(identity) ?? 0) - 1
      if (count > 0) this.claimCounts.set(identity, count)
      else this.claimCounts.delete(identity)
    }
  }

  private pruneRetained(): void {
    for (const identity of this.retainedByIdentity.keys()) {
      if (!this.claimCounts.has(identity)) this.retainedByIdentity.delete(identity)
    }
  }

  private removeLoading(identity: PromptMaterialIdentity, loading: SharedMaterialLoad): void {
    if (this.loadingByIdentity.get(identity) === loading) this.loadingByIdentity.delete(identity)
  }

  private startBatch(
    headers: readonly MessageHeaderRow[],
    loader: GenerationPromptMaterialLoader,
  ): SharedMaterialBatch {
    const controller = new AbortController()
    const abort = () => controller.abort(this.workspaceAbort.signal.reason)
    this.workspaceAbort.signal.addEventListener('abort', abort, { once: true })
    const batch: SharedMaterialBatch = {
      controller,
      value: Promise.resolve()
        .then(() => loader(Object.freeze([...headers]), controller.signal))
        .finally(() => {
          batch.settled = true
          this.activeBatches.delete(batch)
          this.workspaceAbort.signal.removeEventListener('abort', abort)
        }),
      references: 0,
      settled: false,
    }
    this.activeBatches.add(batch)
    return batch
  }

  private releaseBatch(batch: SharedMaterialBatch): void {
    batch.references -= 1
    if (batch.references === 0 && !batch.settled) {
      batch.controller.abort(new Error('WorkspaceMessageMaterialBatchUnobserved'))
    }
  }
}

class TabWorkspaceMessageMaterialReservation implements WorkspaceMessageMaterialReservation {
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly identities: ReadonlySet<PromptMaterialIdentity>
  private readonly coordinator: TabWorkspaceMessageMaterialCoordinator
  private released = false

  constructor(
    coordinator: TabWorkspaceMessageMaterialCoordinator,
    identities: readonly PromptMaterialIdentity[],
  ) {
    this.workspaceId = coordinator.workspaceId
    this.replacementEpoch = coordinator.replacementEpoch
    this.coordinator = coordinator
    this.identities = new Set(identities)
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.coordinator.removeReservation(this)
  }
}

class PerAttemptGenerationPromptMaterialLease implements GenerationPromptMaterialLease {
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly chatId: ChatId
  private readonly coordinator: TabWorkspaceMessageMaterialCoordinator
  private readonly onRelease: (lease: GenerationPromptMaterialLease) => void
  private readonly claimedHeaders = new Map<MessageId, MessageHeaderRow>()
  private sealedHeaders: ReadonlyMap<MessageId, MessageHeaderRow> | null = null
  private released = false

  constructor(
    coordinator: TabWorkspaceMessageMaterialCoordinator,
    chatId: ChatId,
    capturedHeaders: readonly MessageHeaderRow[],
    onRelease: (lease: GenerationPromptMaterialLease) => void,
  ) {
    this.workspaceId = coordinator.workspaceId
    this.replacementEpoch = coordinator.replacementEpoch
    this.chatId = chatId
    this.coordinator = coordinator
    this.onRelease = onRelease
    for (const header of capturedHeaders) {
      if (header.chatId !== chatId || this.claimedHeaders.has(header.id)) {
        throw new Error('GenerationPromptMaterialCaptureMismatch')
      }
      this.claimedHeaders.set(header.id, header)
    }
  }

  seed(fence: WorkspaceFence, presentations: readonly MessagePresentation[]): void {
    if (this.released) return
    this.coordinator.seedClaimed(this, fence, presentations)
  }

  seal(fence: WorkspaceFence, prompt: PreparedGenerationPrompt): void {
    if (this.released) throw new Error('GenerationPromptMaterialLeaseReleased')
    if (!this.matchesFence(fence)) throw new Error('GenerationPromptMaterialSealMismatch')
    if (
      prompt.headers.some((header) => header.chatId !== this.chatId) ||
      (prompt.headers.at(-1)?.id ?? null) !== prompt.leafId
    ) {
      throw new Error('GenerationPromptMaterialSealMismatch')
    }
    const headers = new Map(prompt.headers.map((header) => [header.id, header] as const))
    if (
      headers.size !== prompt.headers.length ||
      prompt.messageProofs.length !== prompt.headers.length ||
      prompt.messageProofs.some(
        (proof, index) =>
          !generationMessageReadProofMatchesHeader(this.chatId, proof, prompt.headers[index]),
      ) ||
      prompt.knownPresentations.some((presentation) => {
        const header = headers.get(presentation.header.id)
        return !header || !normalizeMaterialPresentation(presentation, header)
      })
    ) {
      throw new Error('GenerationPromptMaterialSealMismatch')
    }
    this.claimedHeaders.clear()
    for (const header of prompt.headers) this.claimedHeaders.set(header.id, header)
    this.sealedHeaders = headers
    this.coordinator.claimsChanged(this)
    this.seed(fence, prompt.knownPresentations)
  }

  covers(fence: WorkspaceFence, headers: readonly MessageHeaderRow[]): boolean {
    if (this.released || !this.sealedHeaders || !this.matchesFence(fence)) return false
    return headers.every((header) => {
      const canonical = this.sealedHeaders?.get(header.id)
      return canonical !== undefined && samePromptMaterialHeader(canonical, header)
    })
  }

  async read(
    fence: WorkspaceFence,
    headers: readonly MessageHeaderRow[],
    loader: GenerationPromptMaterialLoader,
    signal?: AbortSignal,
  ): Promise<readonly MessagePresentation[]> {
    if (!this.covers(fence, headers)) throw new Error('GenerationPromptMaterialLeaseMismatch')
    const rows = await this.coordinator.read(fence, headers, loader, signal)
    return Object.freeze(
      rows.map((presentation, index) => {
        const header = headers[index] as MessageHeaderRow
        const normalized = presentation
          ? normalizeMaterialPresentation(presentation, header)
          : undefined
        if (!normalized) throw new Error(`GenerationPromptMaterialMissing:${header.id}`)
        return normalized
      }),
    )
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.coordinator.removeLease(this)
    this.claimedHeaders.clear()
    this.sealedHeaders = null
    this.onRelease(this)
  }

  claimedHeader(messageId: MessageId): MessageHeaderRow | undefined {
    return this.claimedHeaders.get(messageId)
  }

  claimedMaterialIdentities(): readonly PromptMaterialIdentity[] {
    return [...this.claimedHeaders.values()].map(promptMaterialIdentity)
  }

  private matchesFence(fence: WorkspaceFence): boolean {
    return (
      fence.workspaceId === this.workspaceId && fence.replacementEpoch === this.replacementEpoch
    )
  }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(errorFromUnknown(signal.reason))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function assertMaterialHeaders(headers: readonly MessageHeaderRow[]): void {
  const seen = new Set<MessageId>()
  for (const header of headers) {
    if (seen.has(header.id)) throw new Error(`WorkspaceMessageMaterialDuplicate:${header.id}`)
    seen.add(header.id)
  }
}

export function generationMaterialPages(
  headers: readonly MessageHeaderRow[],
): readonly MessageHeaderRow[][] {
  const pages: MessageHeaderRow[][] = []
  let page: MessageHeaderRow[] = []
  let textChars = 0
  for (const header of headers) {
    const wouldExceed =
      page.length > 0 &&
      (page.length >= GENERATION_MATERIAL_PAGE_ROWS ||
        textChars + header.bodyTextCharCount > GENERATION_MATERIAL_PAGE_TEXT_CHARS)
    if (wouldExceed) {
      pages.push(page)
      page = []
      textChars = 0
    }
    page.push(header)
    textChars += header.bodyTextCharCount
  }
  if (page.length > 0) pages.push(page)
  return pages
}

function normalizeMaterialPresentation(
  presentation: MessagePresentation,
  header: MessageHeaderRow,
): MessagePresentation | undefined {
  if (
    presentation.bodyVersion !== header.bodyVersion ||
    presentation.message.id !== header.id ||
    presentation.message.chatId !== header.chatId ||
    !samePromptMaterialHeader(presentation.header, header)
  ) {
    return undefined
  }
  const message: Message = rebaseHydratedMessageHeader(presentation.message, header)
  return Object.freeze({ header, message, bodyVersion: header.bodyVersion })
}

function samePromptMaterialHeader(left: MessageHeaderRow, right: MessageHeaderRow): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.role === right.role &&
    left.deleted === right.deleted &&
    left.requestContextVersion === right.requestContextVersion &&
    left.bodyVersion === right.bodyVersion
  )
}

function promptMaterialIdentity(header: MessageHeaderRow): PromptMaterialIdentity {
  return JSON.stringify([
    header.id,
    header.chatId,
    header.parentId,
    header.role,
    header.deleted,
    header.requestContextVersion,
    header.bodyVersion,
  ]) as PromptMaterialIdentity
}
