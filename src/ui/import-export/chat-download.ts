import type { ChatId, MessageId } from '../../core/types'
import { interchangeApplication } from '../../store/interchange-application'

export function exportChatAsTxt(
  chatId: ChatId,
  leafId: MessageId | null,
): Promise<{ filename: string; content: string }> {
  return interchangeApplication.exportChatText(chatId, leafId)
}

export function exportLastUpdatedChatAsTxt(
  chatId: ChatId,
): Promise<{ filename: string; content: string }> {
  return interchangeApplication.exportLastUpdatedChatText(chatId)
}

export async function exportLastUpdatedChatsAsZip(
  chatIds: readonly ChatId[],
): Promise<{ filename: string; blob: Blob }> {
  return {
    filename: `natter-chats-${new Date().toISOString().slice(0, 10)}.zip`,
    blob: await zipLastUpdatedChatsAsBlob(chatIds),
  }
}

export function triggerBrowserDownload(filename: string, content: string): void {
  triggerBrowserBlobDownload(filename, new Blob([content], { type: 'text/plain;charset=utf-8' }))
}

export function triggerBrowserBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
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

type ExportOutcome =
  | { ok: true; value: Awaited<ReturnType<typeof exportLastUpdatedChatAsTxt>> }
  | { ok: false; error: unknown }

const ZIP_EXPORT_PREFETCH = 2

async function zipLastUpdatedChatsAsBlob(chatIds: readonly ChatId[]): Promise<Blob> {
  const { strToU8, Zip, ZipDeflate } = await import('fflate')
  const chunks: ArrayBuffer[] = []
  let archiveError: unknown
  let resolveArchive: ((blob: Blob) => void) | undefined
  let rejectArchive: ((error: unknown) => void) | undefined
  const completed = new Promise<Blob>((resolve, reject) => {
    resolveArchive = resolve
    rejectArchive = reject
  })
  const archive = new Zip((error, chunk, final) => {
    if (error) {
      archiveError = error
      rejectArchive?.(error)
      return
    }
    chunks.push(arrayBufferFromBytes(chunk))
    if (final) {
      resolveArchive?.(new Blob(chunks, { type: 'application/zip' }))
    }
  })
  const pending = new Map<number, Promise<ExportOutcome>>()
  let nextToStart = 0
  const prefetch = (): void => {
    while (nextToStart < chatIds.length && pending.size < ZIP_EXPORT_PREFETCH) {
      const index = nextToStart
      nextToStart += 1
      pending.set(
        index,
        interchangeApplication.exportLastUpdatedChatText(chatIds[index] as ChatId).then(
          (value): ExportOutcome => ({ ok: true, value }),
          (error): ExportOutcome => ({ ok: false, error }),
        ),
      )
    }
  }
  const seen = new Map<string, number>()
  try {
    prefetch()
    for (let index = 0; index < chatIds.length; index += 1) {
      const outcome = await pending.get(index)
      pending.delete(index)
      prefetch()
      if (!outcome) throw new Error(`ChatExportMissing:${chatIds[index]}`)
      if (!outcome.ok) throw outcome.error
      const file = new ZipDeflate(uniqueZipFilename(outcome.value.filename, index, seen), {
        level: 6,
      })
      archive.add(file)
      file.push(strToU8(outcome.value.content), true)
    }
    archive.end()
    return await completed
  } catch (error) {
    archive.terminate()
    if (archiveError === undefined) rejectArchive?.(error)
    void completed.catch(() => undefined)
    throw error
  }
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer
  }
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
