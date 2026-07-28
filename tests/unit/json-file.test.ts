// @vitest-environment node

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceReplacementCommittedRecoveryRequiredError,
  WorkspaceReplacementOutcomeUnknownError,
  WorkspaceReplacementUncommittedRecoveryRequiredError,
} from '../../src/core/import-export/errors'
import {
  __jsonDocumentChunksForTests,
  __jsonIoMaterializationMetricsForTests,
  __resetJsonIoMaterializationMetricsForTests,
  importExportErrorMessage,
  jsonDocumentBlob,
  jsonEntriesZipBlob,
  readJsonFile,
  readJsonOrZipFile,
} from '../../src/ui/import-export/json-file'

function serialized(value: unknown): string {
  return __jsonDocumentChunksForTests(value).join('')
}

function nativeSerialized(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown
}

describe('workspace replacement recovery diagnostics', () => {
  it('distinguishes committed, uncommitted, and unknown recovery states', () => {
    expect(
      importExportErrorMessage(
        new WorkspaceReplacementCommittedRecoveryRequiredError(
          { workspaceId: 'after', replacementEpoch: 2 },
          [new Error('reopen failed')],
        ),
      ),
    ).toContain('committed')
    expect(
      importExportErrorMessage(
        new WorkspaceReplacementUncommittedRecoveryRequiredError([new Error('reopen failed')]),
      ),
    ).toContain('did not commit')
    expect(
      importExportErrorMessage(
        new WorkspaceReplacementOutcomeUnknownError([new Error('inspection failed')]),
      ),
    ).toContain('could not be confirmed')
  })

  it('turns internal import validation failures into one actionable boundary error', () => {
    expect(importExportErrorMessage(new Error('ImportRowInvalid:chat.presetId'))).toBe(
      'The selected file is not a valid Natter export, so nothing was imported.',
    )
  })
})

