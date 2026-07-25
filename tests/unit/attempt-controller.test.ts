import { describe, expect, it, vi } from 'vitest'
import {
  type AttemptController,
  type AttemptExecutionPhase,
  attemptStopCapability,
  createAttemptController,
  mostRecentlyAdmittedAttempt,
} from '../../src/store/attempt-controller'
import type { StreamLeaseRow, WriterStreamLeaseRow } from '../../src/store/repository'
import { type TestGenerationLeaseInput, testGenerationLease } from '../helpers/stream-leases'

const FENCE = Object.freeze({ workspaceId: 'workspace-a', replacementEpoch: 0 })

function lease(
  streamId: string,
  messageId: string,
  input: TestGenerationLeaseInput = {},
): StreamLeaseRow {
  return testGenerationLease({
    streamId,
    chatId: 'chat-a',
    messageId,
    ownerClientId: 'tab-a',
    fenceToken: `fence-${streamId}`,
    replacementEpoch: 0,
    startedAt: 1,
    heartbeatAt: 1,
    admissionSequence: 1,
    revision: 1,
    targetCommittedAt: 1,
    ...input,
  })
}

function observe(
  controller: AttemptController,
  row: StreamLeaseRow,
  options: {
    readonly local: boolean
    readonly workspaceId: string
    readonly phase?: AttemptExecutionPhase
  },
) {
  return controller.observeLease(row, {
    workspaceId: options.workspaceId,
    localAuthority: options.local
      ? {
          kind: 'writer',
          workspaceId: options.workspaceId,
          lease: row as WriterStreamLeaseRow,
        }
      : { kind: 'none' },
    ownershipLock: options.local
      ? { kind: 'unobserved' }
      : { kind: 'held-by-other', streamId: row.streamId, observedAt: 1 },
    ...(options.phase ? { phase: options.phase } : {}),
  })
}

function projection(streamId: string, messageId: string, text: string) {
  return {
    attemptKind: 'generation' as const,
    streamId,
    chatId: 'chat-a',
    messageId,
    workspaceId: FENCE.workspaceId,
    replacementEpoch: FENCE.replacementEpoch,
    content: [{ type: 'output_text' as const, text }],
    textLength: text.length,
    reasoningLength: 0,
    updatedAt: 2,
  }
}

