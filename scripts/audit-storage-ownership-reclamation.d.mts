export function discoverCanonicalPhysicalStorageTableNames(root?: string): readonly string[]
export function discoverBrowserWorkspaceDatabaseNames(root?: string): readonly string[]

export function inspectCompactionContinuation(source: string): string[]
export function inspectWorkspacePeerRecovery(sources: {
  cleanup: string
  coordination: string
  lifecycle: string
}): string[]
