import { newId } from '../lib/ulid'

const conversationRouteOwnerBrand: unique symbol = Symbol('ConversationRouteOwner')

export interface ConversationRouteOwner {
  readonly id: string
  readonly signal: AbortSignal
  readonly [conversationRouteOwnerBrand]: true
}

export interface ConversationRouteOwnerController {
  readonly owner: ConversationRouteOwner
  cancel(reason?: unknown): void
}

export interface WorkspacePresentationForegroundDemand {
  release(): void
}

export interface WorkspacePresentationForegroundDemandPort {
  claim(): WorkspacePresentationForegroundDemand
}

let workspaceForegroundDemandPort: WorkspacePresentationForegroundDemandPort | null = null

export function installWorkspacePresentationForegroundDemandPort(
  port: WorkspacePresentationForegroundDemandPort,
): void {
  if (workspaceForegroundDemandPort) {
    throw new Error('WorkspacePresentationForegroundDemandPortAlreadyInstalled')
  }
  workspaceForegroundDemandPort = port
}

export function claimWorkspacePresentationForegroundDemand(): WorkspacePresentationForegroundDemand {
  if (!workspaceForegroundDemandPort) {
    throw new Error('WorkspacePresentationForegroundDemandPortMissing')
  }
  return workspaceForegroundDemandPort.claim()
}

export function createConversationRouteOwnerController(): ConversationRouteOwnerController {
  const controller = new AbortController()
  const owner = Object.freeze({
    id: newId(),
    signal: controller.signal,
    [conversationRouteOwnerBrand]: true as const,
  })
  return Object.freeze({
    owner,
    cancel: (reason?: unknown) => controller.abort(reason),
  })
}