describe('attempt controller', () => {
  it('publishes exact lease coverage before treating an empty target as available', () => {
    const controller = createAttemptController()
    controller.replaceWorkspace(FENCE)
    const listener = vi.fn()
    const stop = controller.subscribeChat('chat-a', listener)

    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('unknown')

    controller.reconcileChatLeases(FENCE, 'chat-a', [])
    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('available')

    stop()
    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('unknown')
  })

  it('releases admission frames after the final chat demand leaves', () => {
    const controller = createAttemptController()
    controller.replaceWorkspace(FENCE)

    for (let index = 0; index < 4_096; index += 1) {
      const chatId = `chat-${index}`
      const stop = controller.subscribeChat(chatId, () => {})
      controller.getTargetAdmissionFrame(chatId)
      stop()
    }

    const retained = controller as unknown as {
      targetAdmissionFrames: ReadonlyMap<string, unknown>
      dirtyTargetAdmissionFrames: ReadonlySet<string>
    }
    expect(retained.targetAdmissionFrames.size).toBe(0)
    expect(retained.dirtyTargetAdmissionFrames.size).toBe(0)
  })

  it('releases target admission at canonical commit while retaining cleanup metadata', () => {
    const controller = createAttemptController()
    controller.replaceWorkspace(FENCE)
    const stop = controller.subscribeChat('chat-a', () => {})
    const canonical = lease('cleanup', 'target', { phase: 'canonical', canonicalAt: 10 })

    controller.reconcileChatLeases(FENCE, 'chat-a', [canonical])
    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('available')
    expect(controller.getTargetAdmissionFrame('chat-a').admission('different-target')).toBe(
      'available',
    )

    controller.reconcileChatLeases(FENCE, 'chat-a', [
      lease('cleanup', 'target', {
        phase: 'metadata-committed',
        canonicalAt: 10,
        metadataCommittedAt: 11,
        revision: 2,
      }),
    ])
    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('available')
    stop()
  })

  it('claims an available target synchronously and releases exact claims only', () => {
    const controller = createAttemptController()
    controller.replaceWorkspace(FENCE)
    const stop = controller.subscribeChat('chat-a', () => {})
    controller.reconcileChatLeases(FENCE, 'chat-a', [])

    const first = controller.claimTarget(FENCE, 'chat-a', 'target', 'claim-1')
    expect(first).toBeDefined()
    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('occupied')
    expect(controller.claimTarget(FENCE, 'chat-a', 'target', 'claim-2')).toBeUndefined()
    expect(controller.claimTarget(FENCE, 'chat-a', 'different-target', 'claim-3')).toBeDefined()
    if (!first) throw new Error('ExpectedTargetClaim')
    expect(controller.releaseTargetClaim(first)).toBe(true)
    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('available')
    expect(controller.releaseTargetClaim(first)).toBe(false)

    controller.replaceWorkspace({ workspaceId: FENCE.workspaceId, replacementEpoch: 1 })
    expect(controller.getTargetAdmissionFrame('chat-a').admission('different-target')).toBe(
      'unknown',
    )
    stop()
  })

  it('indexes independent same-chat attempts by stream and exact target', () => {
    const controller = createAttemptController()
    observe(controller, lease('stream-1', 'message-1'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    observe(controller, lease('stream-2', 'message-2', { admissionSequence: 2 }), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })

    expect(controller.get('stream-1')?.messageId).toBe('message-1')
    expect(controller.get('stream-2')?.messageId).toBe('message-2')
    expect(controller.getTargetSnapshot('chat-a', 'message-1').execution?.streamId).toBe('stream-1')
    expect(controller.getTargetSnapshot('chat-a', 'message-2').execution?.streamId).toBe('stream-2')
    expect(controller.listChatExecutions('chat-a').map((attempt) => attempt.streamId)).toEqual([
      'stream-1',
      'stream-2',
    ])
  })

  it('selects a target by durable admission order even when observations arrive out of order', () => {
    const controller = createAttemptController()
    observe(
      controller,
      lease('newer', 'target', { admissionSequence: 12, revision: 3, startedAt: 1 }),
      { local: false, workspaceId: FENCE.workspaceId },
    )
    observe(
      controller,
      lease('older-late', 'target', {
        admissionSequence: 11,
        revision: 99,
        startedAt: 10_000,
      }),
      { local: false, workspaceId: FENCE.workspaceId },
    )

    expect(controller.getTargetSnapshot('chat-a', 'target').execution?.streamId).toBe('newer')
    expect(mostRecentlyAdmittedAttempt(controller.listChatExecutions('chat-a'))?.streamId).toBe(
      'newer',
    )
  })

  it.each([
    {
      phase: 'canonical' as const,
      terminal: { phase: 'canonical' as const, canonicalAt: 10 },
    },
    {
      phase: 'metadata-committed' as const,
      terminal: {
        phase: 'metadata-committed' as const,
        canonicalAt: 10,
        metadataCommittedAt: 11,
      },
    },
  ])('keeps $phase leases out of active target ownership', ({ terminal }) => {
    const controller = createAttemptController()
    const observed = observe(controller, lease('cleanup', 'target', terminal), {
      local: false,
      workspaceId: FENCE.workspaceId,
    })

    expect(observed).toBeUndefined()
    expect(controller.get('cleanup')).toBeUndefined()
    expect(controller.listChatExecutions('chat-a')).toEqual([])
    expect(controller.getTargetSnapshot('chat-a', 'target').execution).toBeUndefined()
    expect(controller.getTargetSnapshot('chat-a', 'target').presentation).toBeUndefined()
    expect(controller.isTargetExecuting('chat-a', 'target')).toBe(false)
    expect(controller.remove('cleanup', FENCE)).toBe(false)

    observe(controller, lease('current', 'target', { admissionSequence: 2, revision: 2 }), {
      local: false,
      workspaceId: FENCE.workspaceId,
    })

    expect(controller.getTargetSnapshot('chat-a', 'target').execution?.streamId).toBe('current')
  })

  it('retains the exact live target until the committed body version is published', () => {
    const controller = createAttemptController()
    const requestLiveProjection = vi.fn(async () => {})
    observe(controller, lease('stream', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    controller.setLiveProjectionRequester('stream', requestLiveProjection)
    const listener = vi.fn()
    const stop = controller.subscribeTarget('chat-a', 'target', listener)
    expect(controller.publishLiveProjection(projection('stream', 'target', 'partial'))).toBe(true)

    const decided = lease('stream', 'target', {
      phase: 'terminal-decided',
      revision: 2,
    })
    expect(
      observe(controller, decided, {
        local: true,
        workspaceId: FENCE.workspaceId,
      }),
    ).toMatchObject({ phase: 'finalizing' })
    expect(controller.getTargetSnapshot('chat-a', 'target').execution).toMatchObject({
      phase: 'finalizing',
    })
    expect(controller.getTargetSnapshot('chat-a', 'target').liveProjection).toMatchObject({
      streamId: 'stream',
      content: [{ type: 'output_text', text: 'partial' }],
    })

    const awaitingPresentation = observe(
      controller,
      lease('stream', 'target', {
        phase: 'canonical',
        canonicalAt: 10,
        revision: 3,
        postCommitFinal: { completionAllowed: true, expectedBodyVersion: 7 },
      }),
      { local: true, workspaceId: FENCE.workspaceId },
    )
    expect(awaitingPresentation).toMatchObject({
      phase: 'awaiting-presentation',
      targetCommitHandoff: { bodyVersion: 7 },
    })
    expect(controller.listChatExecutions('chat-a')).toEqual([])
    expect(controller.listRecords()).toEqual([awaitingPresentation])
    expect(attemptStopCapability(controller.getExecution('stream'))).toBeUndefined()
    expect(awaitingPresentation).not.toHaveProperty('requestLiveProjection')
    expect(controller.getTargetSnapshot('chat-a', 'target').liveProjection).toMatchObject({
      content: [{ type: 'output_text', text: 'partial' }],
    })

    controller.reconcileChatLeases(FENCE, 'chat-a', [
      lease('stream', 'target', {
        phase: 'metadata-committed',
        canonicalAt: 10,
        metadataCommittedAt: 11,
        revision: 4,
        postCommitFinal: { completionAllowed: true, expectedBodyVersion: 7 },
      }),
    ])
    expect(controller.getTargetAdmissionFrame('chat-a').admission('target')).toBe('available')
    expect(controller.getTargetSnapshot('chat-a', 'target').presentation).toMatchObject({
      streamId: 'stream',
      phase: 'awaiting-presentation',
    })

    controller.publishExactTargetPresentations([
      { ...FENCE, streamId: 'stream', chatId: 'chat-a', messageId: 'target', bodyVersion: 6 },
    ])
    expect(controller.get('stream')).toBeDefined()

    controller.publishExactTargetPresentations([
      { ...FENCE, streamId: 'stream', chatId: 'chat-a', messageId: 'target', bodyVersion: 7 },
    ])
    expect(controller.get('stream')).toBeUndefined()
    expect(controller.getTargetSnapshot('chat-a', 'target')).toEqual({
      execution: undefined,
      presentation: undefined,
      liveProjection: undefined,
    })
    expect(listener).toHaveBeenCalledTimes(5)
    stop()
  })

  it('keeps an older paint handoff alongside a newer execution on the same target', () => {
    const controller = createAttemptController()
    observe(controller, lease('old', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    const stop = controller.subscribeTarget('chat-a', 'target', () => {})
    expect(controller.publishLiveProjection(projection('old', 'target', 'old terminal'))).toBe(true)
    observe(
      controller,
      lease('old', 'target', {
        phase: 'canonical',
        canonicalAt: 10,
        revision: 3,
        postCommitFinal: { completionAllowed: true, expectedBodyVersion: 7 },
      }),
      { local: true, workspaceId: FENCE.workspaceId },
    )
    observe(
      controller,
      lease('new', 'target', { admissionSequence: 2, revision: 1, startedAt: 11 }),
      { local: true, workspaceId: FENCE.workspaceId },
    )

    expect(controller.getTargetSnapshot('chat-a', 'target')).toMatchObject({
      execution: { streamId: 'new' },
      presentation: { streamId: 'old', phase: 'awaiting-presentation' },
      liveProjection: { streamId: 'old' },
    })
    expect(controller.publishLiveProjection(projection('new', 'target', 'new live'))).toBe(true)
    expect(controller.getTargetSnapshot('chat-a', 'target').liveProjection?.streamId).toBe('new')

    controller.publishExactTargetPresentations([
      { ...FENCE, streamId: 'old', chatId: 'chat-a', messageId: 'target', bodyVersion: 7 },
    ])
    expect(controller.getTargetSnapshot('chat-a', 'target')).toMatchObject({
      execution: { streamId: 'new' },
      presentation: undefined,
      liveProjection: { streamId: 'new' },
    })
    stop()
  })

  it('retires immediately when the exact body was published before the handoff', () => {
    const controller = createAttemptController()
    observe(controller, lease('stream', 'target'), {
      local: false,
      workspaceId: FENCE.workspaceId,
    })
    const stop = controller.subscribeTarget('chat-a', 'target', () => {})

    controller.publishExactTargetPresentations([
      { ...FENCE, streamId: 'stream', chatId: 'chat-a', messageId: 'target', bodyVersion: 9 },
    ])
    const observed = observe(
      controller,
      lease('stream', 'target', {
        phase: 'canonical',
        canonicalAt: 10,
        revision: 3,
        postCommitFinal: { completionAllowed: true, expectedBodyVersion: 9 },
      }),
      { local: false, workspaceId: FENCE.workspaceId },
    )

    expect(observed).toBeUndefined()
    expect(controller.get('stream')).toBeUndefined()
    stop()
  })

  it('retires a pending handoff when exact target demand leaves', () => {
    const controller = createAttemptController()
    observe(controller, lease('stream', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    const stopTarget = controller.subscribeTarget('chat-a', 'target', () => {})
    const stopOther = controller.subscribeTarget('chat-a', 'other', () => {})
    observe(
      controller,
      lease('stream', 'target', {
        phase: 'canonical',
        canonicalAt: 10,
        revision: 3,
        postCommitFinal: { completionAllowed: true, expectedBodyVersion: 4 },
      }),
      { local: true, workspaceId: FENCE.workspaceId },
    )
    expect(controller.get('stream')).toMatchObject({ phase: 'awaiting-presentation' })

    stopTarget()
    expect(controller.get('stream')).toBeUndefined()
    stopOther()
  })

  it('retains live output only while the exact target is demanded', () => {
    const controller = createAttemptController()
    observe(controller, lease('stream', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })

    expect(controller.publishLiveProjection(projection('stream', 'target', 'cold'))).toBe(false)
    const unrelated = vi.fn()
    const target = vi.fn()
    const stopUnrelated = controller.subscribeTarget('chat-a', 'other', unrelated)
    const stopTarget = controller.subscribeTarget('chat-a', 'target', target)
    expect(controller.publishLiveProjection(projection('stream', 'target', 'live'))).toBe(true)
    expect(controller.getTargetSnapshot('chat-a', 'target').liveProjection?.content).toEqual([
      { type: 'output_text', text: 'live' },
    ])
    expect(target).toHaveBeenCalledOnce()
    expect(unrelated).not.toHaveBeenCalled()

    stopTarget()
    expect(controller.getTargetSnapshot('chat-a', 'target').liveProjection).toBeUndefined()
    stopUnrelated()
  })

  it('rejects stale and displaced live publishers without resurrecting output', () => {
    const controller = createAttemptController()
    observe(controller, lease('old', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    const stop = controller.subscribeTarget('chat-a', 'target', () => {})
    expect(controller.publishLiveProjection(projection('old', 'target', 'old'))).toBe(true)
    observe(controller, lease('new', 'target', { admissionSequence: 2, revision: 2 }), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })

    expect(controller.publishLiveProjection(projection('old', 'target', 'late'))).toBe(false)
    expect(controller.publishLiveProjection(projection('new', 'target', 'new'))).toBe(true)
    expect(controller.getTargetSnapshot('chat-a', 'target').liveProjection?.streamId).toBe('new')
    expect(controller.remove('old', FENCE)).toBe(true)
    expect(controller.getTargetSnapshot('chat-a', 'target').execution?.streamId).toBe('new')
    stop()
  })

  it('requests a local projection when exact demand arrives or a requester is installed', async () => {
    const controller = createAttemptController()
    const request = vi.fn(async () => {})
    observe(controller, lease('stream', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    controller.setLiveProjectionRequester('stream', request)
    expect(request).not.toHaveBeenCalled()

    const stop = controller.subscribeTarget('chat-a', 'target', () => {})
    await Promise.resolve()
    expect(request).toHaveBeenCalledOnce()
    const replacement = vi.fn(async () => {})
    controller.setLiveProjectionRequester('stream', replacement)
    await Promise.resolve()
    expect(replacement).toHaveBeenCalledOnce()
    stop()
  })

  it('publishes stable target and chat snapshots only to relevant subscribers', () => {
    const controller = createAttemptController()
    controller.replaceWorkspace(FENCE)
    const target = vi.fn()
    const unrelatedTarget = vi.fn()
    const chat = vi.fn()
    const stopTarget = controller.subscribeTarget('chat-a', 'target', target)
    const stopUnrelated = controller.subscribeTarget('chat-a', 'other', unrelatedTarget)
    const stopChat = controller.subscribeChat('chat-a', chat)
    const empty = controller.getTargetSnapshot('chat-a', 'target')

    observe(controller, lease('stream', 'target'), {
      local: false,
      workspaceId: FENCE.workspaceId,
    })
    const first = controller.getTargetSnapshot('chat-a', 'target')
    expect(first).not.toBe(empty)
    expect(controller.getTargetSnapshot('chat-a', 'target')).toBe(first)
    expect(target).toHaveBeenCalledOnce()
    expect(chat).toHaveBeenCalledOnce()
    expect(unrelatedTarget).not.toHaveBeenCalled()

    stopTarget()
    stopUnrelated()
    stopChat()
  })

  it('requires fresh ownership-lock evidence after a durable lease revision changes', () => {
    const controller = createAttemptController()
    const first = lease('remote', 'target', { ownerClientId: 'tab-b', revision: 1 })
    observe(controller, first, { local: false, workspaceId: FENCE.workspaceId })
    expect(controller.getExecution('remote')?.availability.presentation).toBe('remote-streaming')

    const renewed = lease('remote', 'target', {
      ownerClientId: 'tab-b',
      revision: 2,
      heartbeatAt: 2,
    })
    controller.observeLease(renewed, { workspaceId: FENCE.workspaceId })

    expect(controller.getExecution('remote')?.availability).toMatchObject({
      state: 'provisional',
      presentation: 'none',
      recovery: { kind: 'probe-lock' },
    })
  })

  it('reconciles point and chat snapshots without clearing unrelated attempts', () => {
    const controller = createAttemptController()
    const first = lease('first', 'message-1')
    const second = lease('second', 'message-2', { admissionSequence: 2 })
    controller.reconcileLeasePoints(FENCE, ['first', 'second'], [first, second])
    expect(controller.listRecords()).toHaveLength(2)

    controller.reconcileLeasePoints(FENCE, ['first'], [undefined])
    expect(controller.get('first')).toBeUndefined()
    expect(controller.get('second')).toBeDefined()

    controller.reconcileChatLeases(FENCE, 'chat-a', [first])
    expect(controller.get('first')).toBeDefined()
    expect(controller.get('second')).toBeUndefined()
  })

  it('prunes undemanded remote attempts while preserving every local attempt', () => {
    const controller = createAttemptController()
    observe(controller, lease('local', 'local-target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    observe(
      controller,
      lease('remote-a', 'remote-a-target', { ownerClientId: 'tab-b', admissionSequence: 2 }),
      { local: false, workspaceId: FENCE.workspaceId },
    )
    observe(
      controller,
      lease('remote-b', 'remote-b-target', {
        chatId: 'chat-b',
        ownerClientId: 'tab-b',
        admissionSequence: 3,
      }),
      { local: false, workspaceId: FENCE.workspaceId },
    )

    controller.pruneUndemandedRemoteAttempts(new Set(['chat-b']))
    expect(controller.get('local')).toBeDefined()
    expect(controller.get('remote-a')).toBeUndefined()
    expect(controller.get('remote-b')).toBeDefined()
  })

  it('derives Stop authority only from an exact execution lease state', () => {
    const controller = createAttemptController()
    observe(controller, lease('local', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    observe(
      controller,
      lease('remote', 'other', { ownerClientId: 'tab-b', admissionSequence: 2 }),
      { local: false, workspaceId: FENCE.workspaceId },
    )
    observe(
      controller,
      lease('requested', 'requested-target', {
        admissionSequence: 3,
        revision: 2,
        stopControl: {
          requestId: 'request-1',
          requestedBy: 'tab-b',
          requestedAt: 2,
          reason: 'user',
        },
      }),
      { local: false, workspaceId: FENCE.workspaceId },
    )
    observe(
      controller,
      lease('terminalizing', 'terminal-target', {
        admissionSequence: 4,
        phase: 'terminal-decided',
        revision: 2,
      }),
      { local: false, workspaceId: FENCE.workspaceId },
    )

    expect(attemptStopCapability(controller.getExecution('local'))?.kind).toBe('requestable')
    expect(attemptStopCapability(controller.getExecution('remote'))?.kind).toBe('requestable')
    expect(attemptStopCapability(controller.getExecution('requested'))).toMatchObject({
      kind: 'requested',
      control: { requestId: 'request-1' },
    })
    expect(attemptStopCapability(controller.getExecution('terminalizing'))?.kind).toBe(
      'requestable',
    )
    expect(attemptStopCapability(controller.getExecution('missing'))).toBeUndefined()
  })

  it('claims one exact Stop intent synchronously without blocking a sibling', () => {
    const controller = createAttemptController()
    observe(controller, lease('target', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    observe(controller, lease('sibling', 'sibling', { admissionSequence: 2 }), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    const capability = attemptStopCapability(controller.getExecution('target'))
    if (capability?.kind !== 'requestable') throw new Error('ExpectedRequestableStop')
    observe(controller, lease('target', 'target', { revision: 2, heartbeatAt: 2 }), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    expect(controller.getExecution('target')).not.toBe(capability.attempt)

    const claimed = controller.claimStopRequest(capability, {
      requestId: 'stop-request',
      requestedAt: 3,
    })

    expect(attemptStopCapability(controller.getExecution('target'))).toMatchObject({
      kind: 'requesting',
      request: { requestId: 'stop-request' },
    })
    expect(attemptStopCapability(controller.getExecution('sibling'))?.kind).toBe('requestable')
    expect(
      controller.claimStopRequest(capability, { requestId: 'duplicate', requestedAt: 4 }),
    ).toBeUndefined()
    expect(claimed).toBeDefined()
    observe(controller, lease('target', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    expect(attemptStopCapability(controller.getExecution('target'))).toMatchObject({
      kind: 'requesting',
      request: { requestId: 'stop-request' },
    })
  })

  it('fences publishers and cleanup across workspace replacement without owning transport', () => {
    const controller = createAttemptController()
    observe(controller, lease('old', 'target'), {
      local: true,
      workspaceId: FENCE.workspaceId,
    })
    const stop = controller.subscribeTarget('chat-a', 'target', () => {})
    expect(controller.publishLiveProjection(projection('old', 'target', 'visible'))).toBe(true)

    const nextFence = { workspaceId: 'workspace-b', replacementEpoch: 1 }
    controller.replaceWorkspace(nextFence)
    expect(controller.get('old')).toBeUndefined()
    expect(controller.getTargetSnapshot('chat-a', 'target').liveProjection).toBeUndefined()
    expect(controller.publishLiveProjection(projection('old', 'target', 'late'))).toBe(false)
    expect(controller.remove('old', FENCE)).toBe(false)

    observe(controller, lease('new', 'target', { replacementEpoch: 1, admissionSequence: 2 }), {
      local: true,
      workspaceId: nextFence.workspaceId,
    })
    expect(controller.getTargetSnapshot('chat-a', 'target').execution?.streamId).toBe('new')
    stop()
  })

  it('indexes ten thousand admissions linearly and isolates one target update', () => {
    const controller = createAttemptController()
    for (let index = 0; index < 10_000; index += 1) {
      observe(
        controller,
        lease(`stream-${index}`, `target-${index}`, {
          admissionSequence: index + 1,
          revision: index + 1,
        }),
        { local: true, workspaceId: FENCE.workspaceId },
      )
    }
    const firstTarget = vi.fn()
    const middleTarget = vi.fn()
    const lastTarget = vi.fn()
    const stopFirst = controller.subscribeTarget('chat-a', 'target-0', firstTarget)
    const stopMiddle = controller.subscribeTarget('chat-a', 'target-5000', middleTarget)
    const stopLast = controller.subscribeTarget('chat-a', 'target-9999', lastTarget)

    observe(
      controller,
      lease('stream-5000', 'target-5000', {
        admissionSequence: 5001,
        revision: 5001,
      }),
      { local: true, workspaceId: FENCE.workspaceId, phase: 'finalizing' },
    )
    expect(firstTarget).not.toHaveBeenCalled()
    expect(middleTarget).toHaveBeenCalledOnce()
    expect(lastTarget).not.toHaveBeenCalled()
    expect(controller.listRecords()).toHaveLength(10_000)

    stopFirst()
    stopMiddle()
    stopLast()
  })
})
