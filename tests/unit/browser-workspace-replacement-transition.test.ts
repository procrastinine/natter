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
    const reopen = vi.fn(async () => originalWorkspace)
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
})

function effectsFor(reopenedWorkspace: typeof originalWorkspace) {
  const abandon = vi.fn(async () => undefined)
  const reopen = vi.fn(async () => reopenedWorkspace)
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
