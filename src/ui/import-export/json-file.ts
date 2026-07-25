import type { ZipDeflate } from 'fflate'
import {
  WorkspaceReplacementCommittedRecoveryRequiredError,
  WorkspaceReplacementOutcomeUnknownError,
  WorkspaceReplacementUncommittedRecoveryRequiredError,
} from '../../core/import-export/errors'
import { errorFromUnknown } from '../../lib/error'
import { triggerBrowserBlobDownload } from './chat-download'

interface JsonZipEntry {
  filename: string
  value: unknown
}

interface LazyJsonZipEntry {
  filename: string
  loadValue: () => Promise<unknown>
}

type JsonZipEntryInput = JsonZipEntry | LazyJsonZipEntry

const MAX_JSON_CHUNK_UTF8_BYTES = 64 * 1024
const MAX_JSON_CHUNK_CODE_UNITS = Math.floor(MAX_JSON_CHUNK_UTF8_BYTES / 3)
const OMIT_JSON_VALUE = Symbol('omit-json-value')
const textEncoder = new TextEncoder()

interface JsonIoMaterializationMetrics {
  fileDecodeChunks: number
  fileDecodedBytes: number
  maxFileDecodeChunkBytes: number
  zipEntryDecodeChunks: number
  zipEntryDecodedBytes: number
  maxZipEntryDecodeChunkBytes: number
  maxParsedZipEntriesRetained: number
  parsedZipEntryWrappersReleased: number
  zipOutputChunks: number
  zipOutputBytes: number
  zipOutputCopiedBytes: number
  jsonBlobParts: number
  maxJsonBlobPartCodeUnits: number
}

let jsonIoMetrics = emptyJsonIoMetrics()

export function __resetJsonIoMaterializationMetricsForTests(): void {
  jsonIoMetrics = emptyJsonIoMetrics()
}

export function __jsonIoMaterializationMetricsForTests(): Readonly<JsonIoMaterializationMetrics> {
  return { ...jsonIoMetrics }
}

export function triggerJsonDownload(filename: string, value: unknown): void {
  triggerBrowserBlobDownload(filename, jsonDocumentBlob(value))
}

export function jsonDocumentBlob(value: unknown): Blob {
  const parts: Blob[] = []
  for (const chunk of jsonDocumentChunks(value)) {
    parts.push(new Blob([chunk]))
    jsonIoMetrics.jsonBlobParts += 1
    jsonIoMetrics.maxJsonBlobPartCodeUnits = Math.max(
      jsonIoMetrics.maxJsonBlobPartCodeUnits,
      chunk.length,
    )
  }
  return new Blob(parts, { type: 'application/json;charset=utf-8' })
}

export async function triggerJsonZipDownload(
  filename: string,
  entries: readonly JsonZipEntryInput[],
): Promise<void> {
  triggerBrowserBlobDownload(filename, await jsonEntriesZipBlob(entries))
}

export async function jsonEntriesZipBlob(entries: readonly JsonZipEntryInput[]): Promise<Blob> {
  const { Zip, ZipDeflate } = await import('fflate')
  const seen = new Map<string, number>()
  const chunks: Blob[] = []
  let resolveArchive: ((blob: Blob) => void) | undefined
  let rejectArchive: ((error: unknown) => void) | undefined
  let archiveError: Error | undefined
  const completed = new Promise<Blob>((resolve, reject) => {
    resolveArchive = resolve
    rejectArchive = reject
  })
  void completed.catch(() => undefined)
  const archive = new Zip((error, chunk, final) => {
    if (error) {
      archiveError = errorFromUnknown(error)
      rejectArchive?.(archiveError)
      return
    }
    chunks.push(immutableZipChunk(chunk))
    jsonIoMetrics.zipOutputChunks += 1
    jsonIoMetrics.zipOutputBytes += chunk.byteLength
    if (final) {
      resolveArchive?.(new Blob(chunks, { type: 'application/zip' }))
    }
  })
  try {
    for (const [index, entry] of entries.entries()) {
      const file = new ZipDeflate(uniqueJsonZipFilename(entry.filename, index, seen), {
        level: 6,
      })
      archive.add(file)
      pushJsonDocument(file, 'loadValue' in entry ? await entry.loadValue() : entry.value)
      if (archiveError) throw archiveError
    }
    archive.end()
    if (archiveError) throw archiveError
    return await completed
  } catch (error) {
    archive.terminate()
    throw error
  }
}

export function __jsonDocumentChunksForTests(value: unknown): readonly string[] {
  return [...jsonDocumentChunks(value)]
}

export async function readJsonFile(file: File): Promise<unknown> {
  const decoder = new TextDecoder()
  let document = ''
  for await (const chunk of fileChunks(file)) {
    recordFileDecodeChunk(chunk.byteLength)
    document += decoder.decode(chunk, { stream: true })
  }
  document += decoder.decode()
  return JSON.parse(document) as unknown
}