describe('incremental JSON export', () => {
  it('round-trips nested export-shaped values with native property order and formatting', () => {
    const value = {
      format: 'natter-export',
      formatVersion: 3,
      objectKind: 'workspace',
      exportedAt: '2026-07-12T00:00:00.000Z',
      payload: {
        workspaceId: 'workspace:test',
        chats: [
          {
            id: 'chat-1',
            title: 'One',
            messages: [
              { id: 'message-1', role: 'user', content: 'Hello' },
              { id: 'message-2', role: 'assistant', content: 'World' },
            ],
          },
        ],
        numericKeys: { 10: 'ten', 2: 'two', later: true },
        finite: 12.5,
        negativeZero: -0,
        nonFinite: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        date: new Date('2026-07-12T01:02:03.004Z'),
        wrappers: [new Number(2), new String('text'), new Boolean(false)],
        custom: {
          toJSON(key: string) {
            return { key, accepted: true }
          },
        },
      },
    }

    const document = serialized(value)
    expect(document).toBe(nativeSerialized(value))
    expect(JSON.parse(document)).toEqual(JSON.parse(nativeSerialized(value)))
  })

  it('matches native escaping for control characters, quotes, slashes, and lone surrogates', () => {
    const value = {
      'key"\\\ud800': '\u0000\b\t\n\f\r\u001f"\\/\ud800\udc00\ud800\udc00\u2028\u2029',
      loneHigh: '\ud800',
      loneLow: '\udc00',
    }

    const document = serialized(value)
    expect(document).toBe(nativeSerialized(value))
    expect(JSON.parse(document)).toEqual(value)
  })

  it('uses native omission and array-null behavior for unsupported values', () => {
    const functionValue = () => 'unused'
    const symbolValue = Symbol('unused')
    const value = {
      keep: true,
      undefinedValue: undefined,
      functionValue,
      symbolValue,
      array: [undefined, functionValue, symbolValue, 'kept'],
    }

    expect(serialized(value)).toBe(nativeSerialized(value))
    expect(serialized(undefined)).toBe('undefined\n')
    expect(serialized(functionValue)).toBe('undefined\n')
    expect(serialized(symbolValue)).toBe('undefined\n')
  })

  it('throws for cyclic and BigInt values', async () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(() => serialized(cyclic)).toThrow(TypeError)
    expect(() => serialized({ value: 1n })).toThrow(TypeError)
    await expect(jsonEntriesZipBlob([{ filename: 'cyclic.json', value: cyclic }])).rejects.toThrow(
      TypeError,
    )
  })

  it('writes ZIP entries sequentially with stable names and input order', async () => {
    const values = [{ ordinal: 1 }, { ordinal: 2 }, { ordinal: 3 }]
    const blob = await jsonEntriesZipBlob([
      { filename: 'chat.json', value: values[0] },
      { filename: 'CHAT.JSON', value: values[1] },
      { filename: 'folder/third', value: values[2] },
    ])
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))

    expect(Object.keys(entries)).toEqual(['chat.json', 'CHAT-2.JSON', 'folder-third.json'])
    expect(Object.values(entries).map((bytes) => parseJson(strFromU8(bytes)))).toEqual(values)
    expect(blob.type).toBe('application/zip')
  })

  it('serializes each lazy ZIP value before loading the next one', async () => {
    const events: string[] = []
    await jsonEntriesZipBlob(
      [1, 2, 3].map((ordinal) => ({
        filename: `${ordinal}.json`,
        async loadValue() {
          events.push(`load:${ordinal}`)
          return {
            toJSON() {
              events.push(`serialize:${ordinal}`)
              return { ordinal }
            },
          }
        },
      })),
    )

    expect(events).toEqual([
      'load:1',
      'serialize:1',
      'load:2',
      'serialize:2',
      'load:3',
      'serialize:3',
    ])
  })

  it('streams ZIP bytes and preserves the existing filename-sorted import order', async () => {
    const values = [
      { ordinal: 2, payload: 'z'.repeat(400_000) },
      { ordinal: 1, payload: 'a'.repeat(400_000) },
    ]
    const blob = await jsonEntriesZipBlob([
      { filename: 'zeta.json', value: values[0] },
      { filename: 'alpha.json', value: values[1] },
    ])
    const file = new File([blob], 'chats.zip', { type: 'application/zip' })
    const arrayBuffer = vi
      .spyOn(file, 'arrayBuffer')
      .mockRejectedValue(new Error('streaming path must not materialize the ZIP'))

    const imported = await readJsonOrZipFile(file)

    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(imported).toEqual([values[1], values[0]])
  })

  it('streams a large plain JSON file without file.text or whole-file arrayBuffer', async () => {
    const value = { payload: 'streamed-json-'.repeat(200_000) }
    const file = new File([JSON.stringify(value)], 'workspace.json', {
      type: 'application/json',
    })
    const text = vi.spyOn(file, 'text').mockRejectedValue(new Error('file.text is forbidden'))
    const arrayBuffer = vi
      .spyOn(file, 'arrayBuffer')
      .mockRejectedValue(new Error('whole-file arrayBuffer is forbidden'))
    __resetJsonIoMaterializationMetricsForTests()

    const imported = await readJsonFile(file)
    const metrics = __jsonIoMaterializationMetricsForTests()

    expect(imported).toEqual(value)
    expect(text).not.toHaveBeenCalled()
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(metrics.fileDecodeChunks).toBeGreaterThan(10)
    expect(metrics.maxFileDecodeChunkBytes).toBeLessThanOrEqual(64 * 1024)
    expect(metrics.fileDecodedBytes).toBe(file.size)
  })

  it('returns filename-sorted ZIP values and releases entry wrappers', async () => {
    const blob = await jsonEntriesZipBlob([
      { filename: 'zeta.json', value: { ordinal: 2 } },
      { filename: 'alpha.json', value: { ordinal: 1 } },
    ])
    const file = new File([blob], 'ordered.zip', { type: 'application/zip' })
    __resetJsonIoMaterializationMetricsForTests()

    const values = await readJsonOrZipFile(file)
    const metrics = __jsonIoMaterializationMetricsForTests()

    expect(values).toEqual([{ ordinal: 1 }, { ordinal: 2 }])
    expect(metrics.maxParsedZipEntriesRetained).toBe(2)
    expect(metrics.parsedZipEntryWrappersReleased).toBe(2)
  })

  it('rejects the whole ZIP when any JSON entry is invalid', async () => {
    const file = new File(
      [
        zipSync({
          'alpha.json': strToU8('{"ordinal":1}'),
          'zeta.json': strToU8('{'),
        }),
      ],
      'invalid-later.zip',
      { type: 'application/zip' },
    )
    await expect(readJsonOrZipFile(file)).rejects.toThrow('zeta.json is not valid JSON.')
  })

  it('assembles JSON and ZIP blobs from immutable parts without a final byte copy', async () => {
    const value = { payload: '漢😀'.repeat(100_000) }
    __resetJsonIoMaterializationMetricsForTests()

    const jsonBlob = jsonDocumentBlob(value)
    const zipBlob = await jsonEntriesZipBlob([{ filename: 'large.json', value }])
    const metrics = __jsonIoMaterializationMetricsForTests()
    const zipEntry = unzipSync(new Uint8Array(await zipBlob.arrayBuffer()))['large.json']

    expect(JSON.parse(await jsonBlob.text())).toEqual(value)
    expect(zipEntry).toBeDefined()
    if (zipEntry === undefined) throw new Error('large.json missing from ZIP')
    expect(JSON.parse(strFromU8(zipEntry))).toEqual(value)
    expect(metrics.jsonBlobParts).toBeGreaterThan(10)
    expect(metrics.zipOutputChunks).toBeGreaterThan(0)
    expect(metrics.zipOutputBytes).toBe(zipBlob.size)
    expect(metrics.zipOutputCopiedBytes).toBe(zipBlob.size)
  })

  it('bounds JSON and UTF-8 chunks for a multi-megabyte Unicode string', async () => {
    const payload = '漢😀'.repeat(800_000)
    const stringify = vi.spyOn(JSON, 'stringify')
    const chunks = __jsonDocumentChunksForTests({ payload })
    const stringifyCalls = stringify.mock.calls.length
    stringify.mockRestore()
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    await jsonEntriesZipBlob([{ filename: 'large.json', value: { payload } }])
    const encodedChunkSizes = encode.mock.results.map((result) => {
      if (result.type === 'throw') throw result.value
      return (result.value as Uint8Array).byteLength
    })
    encode.mockRestore()
    const encoder = new TextEncoder()

    expect(stringifyCalls).toBe(0)
    expect(chunks.length).toBeGreaterThan(100)
    expect(
      Math.max(...chunks.map((chunk) => encoder.encode(chunk).byteLength)),
    ).toBeLessThanOrEqual(64 * 1024)
    expect(encodedChunkSizes.length).toBeGreaterThanOrEqual(chunks.length)
    expect(Math.max(...encodedChunkSizes)).toBeLessThanOrEqual(64 * 1024)
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1] as string
      const current = chunks[index] as string
      const previousLast = previous.charCodeAt(previous.length - 1)
      const currentFirst = current.charCodeAt(0)
      expect(previousLast < 0xd800 || previousLast > 0xdbff).toBe(true)
      expect(currentFirst < 0xdc00 || currentFirst > 0xdfff).toBe(true)
    }
    expect((JSON.parse(chunks.join('')) as { payload: string }).payload).toBe(payload)
  })
})
