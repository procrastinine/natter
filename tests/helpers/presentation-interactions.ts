import {
  definePresentationInteraction,
  PresentationInteractionController,
  type PresentationInteractionFailure,
  type TotalPresentationInteractionPromise,
} from '../../src/store/presentation-interaction-controller'
import type { WorkspaceFence } from '../../src/store/repository'
import { reconcileWorkspaceTabSessionStorage } from '../../src/store/workspace-tab-session'

const TEST_FENCE: WorkspaceFence = Object.freeze({
  workspaceId: 'test-presentation-interactions',
  replacementEpoch: 1,
})

const TEST_CAPABILITY = definePresentationInteraction<string>({
  id: 'test.total-settlement',
  label: 'Test interaction',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

export interface InteractionSettlementHarness {
  readonly presented: PresentationInteractionFailure[]
  run(action: () => void | Promise<void>): TotalPresentationInteractionPromise<void>
  succeed(): TotalPresentationInteractionPromise<void>
  fail(error: unknown): TotalPresentationInteractionPromise<void>
}

export function createInteractionSettlementHarness(): InteractionSettlementHarness {
  const presented: PresentationInteractionFailure[] = []
  const controller = new PresentationInteractionController(
    {
      describe(capability, error) {
        return {
          message: `${capability.label}: ${error instanceof Error ? error.message : 'unknown'}`,
          tone: 'danger',
        }
      },
      present(failure) {
        presented.push(failure)
      },
    },
    { currentFence: () => TEST_FENCE },
  )
  const presenter = controller.createPresenter(TEST_FENCE)
  let target = 0
  const run = (action: () => void | Promise<void>) =>
    controller.start({
      capability: TEST_CAPABILITY,
      presenter,
      target: `interaction-${++target}`,
      run: action,
    }).settled
  return {
    presented,
    run,
    succeed: () => run(() => undefined),
    fail: (error) =>
      run(() => {
        throw error
      }),
  }
}

const successHarness = createInteractionSettlementHarness()

export function succeededInteractionSettlement(): TotalPresentationInteractionPromise<void> {
  return successHarness.succeed()
}

export function installPresentationWorkspaceFence(prefix: string): WorkspaceFence {
  const fence = Object.freeze({
    workspaceId: `${prefix}-${crypto.randomUUID()}`,
    replacementEpoch: 1,
  })
  reconcileWorkspaceTabSessionStorage(fence)
  return fence
}
