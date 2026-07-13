import { getWorkspaceRepository } from '../store/workspace-repository'
import { exportActiveBranchAsTxt, exportLastUpdatedBranchAsTxt } from './branch-flatten'
import type { ChatId, CursorMap } from './types'

export async function exportChatAsTxt(
  chatId: ChatId,
  cursor: CursorMap = {},
): Promise<{ filename: string; content: string }> {
  return exportActiveBranchAsTxt(getWorkspaceRepository(), chatId, cursor)
}

export async function exportLastUpdatedChatAsTxt(
  chatId: ChatId,
): Promise<{ filename: string; content: string }> {
  return exportLastUpdatedBranchAsTxt(getWorkspaceRepository(), chatId)
}

export async function exportLastUpdatedChatsAsZip(
  chatIds: readonly ChatId[],
): Promise<{ filename: string; blob: Blob }> {
  const exported = await Promise.all(chatIds.map((chatId) => exportLastUpdatedChatAsTxt(chatId)))
  const entries: Array<{ filename: string; content: string }> = []
  const seen = new Map<string, number>()
  for (const [index, entry] of exported.entries()) {
    entries.push({
      filename: uniqueZipFilename(entry.filename, index, seen),
      content: entry.content,
    })
  }
  return {
    filename: `natter-chats-${new Date().toISOString().slice(0, 10)}.zip`,
    blob: await zipEntriesAsBlob(entries),
  }
}

export function triggerBrowserDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  triggerBrowserBlobDownload(filename, blob)
}

export function triggerBrowserBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function uniqueZipFilename(filename: string, index: number, seen: Map<string, number>): string {
  const sanitized = filename.replaceAll(/[\\/:*?"<>|]/g, '-').trim() || `chat-${index + 1}.txt`
  const candidate = sanitized.toLocaleLowerCase().endsWith('.txt') ? sanitized : `${sanitized}.txt`
  const count = seen.get(candidate) ?? 0
  seen.set(candidate, count + 1)
  if (count === 0) return candidate
  const dot = candidate.lastIndexOf('.')
  if (dot <= 0) return `${candidate}-${count + 1}`
  return `${candidate.slice(0, dot)}-${count + 1}${candidate.slice(dot)}`
}

async function zipEntriesAsBlob(
  entries: readonly { filename: string; content: string }[],
): Promise<Blob> {
  const { strToU8, Zip, ZipDeflate } = await import('fflate')
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    const archive = new Zip((error, chunk, final) => {
      if (error) {
        reject(error)
        return
      }
      chunks.push(chunk)
      if (final) {
        resolve(new Blob(chunks.map(arrayBufferFromBytes), { type: 'application/zip' }))
      }
    })
    for (const entry of entries) {
      const file = new ZipDeflate(entry.filename, { level: 6 })
      archive.add(file)
      file.push(strToU8(entry.content), true)
    }
    archive.end()
  })
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
