export type NativeStorageFixturePurpose = 'read-only-assertion' | 'fault-injection' | 'legacy-fixture' | 'physical-reclamation' | 'reset'
export interface NativeWorkspaceIdentity {
  readonly databaseName: string
  readonly activationSequence: number
}
export interface NativeFixtureDatabase {
  readonly name: string
  readonly version: number
  readonly objectStoreNames: DOMStringList
  completion(transaction: IDBTransaction): Promise<void>
  transaction(stores: string | string[], mode?: IDBTransactionMode, options?: IDBTransactionOptions): IDBTransaction
}
export interface NativeStorageFixtureOptions {
  readonly purpose: NativeStorageFixturePurpose
  readonly signal?: AbortSignal
}
export type NativeFixtureCallback<T> = (
  database: NativeFixtureDatabase,
  request: <R>(request: IDBRequest<R>) => Promise<R>,
  binding: NativeWorkspaceIdentity | null,
) => T | Promise<T>
export interface NativeWorkspaceStorageFixture {
  active<T>(options: NativeStorageFixtureOptions, callback: (database: NativeFixtureDatabase, request: <R>(request: IDBRequest<R>) => Promise<R>, binding: NativeWorkspaceIdentity) => T | Promise<T>): Promise<T>
  control<T>(options: NativeStorageFixtureOptions, callback: NativeFixtureCallback<T>): Promise<T>
  observeNamed<T>(options: Omit<NativeStorageFixtureOptions, 'purpose'> & { databaseName: string; purpose: 'read-only-assertion' }, callback: NativeFixtureCallback<T>): Promise<T>
  offline<T>(options: NativeStorageFixtureOptions & { databaseName: string; version?: number; upgrade?: (database: IDBDatabase, transaction: IDBTransaction, oldVersion: number, newVersion: number | null) => void }, callback: NativeFixtureCallback<T>): Promise<T>
  deleteOffline(options: NativeStorageFixtureOptions & { databaseName: string }): Promise<void>
  databaseNames(): Promise<string[]>
  readActiveIdentity(): Promise<NativeWorkspaceIdentity>
  holdActiveStores(storeNames: readonly string[]): Promise<{ id: string; binding: NativeWorkspaceIdentity }>
  holdNamed(options: { databaseName: string; purpose: 'physical-reclamation' }): Promise<{ id: string }>
  release(id: string): Promise<void>
  cancel(id: string): Promise<void>
  dispose(): void
}
declare global {
  var __natterNativeStorageFixture: NativeWorkspaceStorageFixture
}
export function installNativeWorkspaceStorageFixture(): void
