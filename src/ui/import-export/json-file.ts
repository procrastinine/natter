import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate } from 'fflate'
import { triggerBrowserBlobDownload } from '../../core/chat-export'

interface JsonZipEntry {
  filename: string
  value: unknown
}

export function triggerJsonDownload(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: 'application/json;charset=utf-8',
  })
  triggerBrowserBlobDownload(filename, blob)
}

export async function triggerJsonZipDownload(
  filename: string,
  entries: readonly JsonZipEntry[],
): Promise<void> {
  triggerBrowserBlobDownload(filename, await jsonEntriesZipBlob(entries))
}

export function jsonEntriesZipBlob(entries: readonly JsonZipEntry[]): Promise<Blob> {
  const seen = new Map<string, number>()
  const zippedEntries = entries.map((entry, index) => ({
    filename: uniqueJsonZipFilename(entry.filename, index, seen),
    content: `${JSON.stringify(entry.value, null, 2)}\n`,
  }))
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
    for (const entry of zippedEntries) {
      const file = new ZipDeflate(entry.filename, { level: 6 })
      archive.add(file)
      file.push(strToU8(entry.content), true)
    }
    archive.end()
  })
}

export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text()) as unknown
}

export async function readJsonOrZipFile(file: File): Promise<unknown[]> {
  if (!isZipFile(file)) return [await readJsonFile(file)]
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
  const jsonEntries = Object.entries(entries)
    .filter(([filename]) => isJsonZipEntry(filename))
    .sort(([left], [right]) => left.localeCompare(right))
  if (jsonEntries.length === 0) throw new Error('The selected ZIP does not contain JSON files.')
  return jsonEntries.map(([filename, bytes]) => {
    try {
      return JSON.parse(strFromU8(bytes)) as unknown
    } catch {
      throw new Error(`${filename} is not valid JSON.`)
    }
  })
}

export function natterJsonFilename(kind: string, label?: string, id?: string): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const segment = sanitizeFilenameSegment(label ?? id ?? '')
  return `${['natter', kind, segment, timestamp].filter(Boolean).join('-')}.json`
}

export function natterZipFilename(kind: string, label?: string): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const segment = sanitizeFilenameSegment(label ?? '')
  return `${['natter', kind, segment, timestamp].filter(Boolean).join('-')}.zip`
}

export function importExportErrorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return 'The selected file is not valid JSON.'
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Import/export failed.'
}

function sanitizeFilenameSegment(value: string): string {
  return value
    .trim()
    .replaceAll(/[^\w.-]+/g, '-')
    .replaceAll(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

function isZipFile(file: File): boolean {
  const lowerName = file.name.toLocaleLowerCase()
  return (
    lowerName.endsWith('.zip') ||
    file.type === 'application/zip' ||
    file.type === 'application/x-zip-compressed'
  )
}

function isJsonZipEntry(filename: string): boolean {
  const lower = filename.toLocaleLowerCase()
  return !lower.endsWith('/') && lower.endsWith('.json')
}

function uniqueJsonZipFilename(filename: string, index: number, seen: Map<string, number>): string {
  const sanitized = filename.replaceAll(/[\\/:*?"<>|]/g, '-').trim() || `chat-${index + 1}.json`
  const candidate = sanitized.toLocaleLowerCase().endsWith('.json')
    ? sanitized
    : `${sanitized}.json`
  const key = candidate.toLocaleLowerCase()
  const count = seen.get(key) ?? 0
  seen.set(key, count + 1)
  if (count === 0) return candidate
  const dot = candidate.lastIndexOf('.')
  if (dot <= 0) return `${candidate}-${count + 1}`
  return `${candidate.slice(0, dot)}-${count + 1}${candidate.slice(dot)}`
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
