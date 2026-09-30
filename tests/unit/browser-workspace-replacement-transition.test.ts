import { describe, expect, it, vi } from 'vitest'
import type { BrowserWorkspacePreparedReplacement } from '../../src/store/browser-workspace-contract'
import { createBrowserWorkspaceReplacementTransitionController } from '../../src/store/browser-workspace-replacement-transition'

const originalWorkspace = { workspaceId: 'workspace-before', replacementEpoch: 4 }
const committed: BrowserWorkspacePreparedReplacement<{ chatCount: number }> = {
  workspace: { workspaceId: 'workspace-after', replacementEpoch: 5 },
  storageBaseline: { kind: 'reset', liveBytes: 144 },
  value: { chatCount: 3 },
}

describe('browser workspace replacement transition', () => {
  it('abandons a preactivation failure and restores local readiness once', async () => {
    const abandon = vi.fn(async () => undefined)
    const reopen = vi.fn(async () => ({ kind: 'ready' as const, workspace: originalWorkspace }))
    const publish = vi.fn()
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen,
      publish,
    })
    transition.ownAbandon(abandon)
    const primary = new Error('copy failed')
    transition.markUncommitted(primary)
    await transition.settleSelection()

    await expect(transition.finalize()).resolves.toEqual({
      kind: 'uncommitted-ready',
      error: primary,
    })
    expect(abandon).toHaveBeenCalledOnce()
    expect(reopen).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
  })

  it('publishes and restores a committed replacement exactly once', async () => {
    const effects = effectsFor(committed.workspace)
    const transition = effects.transition
    advanceToCommitting(transition)
    transition.markCommitted(committed)
    await transition.settleSelection()

    await expect(transition.finalize()).resolves.toEqual({
      kind: 'committed-ready',
      commit: committed,
    })
    expect(effects.abandon).not.toHaveBeenCalled()
    expect(effects.publish).toHaveBeenCalledOnce()
    expect(effects.reopen).toHaveBeenCalledOnce()
  })

  it('attempts every committed finalizer and retains every failure', async () => {
    const publishFailure = new Error('publish failed')
    const reopenFailure = new Error('reopen failed')
    const abandon = vi.fn(async () => undefined)
    const publish = vi.fn(async () => {
      throw publishFailure
    })
    const reopen = vi.fn(async () => {
      throw reopenFailure
    })
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen,
      publish,
    })
    transition.ownAbandon(abandon)
    advanceToCommitting(transition)
    transition.markCommitted(committed)
    await transition.settleSelection()

    await expect(transition.finalize()).resolves.toEqual({
      kind: 'committed-recovery-required',
      commit: committed,
      failures: [publishFailure, reopenFailure],
    })
    expect(abandon).not.toHaveBeenCalled()
    expect(publish).toHaveBeenCalledOnce()
    expect(reopen).toHaveBeenCalledOnce()
  })

  it('never guesses rollback or publication after an uncertain activation', async () => {
    const effects = effectsFor(originalWorkspace)
    const uncertain = new Error('activation inspection failed')
    advanceToCommitting(effects.transition)
    effects.transition.markOutcomeUnknown(uncertain)
    await effects.transition.settleSelection()

    await expect(effects.transition.finalize()).resolves.toEqual({
      kind: 'outcome-unknown',
      failures: [uncertain],
    })
    expect(effects.abandon).not.toHaveBeenCalled()
    expect(effects.publish).not.toHaveBeenCalled()
    expect(effects.reopen).toHaveBeenCalledOnce()
  })

  it('retains rollback and reopen failures', async () => {
    const primary = new Error('copy failed')
    const abandonFailure = new Error('discard journal failed')
    const reopenFailure = new Error('reopen failed')
    const abandon = vi.fn(async () => {
      throw abandonFailure
    })
    const reopen = vi.fn(async () => {
      throw reopenFailure
    })
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen,
      publish: vi.fn(),
    })
    transition.ownAbandon(abandon)
    transition.markUncommitted(primary)
    await transition.settleSelection()

    await expect(transition.finalize()).resolves.toEqual({
      kind: 'uncommitted-recovery-required',
      failures: [abandonFailure, primary, reopenFailure],
    })
    expect(abandon).toHaveBeenCalledOnce()
    expect(reopen).toHaveBeenCalledOnce()
  })

  it('memoizes terminal finalization and rejects a durability downgrade', async () => {
    const effects = effectsFor(committed.workspace)
    const transition = effects.transition
    advanceToCommitting(transition)
    transition.markCommitted(committed)
    expect(() => transition.markUncommitted(new Error('late failure'))).toThrow(
      'BrowserWorkspaceReplacementDispositionInvalid:committed:uncommitted',
    )
    await transition.settleSelection()

    const first = transition.finalize()
    const second = transition.finalize()
    expect(second).toBe(first)
    const [left, right] = await Promise.all([first, second])
    expect(right).toBe(left)
    expect(effects.publish).toHaveBeenCalledOnce()
    expect(effects.reopen).toHaveBeenCalledOnce()
  })
  it('keeps staging on a verified online reopen and does not publish', async () => {
    const effects = effectsFor(originalWorkspace)
    effects.transition.beginQuiescing()
    effects.transition.markQuiesced()
    effects.transition.beginWriting()
    effects.transition.markDeferred()
    await effects.transition.settleSelection()
    await expect(effects.transition.finalize()).resolves.toEqual({ kind: 'online-ready' })
    expect(effects.reopen).toHaveBeenCalledExactlyOnceWith(true)
    expect(effects.abandon).not.toHaveBeenCalled()
    expect(effects.publish).not.toHaveBeenCalled()
  })

  it('abandons deferred staging exactly once when its reopen reports verified cancellation', async () => {
    const reason = new DOMException('external shutdown', 'AbortError')
    let finishReopen!: () => void
    const gate = new Promise<void>((resolve) => {
      finishReopen = resolve
    })
    const abandon = vi.fn(async () => undefined)
    const reopen = vi.fn(async () => {
      await gate
      return { kind: 'cancelled-closed' as const, reason }
    })
    const publish = vi.fn()
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen,
      publish,
    })
    transition.ownAbandon(abandon)
    transition.beginQuiescing()
    transition.markDeferred()
    await transition.settleSelection()
    expect(abandon).not.toHaveBeenCalled()
    const terminal = transition.finalize()
    finishReopen()
    await expect(terminal).resolves.toEqual({ kind: 'cancelled', reason, readiness: 'closed' })
    expect(transition.finalize()).toBe(terminal)
    expect(abandon).toHaveBeenCalledOnce()
    expect(reopen).toHaveBeenCalledExactlyOnceWith(true)
    expect(publish).not.toHaveBeenCalled()
  })

  it('retains a genuine deferred reopen fault and a cleanup fault despite concurrent cancellation', async () => {
    const cancelled = new DOMException('shutdown raced with failure', 'AbortError')
    const storageFailure = new Error('source reopen storage failure')
    const reopenFailure = new AggregateError([storageFailure, cancelled], 'reopen and cancellation')
    const cleanupFailure = new Error('staging cleanup failed')
    const abandon = vi.fn(async () => {
      throw cleanupFailure
    })
    const reopen = vi.fn(async () => {
      throw reopenFailure
    })
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen,
      publish: vi.fn(),
    })
    transition.ownAbandon(abandon)
    transition.beginQuiescing()
    transition.markDeferred()
    await transition.settleSelection()
    await expect(transition.finalize()).resolves.toEqual({
      kind: 'uncommitted-recovery-required',
      failures: [reopenFailure, cleanupFailure],
    })
    expect(abandon).toHaveBeenCalledOnce()
  })

  it('keeps cleanup failure fatal after verified deferred reopen cancellation', async () => {
    const reason = new DOMException('shutdown', 'AbortError')
    const cleanupFailure = new Error('could not discard staging')
    const abandon = vi.fn(async () => {
      throw cleanupFailure
    })
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen: async () => ({ kind: 'cancelled-closed', reason }),
      publish: vi.fn(),
    })
    transition.ownAbandon(abandon)
    transition.beginQuiescing()
    transition.markDeferred()
    await transition.settleSelection()
    await expect(transition.finalize()).resolves.toEqual({
      kind: 'uncommitted-recovery-required',
      failures: [cleanupFailure],
    })
    expect(abandon).toHaveBeenCalledOnce()
  })

  it('abandons deferred staging after an incorrect source reopen fence', async () => {
    const effects = effectsFor(committed.workspace)
    effects.transition.beginQuiescing()
    effects.transition.markDeferred()
    await effects.transition.settleSelection()
    const outcome = await effects.transition.finalize()
    expect(outcome.kind).toBe('uncommitted-recovery-required')
    if (outcome.kind !== 'uncommitted-recovery-required') throw new Error('Expected fence failure')
    expect(outcome.failures).toHaveLength(1)
    expect(outcome.failures[0]).toMatchObject({
      message: 'BrowserWorkspaceReplacementReopenFenceMismatch',
    })
    expect(effects.abandon).toHaveBeenCalledOnce()
  })
})

