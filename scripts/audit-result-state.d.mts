export interface StaticAuditState {
  readonly inventoryComplete: boolean
  readonly manifestFresh: boolean
  readonly guaranteeClosed: boolean
  readonly runtimeProved: null
}

export function staticAuditState(options: {
  readonly structurallyValid: boolean
  readonly gaps?: readonly unknown[]
}): StaticAuditState
