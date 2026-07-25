export function staticAuditState({ structurallyValid, gaps = [] }) {
  const structureClosed = structurallyValid === true
  return Object.freeze({
    inventoryComplete: structureClosed,
    manifestFresh: structureClosed,
    guaranteeClosed: structureClosed && gaps.length === 0,
    runtimeProved: null,
  })
}
