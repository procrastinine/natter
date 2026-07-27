import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatRow } from '../../src/core/chat-metadata'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import {
  __resetWorkspaceEffectHubForTests,
  subscribeWorkspaceEffects,
  WORKSPACE_EFFECT_RECOVERY_OWNED,
  type WorkspaceEffect,
} from '../../src/store/workspace-effect-hub'
import type {
  CommitEnvelope,
  WorkspaceCommand,
  WorkspaceRepository,
  WorkspaceWriteAuthority,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'

const AUTHORITY = {} as WorkspaceWriteAuthority

let posted: unknown[]

beforeEach(() => {
  posted = []
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      addEventListener() {}
      close() {}
      postMessage(value: unknown) {
        posted.push(value)
      }
    },
  )
  __resetWorkspaceEffectHubForTests()
  __resetBroadcastForTests({ admissionsOpen: true })
  __resetWorkspaceRepositoryForTests()
})

afterEach(() => {
  __resetWorkspaceEffectHubForTests()
  __resetWorkspaceRepositoryForTests()
  __resetBroadcastForTests({ admissionsOpen: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('workspace local commit delivery', () => {
  it('keeps the browser backend, raw change source, and local delivery behind one gateway each', () => {
    expect(filesContaining('getBrowserRepository')).toEqual(['main.tsx', 'store/browser-repo.ts'])
    expect(readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8')).toContain(
      'installWorkspaceRepositoryFactory(getBrowserRepository)',
    )
    expect(filesContaining('attachedRepository.subscribeChanges')).toEqual([
      'store/workspace-effect-hub.ts',
    ])
    expect(filesMatching(/function deliverLocalCommit</u)).toEqual([
      'store/workspace-repository.ts',
    ])
  })

  it('applies the originating conversation claim, publishes the shared effect, then resolves', async () => {
    const commit = envelope({ value: { marker: 'final body' } })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const order: string[] = []
    let installed: unknown = null
    const unsubscribeEffect = subscribeWorkspaceEffects({
      owner: 'delivery-order-test',
      replacements: false,
      impactKinds: ['chat'],
      apply: () => order.push('effect'),
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })
    const unsubscribeCompact = subscribeWorkspaceChanges(() => order.push('compact'))

    await getWorkspaceRepository().execute(AUTHORITY, command(), {
      localApplications: {
        conversation: (delivered) => {
          order.push('claim')
          installed = delivered.value
          return 'applied'
        },
      },
    })
    order.push('resolved')

    expect(installed).toEqual({ marker: 'final body' })
    expect(order).toEqual(['claim', 'effect', 'compact', 'resolved'])
    expect(posted).toHaveLength(1)
    expect(posted[0]).not.toHaveProperty('receipt')
    expect(posted[0]).not.toHaveProperty('value')

    unsubscribeCompact()
    unsubscribeEffect()
  })

  it('routes committed effects by facts rather than command identity', async () => {
    const commit = envelope()
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const received = vi.fn()
    const unsubscribe = subscribeWorkspaceEffects({
      owner: 'operation-neutral-test',
      replacements: false,
      impactKinds: ['chat'],
      apply: received,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })

    await getWorkspaceRepository().execute(AUTHORITY, {
      kind: 'attachment.bundle.write',
      input: {},
    } as WorkspaceCommand)

    expect(received).toHaveBeenCalledTimes(1)
    expect(received.mock.calls[0]?.[0]).toMatchObject({
      kind: 'changed',
      source: 'local',
      cause: 'commit',
    })
    unsubscribe()
  })

  it('accepts a chat receipt without fabricating an unchanged sidebar fact', async () => {
    const commit = envelope({
      receipt: {
        chats: [createChatRow({ id: 'chat-a', now: 1 })],
        constructions: [],
        messageRevisions: [],
        childSlots: [],
      },
    })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const effect = vi.fn()
    const unsubscribe = subscribeWorkspaceEffects({
      owner: 'chat-receipt-test',
      replacements: false,
      impactKinds: ['chat'],
      apply: effect,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })

    await expect(getWorkspaceRepository().execute(AUTHORITY, command())).resolves.toBe(commit)

    expect(diagnostic).not.toHaveBeenCalled()
    expect(effect).toHaveBeenCalledOnce()
    expect(effect.mock.calls[0]?.[0]).toMatchObject({
      kind: 'changed',
      cause: 'commit',
    })
    unsubscribe()
  })

  it('rejects a sidebar fact without its final chat receipt', async () => {
    const commit = envelope({
      delta: {
        facts: [{ kind: 'sidebar-row-changed', chatId: 'chat-a' }],
        invalidations: [{ kind: 'sidebar', chatIds: ['chat-a'] }],
      },
    })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(getWorkspaceRepository().execute(AUTHORITY, command())).resolves.toBe(commit)

    expect(diagnostic).toHaveBeenCalledWith(
      'Workspace local commit projection failed',
      expect.objectContaining({ owner: 'evidence', commandKind: 'chat.set-manual-title' }),
    )
  })

  it('routes a terminal target fact and its exact body dependency to separate owners', async () => {
    const commit = envelope({
      delta: {
        facts: [
          {
            kind: 'attempt-target-committed',
            streamId: 'stream-a',
            chatId: 'chat-a',
            messageId: 'message-a',
            attemptKind: 'generation',
            admissionSequence: 4,
            leaseRevision: 7,
            bodyVersion: 3,
          },
        ],
        invalidations: [],
      },
    })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const attemptOwner = vi.fn<(effect: WorkspaceEffect) => void>()
    const conversationOwner = vi.fn<(effect: WorkspaceEffect) => void>()
    const unsubscribeAttempt = subscribeWorkspaceEffects({
      owner: 'attempt-target-commit-test',
      replacements: false,
      factKinds: ['attempt-target-committed'],
      apply: attemptOwner,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })
    const unsubscribeConversation = subscribeWorkspaceEffects({
      owner: 'attempt-target-body-test',
      replacements: false,
      impactKinds: ['message-body'],
      apply: conversationOwner,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })

    await getWorkspaceRepository().execute(AUTHORITY, command())

    expect(attemptOwner).toHaveBeenCalledOnce()
    const attemptEffect = attemptOwner.mock.calls[0]?.[0]
    if (attemptEffect?.kind !== 'changed') throw new Error('ExpectedChangedAttemptEffect')
    expect(attemptEffect.factsByKind['attempt-target-committed']).toEqual(commit.delta.facts)
    expect(conversationOwner).toHaveBeenCalledOnce()
    const conversationEffect = conversationOwner.mock.calls[0]?.[0]
    if (conversationEffect?.kind !== 'changed') {
      throw new Error('ExpectedChangedConversationEffect')
    }
    if (conversationEffect.impactByKind === 'all') {
      throw new Error('ExpectedScopedConversationImpact')
    }
    expect(conversationEffect.impactByKind['message-body']).toEqual([
      { kind: 'message-body', chatId: 'chat-a', messageIds: ['message-a'] },
    ])
    unsubscribeConversation()
    unsubscribeAttempt()
  })

  it('suppresses stream-chunk-only commits from local and transport fanout', async () => {
    const commit = envelope({
      delta: {
        facts: [],
        invalidations: [{ kind: 'stream-chunks', chatId: 'chat-a', streamIds: ['stream-a'] }],
      },
    })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const exact = vi.fn()
    const compact = vi.fn()
    const unsubscribeExact = subscribeWorkspaceEffects({
      owner: 'stream-chunk-test',
      replacements: false,
      impactKinds: ['stream-chunks'],
      apply: exact,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })
    const unsubscribeCompact = subscribeWorkspaceChanges(compact)

    await getWorkspaceRepository().execute(AUTHORITY, {
      kind: 'stream.append-journal-frames',
      frames: [],
      observedAt: 0,
    })

    expect(exact).not.toHaveBeenCalled()
    expect(compact).not.toHaveBeenCalled()
    expect(posted).toEqual([])
    unsubscribeCompact()
    unsubscribeExact()
  })

  it('keeps no-effect command commits outside projection, recovery, and transport', async () => {
    const commit = envelope({
      effectScope: 'none',
      delta: { facts: [], invalidations: [] },
    })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const effect = vi.fn()
    const compact = vi.fn()
    const application = vi.fn(() => 'applied' as const)
    const unsubscribeEffect = subscribeWorkspaceEffects({
      owner: 'no-effect-test',
      replacements: false,
      impactKinds: ['chat'],
      apply: effect,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })
    const unsubscribeCompact = subscribeWorkspaceChanges(compact)

    await expect(
      getWorkspaceRepository().execute(AUTHORITY, command(), {
        localApplications: { conversation: application },
      }),
    ).resolves.toBe(commit)

    expect(application).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
    expect(compact).not.toHaveBeenCalled()
    expect(posted).toEqual([])
    unsubscribeCompact()
    unsubscribeEffect()
  })

  it('does not turn malformed no-effect evidence into a broad recovery loop', async () => {
    const commit = envelope({ effectScope: 'none' })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const effect = vi.fn()
    const unsubscribe = subscribeWorkspaceEffects({
      owner: 'no-effect-recovery-test',
      replacements: false,
      impactKinds: ['workspace'],
      apply: effect,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })

    await expect(getWorkspaceRepository().execute(AUTHORITY, command())).resolves.toBe(commit)

    expect(diagnostic).toHaveBeenCalledWith(
      'Workspace local commit projection failed',
      expect.objectContaining({ owner: 'evidence', commandKind: 'chat.set-manual-title' }),
    )
    expect(effect).not.toHaveBeenCalled()
    expect(posted).toEqual([])
    unsubscribe()
  })

  it('broad-recovers a declared workspace effect whose evidence is missing', async () => {
    const commit = envelope({ delta: { facts: [], invalidations: [] } })
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const effect = vi.fn()
    const compact = vi.fn()
    const unsubscribeEffect = subscribeWorkspaceEffects({
      owner: 'workspace-evidence-recovery-test',
      replacements: false,
      impactKinds: ['workspace'],
      apply: effect,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })
    const unsubscribeCompact = subscribeWorkspaceChanges(compact)

    await expect(getWorkspaceRepository().execute(AUTHORITY, command())).resolves.toBe(commit)

    expect(diagnostic).toHaveBeenCalledWith(
      'Workspace local commit projection failed',
      expect.objectContaining({ owner: 'evidence', commandKind: 'chat.set-manual-title' }),
    )
    expect(effect).toHaveBeenCalledTimes(1)
    expect(effect.mock.calls[0]?.[0]).toMatchObject({
      kind: 'changed',
      cause: 'invalidation',
      impact: 'all',
    })
    expect(compact).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(1)
    unsubscribeCompact()
    unsubscribeEffect()
  })

  it('recovers a failed originating conversation claim without rejecting durable success', async () => {
    const commit = envelope()
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const recovered = vi.fn(
      (_error: unknown, _effect: WorkspaceEffect) => WORKSPACE_EFFECT_RECOVERY_OWNED,
    )
    const later = vi.fn()
    const unsubscribeConversation = subscribeWorkspaceEffects({
      owner: 'conversation-recovery-test',
      group: 'conversation',
      replacements: false,
      impactKinds: ['chat'],
      apply: vi.fn(),
      recover: (error, effect) => {
        recovered(error, effect)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
    const unsubscribeLater = subscribeWorkspaceEffects({
      owner: 'later-delivery-test',
      replacements: false,
      impactKinds: ['chat'],
      apply: later,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })

    await expect(
      getWorkspaceRepository().execute(AUTHORITY, command(), {
        localApplications: {
          conversation: () => {
            throw new Error('projection exploded')
          },
        },
      }),
    ).resolves.toBe(commit)

    expect(recovered).toHaveBeenCalledTimes(1)
    expect(later).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(1)
    expect(diagnostic).toHaveBeenCalledWith(
      'Workspace local commit projection failed',
      expect.objectContaining({ owner: 'conversation', commandKind: 'chat.set-manual-title' }),
    )
    unsubscribeLater()
    unsubscribeConversation()
  })

  it('isolates a subscriber failure and still delivers to later owners', async () => {
    const commit = envelope()
    __setWorkspaceRepositoryForTests(fakeRepository(commit))
    const recovered = vi.fn(
      (_error: unknown, _effect: WorkspaceEffect) => WORKSPACE_EFFECT_RECOVERY_OWNED,
    )
    const later = vi.fn()
    const unsubscribeFailed = subscribeWorkspaceEffects({
      owner: 'failed-effect-test',
      replacements: false,
      impactKinds: ['chat'],
      apply: () => {
        throw new Error('effect failed')
      },
      recover: (error, effect) => {
        recovered(error, effect)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
    const unsubscribeLater = subscribeWorkspaceEffects({
      owner: 'later-effect-test',
      replacements: false,
      impactKinds: ['chat'],
      apply: later,
      recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
    })

    await expect(getWorkspaceRepository().execute(AUTHORITY, command())).resolves.toBe(commit)

    expect(recovered).toHaveBeenCalledTimes(1)
    expect(later).toHaveBeenCalledTimes(1)
    expect(posted).toHaveLength(1)
    unsubscribeLater()
    unsubscribeFailed()
  })
})

function command(): WorkspaceCommand {
  return {
    kind: 'chat.set-manual-title',
    chatId: 'chat-a',
    title: 'committed',
    now: 1,
  }
}

function envelope(
  input: {
    readonly value?: unknown
    readonly effectScope?: CommitEnvelope<unknown>['effectScope']
    readonly delta?: CommitEnvelope<unknown>['delta']
    readonly receipt?: CommitEnvelope<unknown>['receipt']
  } = {},
): CommitEnvelope<unknown> {
  return {
    workspaceId: 'workspace-a',
    replacementEpoch: 0,
    commitId: 'commit-a',
    effectScope: input.effectScope ?? 'workspace',
    value: input.value,
    receipt: input.receipt ?? {
      chats: [],
      constructions: [],
      messageRevisions: [],
      childSlots: [],
    },
    delta: input.delta ?? {
      facts: [],
      invalidations: [{ kind: 'chat', chatIds: ['chat-a'] }],
    },
  }
}

function fakeRepository(commit: CommitEnvelope<unknown>): WorkspaceRepository {
  return {
    query: vi.fn(),
    execute: vi.fn(async () => commit),
    replace: vi.fn(),
    subscribeChanges: vi.fn(() => () => {}),
  } as unknown as WorkspaceRepository
}

function filesContaining(fragment: string): string[] {
  return sourceFiles(join(process.cwd(), 'src'))
    .filter((file) => readFileSync(file, 'utf8').includes(fragment))
    .map(relativeSourcePath)
    .sort()
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(join(process.cwd(), 'src'))
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map(relativeSourcePath)
    .sort()
}

function relativeSourcePath(file: string): string {
  return relative(join(process.cwd(), 'src'), file).split(sep).join('/')
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path))
    else if (path.endsWith('.ts') || path.endsWith('.tsx')) files.push(path)
  }
  return files
}
