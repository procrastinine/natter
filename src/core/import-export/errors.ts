export class WorkspaceReplacementInProgressError extends Error {
  readonly blockerIds: readonly string[]

  constructor(blockerIds: Iterable<string>) {
    const ids = [...new Set(blockerIds)].sort()
    super(`WorkspaceReplacementInProgress:${ids.join(',')}`)
    this.name = 'WorkspaceReplacementInProgressError'
    this.blockerIds = Object.freeze(ids)
  }
}