export async function readJsonOrZipFile(file: File): Promise<unknown[]> {
  if (!isZipFile(file)) return [await readJsonFile(file)]
  const entries = await readJsonZipEntries(file)
  if (entries.length === 0) throw new Error('The selected ZIP does not contain JSON files.')
  entries.sort((left, right) => left.filename.localeCompare(right.filename))
  const values: unknown[] = entries
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as ParsedJsonZipEntry
    if (entry.error) throw new Error(`${entry.filename} is not valid JSON.`)
    values[index] = entry.value
    jsonIoMetrics.parsedZipEntryWrappersReleased += 1
  }
  return values
}

export async function forEachJsonOrZipFile(
  file: File,
  consume: (value: unknown) => void | Promise<void>,
): Promise<number> {
  if (!isZipFile(file)) {
    await consume(await readJsonFile(file))
    return 1
  }
  const entries = await readJsonZipEntries(file)
  if (entries.length === 0) throw new Error('The selected ZIP does not contain JSON files.')
  entries.sort((left, right) => left.filename.localeCompare(right.filename))
  const invalid = entries.find((entry) => entry.error)
  if (invalid) throw new Error(`${invalid.filename} is not valid JSON.`)
  const releasedEntries: unknown[] = entries
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as ParsedJsonZipEntry
    await consume(entry.value)
    releasedEntries[index] = undefined
    jsonIoMetrics.parsedZipEntryWrappersReleased += 1
  }
  return entries.length
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
  if (error instanceof WorkspaceReplacementCommittedRecoveryRequiredError) {
    return 'Workspace import committed, but this tab could not finish recovery. Reload before continuing.'
  }
  if (error instanceof WorkspaceReplacementUncommittedRecoveryRequiredError) {
    return 'Workspace import did not commit, and this tab could not finish recovery. Reload before retrying.'
  }
  if (error instanceof WorkspaceReplacementOutcomeUnknownError) {
    return 'Workspace activation could not be confirmed. Reload to recover before attempting another import.'
  }
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

interface ParsedJsonZipEntry {
  filename: string
  value?: unknown
  error?: true
}

async function readJsonZipEntries(file: File): Promise<ParsedJsonZipEntry[]> {
  const { Unzip, UnzipInflate } = await import('fflate')
  const entries: ParsedJsonZipEntry[] = []
  const entryIndexByName = new Map<string, number>()
  let archiveError: Error | undefined
  const archive = new Unzip((entry) => {
    const json = isJsonZipEntry(entry.name)
    let document = ''
    const decoder = json ? new TextDecoder() : undefined
    entry.ondata = (error, chunk, final) => {
      if (archiveError) return
      if (error) {
        archiveError = errorFromUnknown(error)
        return
      }
      if (!json || !decoder) return
      if (chunk.length > 0) {
        recordZipEntryDecodeChunk(chunk.byteLength)
        document += decoder.decode(chunk, { stream: true })
      }
      if (!final) return
      document += decoder.decode()
      const result: ParsedJsonZipEntry = { filename: entry.name }
      try {
        result.value = JSON.parse(document) as unknown
      } catch {
        result.error = true
      }
      const existingIndex = entryIndexByName.get(entry.name)
      if (existingIndex === undefined) {
        entryIndexByName.set(entry.name, entries.length)
        entries.push(result)
      } else {
        entries[existingIndex] = result
      }
      jsonIoMetrics.maxParsedZipEntriesRetained = Math.max(
        jsonIoMetrics.maxParsedZipEntriesRetained,
        entries.length,
      )
    }
    try {
      entry.start()
    } catch (error) {
      archiveError = errorFromUnknown(error)
    }
  })
  archive.register(UnzipInflate)

  for await (const chunk of fileChunks(file)) {
    archive.push(chunk)
    if (archiveError) throw archiveError
  }
  archive.push(new Uint8Array(0), true)
  if (archiveError) throw archiveError
  return entries
}

async function* fileChunks(file: File): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < file.size; offset += MAX_JSON_CHUNK_UTF8_BYTES) {
    const slice = file.slice(offset, offset + MAX_JSON_CHUNK_UTF8_BYTES)
    yield new Uint8Array(await slice.arrayBuffer())
  }
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

function pushJsonDocument(file: ZipDeflate, value: unknown): void {
  let pending: string | undefined
  for (const chunk of jsonDocumentChunks(value)) {
    if (pending !== undefined) file.push(textEncoder.encode(pending), false)
    pending = chunk
  }
  file.push(textEncoder.encode(pending ?? ''), true)
}

function jsonDocumentChunks(value: unknown): Generator<string> {
  return boundedJsonChunks(jsonDocumentFragments(value))
}