function effectsFor(reopenedWorkspace: typeof originalWorkspace) {
  const abandon = vi.fn(async () => undefined)
  const reopen = vi.fn(async () => ({ kind: 'ready' as const, workspace: reopenedWorkspace }))
  const publish = vi.fn()
  const transition = createBrowserWorkspaceReplacementTransitionController({
    originalWorkspace,
    reopen,
    publish,
  })
  transition.ownAbandon(abandon)
  return { transition, abandon, reopen, publish }
}

function advanceToCommitting(
  transition: ReturnType<typeof createBrowserWorkspaceReplacementTransitionController>,
): void {
  transition.beginQuiescing()
  transition.markQuiesced()
  transition.beginWriting()
  transition.markPrepared()
  transition.beginCommitting()
}

describe('replacement shutdown after durable activation', () => {
  it('publishes a committed closed outcome once without abandoning committed staging', async () => {
    const shutdown = new DOMException('external shutdown', 'AbortError')
    const publish = vi.fn()
    const abandon = vi.fn(async () => undefined)
    const reopen = vi.fn(async () => ({ kind: 'cancelled-closed' as const, reason: shutdown }))
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen,
      publish,
    })
    transition.ownAbandon(abandon)
    advanceToCommitting(transition)
    transition.markCommitted(committed)
    await transition.settleSelection()
    const terminal = transition.finalize()
    expect(transition.finalize()).toBe(terminal)
    await expect(terminal).resolves.toEqual({ kind: 'committed-closed', commit: committed })
    expect(publish).toHaveBeenCalledExactlyOnceWith(committed)
    expect(reopen).toHaveBeenCalledExactlyOnceWith(false)
    expect(abandon).not.toHaveBeenCalled()
  })

  it('preserves a genuine publication failure when shutdown intentionally leaves the workspace closed', async () => {
    const shutdown = new DOMException('external shutdown', 'AbortError')
    const publicationFailure = new Error('replacement publication failed')
    const abandon = vi.fn(async () => undefined)
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen: async () => ({ kind: 'cancelled-closed', reason: shutdown }),
      publish: () => {
        throw publicationFailure
      },
    })
    transition.ownAbandon(abandon)
    advanceToCommitting(transition)
    transition.markCommitted(committed)
    await transition.settleSelection()
    await expect(transition.finalize()).resolves.toEqual({
      kind: 'committed-recovery-required',
      commit: committed,
      failures: [publicationFailure],
    })
    expect(abandon).not.toHaveBeenCalled()
  })

  it('retains a real preactivation failure without claiming readiness after expected shutdown', async () => {
    const shutdown = new DOMException('external shutdown', 'AbortError')
    const primary = new Error('replacement preparation failed')
    const abandon = vi.fn(async () => undefined)
    const publish = vi.fn()
    const transition = createBrowserWorkspaceReplacementTransitionController({
      originalWorkspace,
      reopen: async () => ({ kind: 'cancelled-closed', reason: shutdown }),
      publish,
    })
    transition.ownAbandon(abandon)
    transition.markUncommitted(primary)
    await transition.settleSelection()
    await expect(transition.finalize()).resolves.toEqual({
      kind: 'uncommitted-closed',
      error: primary,
    })
    expect(abandon).toHaveBeenCalledOnce()
    expect(publish).not.toHaveBeenCalled()
  })
})

it('requires lifecycle closure proof even after an exact cancellation disposition', async () => {
  const cancellation = new DOMException('shutdown', 'AbortError')
  const closureFailure = new Error('resource closure failed')
  const reopen = vi.fn(async () => {
    throw closureFailure
  })
  const abandon = vi.fn(async () => undefined)
  const transition = createBrowserWorkspaceReplacementTransitionController({
    originalWorkspace,
    reopen,
    publish: vi.fn(),
  })
  transition.ownAbandon(abandon)
  transition.markCancelled(cancellation)
  await transition.settleSelection()
  await expect(transition.finalize()).resolves.toEqual({
    kind: 'uncommitted-recovery-required',
    failures: [closureFailure],
  })
  expect(reopen).toHaveBeenCalledExactlyOnceWith(false)
  expect(abandon).toHaveBeenCalledOnce()
})
