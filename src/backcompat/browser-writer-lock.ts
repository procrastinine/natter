import type { Transaction } from 'dexie'
import {
  BROWSER_WRITER_LOCK_NAME,
  type BrowserLockRow,
  emptyBrowserWriterLockRow,
} from '../store/browser-lock-record'

export async function migrateBrowserWriterLock(tx: Transaction): Promise<void> {
  const table = tx.table<BrowserLockRow, string>('browserLocks')
  if (await table.get(BROWSER_WRITER_LOCK_NAME)) return
  await table.put(emptyBrowserWriterLockRow())
}