function* jsonDocumentFragments(value: unknown): Generator<string> {
  const normalized = normalizeJsonValue(value, '')
  if (normalized === OMIT_JSON_VALUE) {
    yield 'undefined'
  } else {
    yield* serializeJsonValue(normalized, 0, new Set())
  }
  yield '\n'
}

function* serializeJsonValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): Generator<string> {
  if (value === null) {
    yield 'null'
    return
  }
  switch (typeof value) {
    case 'string':
      yield* serializeJsonString(value)
      return
    case 'number':
      yield Number.isFinite(value) ? String(value) : 'null'
      return
    case 'boolean':
      yield value ? 'true' : 'false'
      return
    case 'bigint':
      throw new TypeError('Do not know how to serialize a BigInt')
    case 'function':
    case 'symbol':
    case 'undefined':
      return
    case 'object':
      if (isRawJson(value)) {
        yield* stringRangeFragments(value.rawJSON, 0, value.rawJSON.length)
        return
      }
      if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON')
      ancestors.add(value)
      try {
        if (Array.isArray(value)) {
          yield* serializeJsonArray(value, depth, ancestors)
        } else {
          yield* serializeJsonObject(value, depth, ancestors)
        }
      } finally {
        ancestors.delete(value)
      }
      return
    default:
      return
  }
}

function* serializeJsonArray(
  value: readonly unknown[],
  depth: number,
  ancestors: Set<object>,
): Generator<string> {
  const length = value.length
  if (length === 0) {
    yield '[]'
    return
  }
  yield '['
  for (let index = 0; index < length; index += 1) {
    yield index === 0 ? '\n' : ',\n'
    yield* jsonIndent(depth + 1)
    const child = normalizeJsonValue(value[index], String(index))
    if (child === OMIT_JSON_VALUE) {
      yield 'null'
    } else {
      yield* serializeJsonValue(child, depth + 1, ancestors)
    }
  }
  yield '\n'
  yield* jsonIndent(depth)
  yield ']'
}

function* serializeJsonObject(
  value: object,
  depth: number,
  ancestors: Set<object>,
): Generator<string> {
  let emitted = 0
  yield '{'
  for (const key of Object.keys(value)) {
    const child = normalizeJsonValue(Reflect.get(value, key), key)
    if (child === OMIT_JSON_VALUE) continue
    yield emitted === 0 ? '\n' : ',\n'
    yield* jsonIndent(depth + 1)
    yield* serializeJsonString(key)
    yield ': '
    yield* serializeJsonValue(child, depth + 1, ancestors)
    emitted += 1
  }
  if (emitted > 0) {
    yield '\n'
    yield* jsonIndent(depth)
  }
  yield '}'
}

function normalizeJsonValue(value: unknown, key: string): unknown {
  let normalized = value
  if ((typeof normalized === 'object' && normalized !== null) || typeof normalized === 'bigint') {
    const toJson = (normalized as { toJSON?: unknown }).toJSON
    if (typeof toJson === 'function') normalized = Reflect.apply(toJson, normalized, [key])
  }
  if (typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)) {
    const prototype = Object.getPrototypeOf(normalized) as object | null
    if (prototype !== null && prototype !== Object.prototype) {
      if (prototypeContains(Number.prototype, normalized) && hasNumberData(normalized)) {
        normalized = Number(normalized)
      } else if (prototypeContains(String.prototype, normalized) && hasStringData(normalized)) {
        normalized = String.prototype.valueOf.call(normalized)
      } else if (prototypeContains(Boolean.prototype, normalized) && hasBooleanData(normalized)) {
        normalized = Boolean.prototype.valueOf.call(normalized)
      } else if (prototypeContains(BigInt.prototype, normalized) && hasBigIntData(normalized)) {
        normalized = BigInt.prototype.valueOf.call(normalized)
      }
    }
  }
  if (
    normalized === undefined ||
    typeof normalized === 'function' ||
    typeof normalized === 'symbol'
  ) {
    return OMIT_JSON_VALUE
  }
  return normalized
}

function prototypeContains(prototype: object, value: object): boolean {
  return Object.prototype.isPrototypeOf.call(prototype, value)
}

function hasNumberData(value: object): boolean {
  try {
    Number.prototype.valueOf.call(value)
    return true
  } catch {
    return false
  }
}

function hasStringData(value: object): boolean {
  try {
    String.prototype.valueOf.call(value)
    return true
  } catch {
    return false
  }
}

function hasBooleanData(value: object): boolean {
  try {
    Boolean.prototype.valueOf.call(value)
    return true
  } catch {
    return false
  }
}

function hasBigIntData(value: object): boolean {
  try {
    BigInt.prototype.valueOf.call(value)
    return true
  } catch {
    return false
  }
}

function isRawJson(value: object): value is { rawJSON: string } {
  const json = JSON as JSON & { isRawJSON?: (candidate: unknown) => boolean }
  return json.isRawJSON?.(value) === true
}

