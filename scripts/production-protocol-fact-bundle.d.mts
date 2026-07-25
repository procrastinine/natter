import type ts from 'typescript'

export interface ProductionProtocolFactBundle {
  readonly schemaVersion: 3
  readonly snapshot: {
    readonly digest: string
    readonly generatorDigest: string
    readonly sourceFiles: number
  }
  readonly production: unknown
  readonly unionDiscovery: unknown
  readonly stages: unknown
  readonly configuration: unknown
  readonly durable: unknown
  readonly locality: unknown
  readonly auditCapabilities: readonly {
    readonly ownerId: string
    readonly roots: readonly { readonly name: string; readonly id: string }[]
  }[]
}

export function buildProductionProtocolFactBundle(options?: {
  readonly program?: ts.Program
  readonly createProgram?: (root: string) => ts.Program
  readonly discoverUnions?: (
    root: string,
    options: { readonly program: ts.Program },
  ) => unknown
}): ProductionProtocolFactBundle
export function productionProtocolFactBundleContainsCompilerState(value: unknown): boolean
