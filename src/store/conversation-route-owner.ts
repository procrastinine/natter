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
