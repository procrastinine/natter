import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  createPresentationInteractionPresenter,
  presentationInteractionPending,
  presentationInteractionRevision,
  releasePresentationInteractionPresenter,
  startPresentationInteraction,
  subscribePresentationInteraction,
} from '../app/presentation-interactions'
import type {
  PresentationInteractionCallbackResult,
  PresentationInteractionCapability,
  PresentationInteractionClaim,
  PresentationInteractionCommit,
  PresentationInteractionPresenter,
  PresentationInteractionRunContext,
} from '../store/presentation-contracts'
import {
  getWorkspaceTabSessionSnapshot,
  subscribeWorkspaceTabSession,
} from '../store/workspace-tab-session'

export interface PresentationInteractionHandle<Target extends PropertyKey> {
  run<Value>(
    this: void,
    input: {
      readonly target: Target
      readonly action: (
        context: PresentationInteractionRunContext,
      ) =>
        | PresentationInteractionCallbackResult<Value>
        | PromiseLike<PresentationInteractionCallbackResult<Value>>
      readonly commit?: PresentationInteractionCommit<Value>
    },
  ): PresentationInteractionClaim<Value>
  readonly isPending: (target: Target) => boolean
}

export interface PresentationInteractionOptions {
  readonly observePending?: boolean
}

const subscribeToNothing = () => () => {}
const zeroRevision = () => 0

export function usePresentationInteraction<Target extends PropertyKey>(
  capability: PresentationInteractionCapability<Target>,
  options?: PresentationInteractionOptions,
): PresentationInteractionHandle<Target> {
  const observePending = options?.observePending !== false
  const presenterRef = useRef<PresentationInteractionPresenter | null>(null)
  const workspaceSession = useSyncExternalStore(
    subscribeWorkspaceTabSession,
    getWorkspaceTabSessionSnapshot,
    getWorkspaceTabSessionSnapshot,
  )
  if (presenterRef.current === null) {
    presenterRef.current = createPresentationInteractionPresenter(workspaceSession.fence)
  }
  useSyncExternalStore(
    useCallback(
      (listener) =>
        observePending
          ? subscribePresentationInteraction(capability, listener)
          : subscribeToNothing(),
      [capability, observePending],
    ),
    useCallback(
      () => (observePending ? presentationInteractionRevision(capability) : zeroRevision()),
      [capability, observePending],
    ),
    useCallback(
      () => (observePending ? presentationInteractionRevision(capability) : zeroRevision()),
      [capability, observePending],
    ),
  )
  useLayoutEffect(() => {
    const previousPresenter = presenterRef.current
    const presenter = createPresentationInteractionPresenter(workspaceSession.fence)
    presenterRef.current = presenter
    if (previousPresenter) releasePresentationInteractionPresenter(previousPresenter)
    return () => releasePresentationInteractionPresenter(presenter)
  }, [workspaceSession.fence])
  const run = useCallback(
    <Value>(input: {
      readonly target: Target
      readonly action: (
        context: PresentationInteractionRunContext,
      ) =>
        | PresentationInteractionCallbackResult<Value>
        | PromiseLike<PresentationInteractionCallbackResult<Value>>
      readonly commit?: PresentationInteractionCommit<Value>
    }) => {
      const presenter = presenterRef.current
      if (presenter === null) throw new Error('PresentationInteractionPresenterMissing')
      const claim = startPresentationInteraction({
        capability,
        presenter,
        target: input.target,
        run: input.action,
        ...(input.commit ? { commit: input.commit } : {}),
      })
      return claim
    },
    [capability],
  )
  const isPending = useCallback(
    (target: Target) => presentationInteractionPending(capability, target),
    [capability],
  )
  return useMemo(() => ({ run, isPending }), [isPending, run])
}
