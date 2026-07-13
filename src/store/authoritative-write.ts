import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import { withNamedLocks } from './locks'
import { bumpBrowserWorkspaceMeta } from './workspace-meta'

interface AuthoritativeWriteResult<T> {
  value: T
  changed: boolean
}

export async function runAuthoritativeTransaction<T>(input: {
  db: Dexie
  lockNames: readonly string[]
  tables: readonly ({ readonly name: string } | string)[]
  now: number
  write: (tx: Transaction) => Promise<AuthoritativeWriteResult<T>>
}): Promise<AuthoritativeWriteResult<T>> {
  return withNamedLocks(input.lockNames, (grant) =>
    grant.runTransaction(input.db, input.tables, async (tx) => {
      const result = await input.write(tx)
      if (result.changed) await bumpBrowserWorkspaceMeta(tx, input.now)
      return result
    }),
  )
}
