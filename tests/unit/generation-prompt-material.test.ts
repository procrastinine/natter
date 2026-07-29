import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../src/core/types'
import {
  createGenerationPromptMaterialLease,
  createWorkspaceMessageMaterialCoordinator,
  type GenerationPromptMaterialLease,
  type GenerationPromptMaterialLoader,
  type GenerationPromptMaterialObservation,
  type WorkspaceMessageMaterialCoordinator,
} from '../../src/store/generation-prompt-material'
import {
  type MessageHeaderRow,
  type MessagePresentation,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import {
  generationMessageReadProofFromHeader,
  type WorkspaceFence,
} from '../../src/store/repository'
import type { PreparedGenerationPrompt } from '../../src/store/workspace-protocol'

const CHAT_ID = 'chat-a'
const WORKSPACE_FENCE = Object.freeze({ workspaceId: 'workspace-a', replacementEpoch: 1 })

describe('generation prompt material lease', () => {
  it('returns exact seeded material without invoking the loader', async () => {
    const seeded = presentation('message-a')
    const lease = sealedLease([seeded.header])
    lease.seed(WORKSPACE_FENCE, [seeded])
    const loader = vi.fn<GenerationPromptMaterialLoader>(async () => observation([]))

    const result = await lease.read(WORKSPACE_FENCE, [seeded.header], loader)

    expect(loader).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0]?.message.content).toEqual(seeded.message.content)
  })

  it('shares per-message in-flight material across overlapping reads', async () => {
    const headers = ['message-a', 'message-b', 'message-c'].map((id) => presentation(id).header)
    const lease = sealedLease(headers)
    const pending: Array<Deferred<GenerationPromptMaterialObservation>> = []
    const requests: MessageHeaderRow[][] = []
    const loaderImplementation: GenerationPromptMaterialLoader = (requested) => {
      requests.push([...requested])
      const next = deferred<GenerationPromptMaterialObservation>()
      pending.push(next)
      return next.promise
    }
    const loader = vi.fn(loaderImplementation)

    const firstRead = lease.read(WORKSPACE_FENCE, headers.slice(0, 2), loader)
    await Promise.resolve()
    expect(requests.map(messageIds)).toEqual([['message-a', 'message-b']])

    const secondRead = lease.read(WORKSPACE_FENCE, headers.slice(1), loader)
    await Promise.resolve()
    expect(requests.map(messageIds)).toEqual([['message-a', 'message-b'], ['message-c']])

    for (let index = 0; index < pending.length; index += 1) {
      pending[index]?.resolve(observation((requests[index] ?? []).map(presentationForHeader)))
    }

    await expect(firstRead).resolves.toMatchObject([
      { header: { id: 'message-a' } },
      { header: { id: 'message-b' } },
    ])
    await expect(secondRead).resolves.toMatchObject([
      { header: { id: 'message-b' } },
      { header: { id: 'message-c' } },
    ])
    expectAtMostOnePhysicalReadPerIdentity(requests)
  })

  it('lets a transcript-first material read and generation join one physical load', async () => {
    const current = presentation('message-a')
    const { coordinator, lease } = sealedCoordinatorLease([current.header])
    const pending = deferred<GenerationPromptMaterialObservation>()
    const requests: MessageHeaderRow[][] = []
    const transcriptLoader = vi.fn<GenerationPromptMaterialLoader>((headers) => {
      requests.push([...headers])
      return pending.promise
    })
    const generationLoader = vi.fn<GenerationPromptMaterialLoader>(async (headers) =>
      observation(headers.map(presentationForHeader)),
    )

    const transcript = coordinator.read(WORKSPACE_FENCE, [current.header], transcriptLoader)
    await Promise.resolve()
    const generation = lease.read(WORKSPACE_FENCE, [current.header], generationLoader)
    pending.resolve(observation([current]))

    await expect(transcript).resolves.toMatchObject([{ header: { id: 'message-a' } }])
    await expect(generation).resolves.toMatchObject([{ header: { id: 'message-a' } }])
    expect(transcriptLoader).toHaveBeenCalledOnce()
    expect(generationLoader).not.toHaveBeenCalled()
    expectAtMostOnePhysicalReadPerIdentity(requests)
  })

  it('hands settled reserved transcript material to a prompt lease without a second load', async () => {
    const current = presentation('message-a')
    const coordinator = createWorkspaceMessageMaterialCoordinator(WORKSPACE_FENCE)
    const reservation = coordinator.reserve(WORKSPACE_FENCE, [current.header])
    const transcriptLoader = vi.fn<GenerationPromptMaterialLoader>(async () =>
      observation([current]),
    )

    await coordinator.read(WORKSPACE_FENCE, [current.header], transcriptLoader)
    const lease = coordinator.acquirePrompt(CHAT_ID, [current.header])
    lease.seal(WORKSPACE_FENCE, prompt([current.header]))
    reservation.release()
    const generationLoader = vi.fn<GenerationPromptMaterialLoader>(async () =>
      observation([current]),
    )

    await expect(
      lease.read(WORKSPACE_FENCE, [current.header], generationLoader),
    ).resolves.toMatchObject([{ header: { id: 'message-a' } }])
    expect(transcriptLoader).toHaveBeenCalledOnce()
    expect(generationLoader).not.toHaveBeenCalled()

    lease.release()
    const afterReleaseLoader = vi.fn<GenerationPromptMaterialLoader>(async () =>
      observation([current]),
    )
    await coordinator.read(WORKSPACE_FENCE, [current.header], afterReleaseLoader)
    expect(afterReleaseLoader).toHaveBeenCalledOnce()
  })

  it('lets a generation-first material read and transcript join one physical load', async () => {
    const current = presentation('message-a')
    const { coordinator, lease } = sealedCoordinatorLease([current.header])
    const pending = deferred<GenerationPromptMaterialObservation>()
    const requests: MessageHeaderRow[][] = []
    const generationLoader = vi.fn<GenerationPromptMaterialLoader>((headers) => {
      requests.push([...headers])
      return pending.promise
    })
    const transcriptLoader = vi.fn<GenerationPromptMaterialLoader>(async (headers) =>
      observation(headers.map(presentationForHeader)),
    )

    const generation = lease.read(WORKSPACE_FENCE, [current.header], generationLoader)
    await Promise.resolve()
    const transcript = coordinator.read(WORKSPACE_FENCE, [current.header], transcriptLoader)
    pending.resolve(observation([current]))

    await expect(generation).resolves.toMatchObject([{ header: { id: 'message-a' } }])
    await expect(transcript).resolves.toMatchObject([{ header: { id: 'message-a' } }])
    expect(requests).toHaveLength(1)
    expect(transcriptLoader).not.toHaveBeenCalled()
    expectAtMostOnePhysicalReadPerIdentity(requests)
  })

  it('retains completed generation material for a later transcript while its lease is active', async () => {
    const current = presentation('message-a')
    const { coordinator, lease } = sealedCoordinatorLease([current.header])
    const requests: MessageHeaderRow[][] = []
    const generationLoader = recordingLoader(requests)
    const transcriptLoader = vi.fn<GenerationPromptMaterialLoader>(async (headers) =>
      observation(headers.map(presentationForHeader)),
    )

    await lease.read(WORKSPACE_FENCE, [current.header], generationLoader)
    await expect(
      coordinator.read(WORKSPACE_FENCE, [current.header], transcriptLoader),
    ).resolves.toMatchObject([{ header: { id: 'message-a' } }])

    expect(requests).toHaveLength(1)
    expect(transcriptLoader).not.toHaveBeenCalled()
    expectAtMostOnePhysicalReadPerIdentity(requests)
  })

  it('retains a completed tail when a later generation read expands to the full path', async () => {
    const headers = Array.from(
      { length: 14 },
      (_, index) => presentation(`message-${index}`).header,
    )
    const lease = createGenerationPromptMaterialLease(WORKSPACE_FENCE, CHAT_ID, [])
    lease.seal(WORKSPACE_FENCE, prompt(headers))
    const requests: MessageHeaderRow[][] = []
    const loader = recordingLoader(requests)

    await lease.read(WORKSPACE_FENCE, headers.slice(-8), loader)
    await lease.read(WORKSPACE_FENCE, headers, loader)

    expect(requests.map(messageIds)).toEqual([
      headers.slice(-8).map((header) => header.id),
      headers.slice(0, 6).map((header) => header.id),
    ])
    expectAtMostOnePhysicalReadPerIdentity(requests)
  })

  it('shares an overlapping prefix while loading a disjoint transcript suffix once', async () => {
    const headers = ['message-a', 'message-b', 'message-c'].map((id) => presentation(id).header)
    const { coordinator, lease } = sealedCoordinatorLease(headers)
    const pending = deferred<GenerationPromptMaterialObservation>()
    const requests: MessageHeaderRow[][] = []
    const generationLoader = vi.fn<GenerationPromptMaterialLoader>((requested) => {
      requests.push([...requested])
      return pending.promise
    })
    const transcriptLoader = vi.fn<GenerationPromptMaterialLoader>(async (requested) => {
      requests.push([...requested])
      return observation(requested.map(presentationForHeader))
    })

    const generation = lease.read(WORKSPACE_FENCE, headers.slice(0, 2), generationLoader)
    await Promise.resolve()
    const transcript = coordinator.read(WORKSPACE_FENCE, headers.slice(1), transcriptLoader)
    pending.resolve(observation(headers.slice(0, 2).map(presentationForHeader)))

    await expect(generation).resolves.toMatchObject([
      { header: { id: 'message-a' } },
      { header: { id: 'message-b' } },
    ])
    await expect(transcript).resolves.toMatchObject([
      { header: { id: 'message-b' } },
      { header: { id: 'message-c' } },
    ])
    expect(requests.map(messageIds)).toEqual([['message-a', 'message-b'], ['message-c']])
    expectAtMostOnePhysicalReadPerIdentity(requests)
  })

  it('binds every material operation to one workspace replacement epoch', async () => {
    const current = presentation('message-a')
    const replacement = Object.freeze({
      workspaceId: WORKSPACE_FENCE.workspaceId,
      replacementEpoch: WORKSPACE_FENCE.replacementEpoch + 1,
    })
    const lease = createGenerationPromptMaterialLease(WORKSPACE_FENCE, CHAT_ID, [current.header])
    expect(() => lease.seed(replacement, [current])).toThrow(
      'WorkspaceMessageMaterialFenceMismatch',
    )
    expect(() => lease.seal(replacement, prompt([current.header]))).toThrow(
      'GenerationPromptMaterialSealMismatch',
    )
    lease.seal(WORKSPACE_FENCE, prompt([current.header]))

    expect(lease.covers(replacement, [current.header])).toBe(false)
    await expect(
      lease.read(replacement, [current.header], async () => observation([current], replacement)),
    ).rejects.toThrow('GenerationPromptMaterialLeaseMismatch')
  })

  it('does not retain material that no active prompt lease claims', async () => {
    const claimed = presentation('message-a')
    const disjoint = presentation('message-b')
    const coordinator = createWorkspaceMessageMaterialCoordinator(WORKSPACE_FENCE)
    const claimedLease = coordinator.acquirePrompt(CHAT_ID, [claimed.header])
    claimedLease.seal(WORKSPACE_FENCE, prompt([claimed.header]))
    const firstLoader = vi.fn<GenerationPromptMaterialLoader>(async () => observation([disjoint]))

    await coordinator.read(WORKSPACE_FENCE, [disjoint.header], firstLoader)
    const disjointLease = coordinator.acquirePrompt(CHAT_ID, [disjoint.header])
    disjointLease.seal(WORKSPACE_FENCE, prompt([disjoint.header]))
    const secondLoader = vi.fn<GenerationPromptMaterialLoader>(async () => observation([disjoint]))

    await disjointLease.read(WORKSPACE_FENCE, [disjoint.header], secondLoader)

    expect(firstLoader).toHaveBeenCalledOnce()
    expect(secondLoader).toHaveBeenCalledOnce()
  })

  it('never reuses material across workspace replacement epochs', async () => {
    const current = presentation('message-a')
    const replacement = Object.freeze({
      workspaceId: WORKSPACE_FENCE.workspaceId,
      replacementEpoch: WORKSPACE_FENCE.replacementEpoch + 1,
    })
    const original = createWorkspaceMessageMaterialCoordinator(WORKSPACE_FENCE)
    const originalLease = original.acquirePrompt(CHAT_ID, [current.header])
    originalLease.seal(WORKSPACE_FENCE, prompt([current.header]))
    const originalLoader = vi.fn<GenerationPromptMaterialLoader>(async () => observation([current]))
    await originalLease.read(WORKSPACE_FENCE, [current.header], originalLoader)
    const mismatchLoader = vi.fn<GenerationPromptMaterialLoader>(async () =>
      observation([current], replacement),
    )

    await expect(original.read(replacement, [current.header], mismatchLoader)).rejects.toThrow(
      'WorkspaceMessageMaterialFenceMismatch',
    )
    expect(mismatchLoader).not.toHaveBeenCalled()

    const replacementCoordinator = createWorkspaceMessageMaterialCoordinator(replacement)
    const replacementLoader = vi.fn<GenerationPromptMaterialLoader>(async () =>
      observation([current], replacement),
    )
    await replacementCoordinator.read(replacement, [current.header], replacementLoader)

    expect(originalLoader).toHaveBeenCalledOnce()
    expect(replacementLoader).toHaveBeenCalledOnce()
  })

  it('lets one reader abort without cancelling a shared physical material load', async () => {
    const current = presentation('message-a')
    const { coordinator, lease } = sealedCoordinatorLease([current.header])
    const pending = deferred<GenerationPromptMaterialObservation>()
    let physicalSignal: AbortSignal | undefined
    const loader = vi.fn<GenerationPromptMaterialLoader>((_headers, signal) => {
      physicalSignal = signal
      return pending.promise
    })
    const firstAbort = new AbortController()

    const first = coordinator.read(WORKSPACE_FENCE, [current.header], loader, firstAbort.signal)
    await Promise.resolve()
    const second = lease.read(WORKSPACE_FENCE, [current.header], loader)
    firstAbort.abort(new Error('reader-cancelled'))
    expect(physicalSignal?.aborted).toBe(false)
    pending.resolve(observation([current]))

    await expect(first).rejects.toThrow('reader-cancelled')
    await expect(second).resolves.toMatchObject([{ header: { id: 'message-a' } }])
    expect(loader).toHaveBeenCalledOnce()
  })

  it('bounds loader pages by 16 rows and 256k text characters without splitting an oversized row', async () => {
    const headers = [
      ...Array.from({ length: 17 }, (_, index) => headerWithTextChars(`small-${index}`, 1)),
      headerWithTextChars('oversized', 256_001),
      headerWithTextChars('bounded-a', 128_000),
      headerWithTextChars('bounded-b', 128_000),
    ]
    const lease = sealedLease(headers)
    const requests: MessageHeaderRow[][] = []
    const loaderImplementation: GenerationPromptMaterialLoader = async (requested) => {
      requests.push([...requested])
      return observation(requested.map(presentationForHeader))
    }
    const loader = vi.fn(loaderImplementation)

    await lease.read(WORKSPACE_FENCE, headers, loader)

    expect(requests.map((request) => request.length)).toEqual([16, 1, 1, 2])
    expect(requests.flatMap(messageIds)).toEqual(messageIds(headers))
    expectAtMostOnePhysicalReadPerIdentity(requests)
    for (const request of requests) {
      const characters = request.reduce((sum, header) => sum + header.bodyTextCharCount, 0)
      expect(
        characters <= 256_000 ||
          (request.length === 1 && (request[0]?.bodyTextCharCount ?? 0) > 256_000),
      ).toBe(true)
    }
  })

  it.each([
    {
      mismatch: 'body version',
      canonical: { bodyVersion: 2 },
    },
    {
      mismatch: 'request-context version',
      canonical: { requestContextVersion: 2 },
    },
    {
      mismatch: 'tree structure',
      canonical: { parentId: 'different-parent' },
    },
  ])('does not reuse seeded material with a mismatched $mismatch after seal', async ({
    canonical,
  }) => {
    const stale = presentation('message-a')
    const current = presentation('message-a', canonical)
    const lease = createGenerationPromptMaterialLease(WORKSPACE_FENCE, CHAT_ID, [stale.header])
    lease.seed(WORKSPACE_FENCE, [stale])
    lease.seal(WORKSPACE_FENCE, prompt([current.header]))
    const loader = vi.fn<GenerationPromptMaterialLoader>(async (headers) =>
      observation(headers.map(presentationForHeader)),
    )

    const result = await lease.read(WORKSPACE_FENCE, [current.header], loader)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(result[0]?.header).toEqual(current.header)
  })

  it('lets an active reader finish after lease release and drops its retained material', async () => {
    const current = presentation('message-a')
    const onRelease = vi.fn()
    const coordinator = createWorkspaceMessageMaterialCoordinator(WORKSPACE_FENCE)
    const lease = coordinator.acquirePrompt(CHAT_ID, [current.header], onRelease)
    lease.seal(WORKSPACE_FENCE, prompt([current.header]))
    const pending = deferred<GenerationPromptMaterialObservation>()
    const loader = vi.fn<GenerationPromptMaterialLoader>(() => pending.promise)

    const activeRead = lease.read(WORKSPACE_FENCE, [current.header], loader)
    await Promise.resolve()

    lease.release()

    expect(onRelease).toHaveBeenCalledOnce()
    pending.resolve(observation([current]))

    await expect(activeRead).resolves.toMatchObject([{ header: { id: 'message-a' } }])
    await expect(lease.read(WORKSPACE_FENCE, [current.header], loader)).rejects.toThrow(
      'GenerationPromptMaterialLeaseMismatch',
    )

    await Promise.resolve()
    const laterLoader = vi.fn<GenerationPromptMaterialLoader>(async () => observation([current]))
    await coordinator.read(WORKSPACE_FENCE, [current.header], laterLoader)
    expect(laterLoader).toHaveBeenCalledOnce()
  })

  it('drops failed in-flight loader state so an immediate retry can succeed', async () => {
    const current = presentation('message-a')
    const lease = sealedLease([current.header])
    let attempt = 0
    const loader = vi.fn<GenerationPromptMaterialLoader>(async (headers) => {
      attempt += 1
      if (attempt === 1) throw new Error('loader failed')
      return observation(headers.map(presentationForHeader))
    })

    await expect(lease.read(WORKSPACE_FENCE, [current.header], loader)).rejects.toThrow(
      'loader failed',
    )
    await Promise.resolve()

    await expect(lease.read(WORKSPACE_FENCE, [current.header], loader)).resolves.toMatchObject([
      { header: { id: 'message-a' } },
    ])
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

function sealedLease(
  headers: readonly MessageHeaderRow[],
  onRelease: (lease: GenerationPromptMaterialLease) => void = () => undefined,
): GenerationPromptMaterialLease {
  const lease = createGenerationPromptMaterialLease(WORKSPACE_FENCE, CHAT_ID, headers, onRelease)
  lease.seal(WORKSPACE_FENCE, prompt(headers))
  return lease
}

function sealedCoordinatorLease(headers: readonly MessageHeaderRow[]): {
  coordinator: WorkspaceMessageMaterialCoordinator
  lease: GenerationPromptMaterialLease
} {
  const coordinator = createWorkspaceMessageMaterialCoordinator(WORKSPACE_FENCE)
  const lease = coordinator.acquirePrompt(CHAT_ID, headers)
  lease.seal(WORKSPACE_FENCE, prompt(headers))
  return { coordinator, lease }
}

function prompt(headers: readonly MessageHeaderRow[]): PreparedGenerationPrompt {
  return {
    leafId: headers.at(-1)?.id ?? null,
    headers,
    messageProofs: headers.map(generationMessageReadProofFromHeader),
    knownPresentations: [],
  }
}

function presentation(
  id: string,
  options: {
    bodyVersion?: number
    requestContextVersion?: number
    parentId?: string | null
  } = {},
): MessagePresentation {
  const row = message(id, options.parentId ?? null)
  const { header } = splitMessageForStorage(row, {
    bodyVersion: options.bodyVersion ?? 1,
    requestContextVersion: options.requestContextVersion ?? 1,
  })
  return { header, message: row, bodyVersion: header.bodyVersion }
}

function headerWithTextChars(id: string, bodyTextCharCount: number): MessageHeaderRow {
  const source = presentation(id).header
  return { ...source, bodyTextCharCount }
}

function presentationForHeader(header: MessageHeaderRow): MessagePresentation {
  return {
    header,
    message: messageFromHeader(header),
    bodyVersion: header.bodyVersion,
  }
}

function observation(
  material: readonly (MessagePresentation | undefined)[],
  fence: WorkspaceFence = WORKSPACE_FENCE,
): GenerationPromptMaterialObservation {
  return { ...fence, material }
}

function recordingLoader(requests: MessageHeaderRow[][]): GenerationPromptMaterialLoader {
  return async (headers) => {
    requests.push([...headers])
    return observation(headers.map(presentationForHeader))
  }
}

function expectAtMostOnePhysicalReadPerIdentity(requests: readonly MessageHeaderRow[][]): void {
  const counts = new Map<string, number>()
  for (const header of requests.flat()) {
    const identity = materialIdentity(header)
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  expect([...counts.values()].every((count) => count <= 1)).toBe(true)
}

function materialIdentity(header: MessageHeaderRow): string {
  return JSON.stringify([
    header.id,
    header.chatId,
    header.parentId,
    header.role,
    header.deleted,
    header.requestContextVersion,
    header.bodyVersion,
  ])
}

function message(id: string, parentId: string | null): Message {
  return {
    id,
    chatId: CHAT_ID,
    parentId,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: `body-${id}` }],
    nodeVersion: 1,
    deleted: false,
  }
}

function messageFromHeader(header: MessageHeaderRow): Message {
  return {
    id: header.id,
    chatId: header.chatId,
    parentId: header.parentId,
    siblingIndex: header.siblingIndex,
    turnId: header.turnId,
    turnIndex: header.turnIndex,
    createdAt: header.createdAt,
    role: header.role,
    origin: header.origin,
    content: [{ type: header.role === 'assistant' ? 'output_text' : 'text', text: header.id }],
    nodeVersion: header.nodeVersion,
    deleted: header.deleted,
  }
}

function messageIds(headers: readonly MessageHeaderRow[]): string[] {
  return headers.map((header) => header.id)
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