function* serializeJsonString(value: string): Generator<string> {
  yield '"'
  let runStart = 0
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    let escaped: string | undefined
    switch (code) {
      case 0x08:
        escaped = '\\b'
        break
      case 0x09:
        escaped = '\\t'
        break
      case 0x0a:
        escaped = '\\n'
        break
      case 0x0c:
        escaped = '\\f'
        break
      case 0x0d:
        escaped = '\\r'
        break
      case 0x22:
        escaped = '\\"'
        break
      case 0x5c:
        escaped = '\\\\'
        break
      default:
        if (code < 0x20 || isLoneSurrogate(value, index, code)) {
          escaped = `\\u${code.toString(16).padStart(4, '0')}`
        }
    }
    if (escaped === undefined) {
      index += isHighSurrogate(code) ? 2 : 1
      continue
    }
    yield* stringRangeFragments(value, runStart, index)
    yield escaped
    index += 1
    runStart = index
  }
  yield* stringRangeFragments(value, runStart, value.length)
  yield '"'
}

function isLoneSurrogate(value: string, index: number, code: number): boolean {
  if (isHighSurrogate(code)) {
    return index + 1 >= value.length || !isLowSurrogate(value.charCodeAt(index + 1))
  }
  return isLowSurrogate(code)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function* stringRangeFragments(value: string, start: number, end: number): Generator<string> {
  let offset = start
  while (offset < end) {
    let next = Math.min(offset + MAX_JSON_CHUNK_CODE_UNITS, end)
    if (
      next < end &&
      isHighSurrogate(value.charCodeAt(next - 1)) &&
      isLowSurrogate(value.charCodeAt(next))
    ) {
      next -= 1
    }
    yield value.slice(offset, next)
    offset = next
  }
}

function* jsonIndent(depth: number): Generator<string> {
  let spaces = depth * 2
  while (spaces > 0) {
    const count = Math.min(spaces, MAX_JSON_CHUNK_CODE_UNITS)
    yield ' '.repeat(count)
    spaces -= count
  }
}

function* boundedJsonChunks(fragments: Iterable<string>): Generator<string> {
  let parts: string[] = []
  let partLength = 0
  for (const fragment of fragments) {
    let offset = 0
    while (offset < fragment.length) {
      if (partLength === MAX_JSON_CHUNK_CODE_UNITS) {
        yield parts.join('')
        parts = []
        partLength = 0
      }
      const capacity = MAX_JSON_CHUNK_CODE_UNITS - partLength
      let next = Math.min(offset + capacity, fragment.length)
      if (
        next < fragment.length &&
        isHighSurrogate(fragment.charCodeAt(next - 1)) &&
        isLowSurrogate(fragment.charCodeAt(next))
      ) {
        next -= 1
      }
      if (next === offset) {
        yield parts.join('')
        parts = []
        partLength = 0
        continue
      }
      const part = fragment.slice(offset, next)
      parts.push(part)
      partLength += part.length
      offset = next
    }
  }
  if (partLength > 0) yield parts.join('')
}

function emptyJsonIoMetrics(): JsonIoMaterializationMetrics {
  return {
    fileDecodeChunks: 0,
    fileDecodedBytes: 0,
    maxFileDecodeChunkBytes: 0,
    zipEntryDecodeChunks: 0,
    zipEntryDecodedBytes: 0,
    maxZipEntryDecodeChunkBytes: 0,
    maxParsedZipEntriesRetained: 0,
    parsedZipEntryWrappersReleased: 0,
    zipOutputChunks: 0,
    zipOutputBytes: 0,
    zipOutputCopiedBytes: 0,
    jsonBlobParts: 0,
    maxJsonBlobPartCodeUnits: 0,
  }
}

function recordFileDecodeChunk(bytes: number): void {
  jsonIoMetrics.fileDecodeChunks += 1
  jsonIoMetrics.fileDecodedBytes += bytes
  jsonIoMetrics.maxFileDecodeChunkBytes = Math.max(jsonIoMetrics.maxFileDecodeChunkBytes, bytes)
}

function recordZipEntryDecodeChunk(bytes: number): void {
  jsonIoMetrics.zipEntryDecodeChunks += 1
  jsonIoMetrics.zipEntryDecodedBytes += bytes
  jsonIoMetrics.maxZipEntryDecodeChunkBytes = Math.max(
    jsonIoMetrics.maxZipEntryDecodeChunkBytes,
    bytes,
  )
}

function immutableZipChunk(bytes: Uint8Array): Blob {
  jsonIoMetrics.zipOutputCopiedBytes += bytes.byteLength
  if (bytes.buffer instanceof ArrayBuffer) {
    return new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)])
  }
  return new Blob([Uint8Array.from(bytes).buffer])
}
