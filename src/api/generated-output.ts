import {
  type GeneratedVideoJobSnapshot,
  generatedVideoJobSnapshot,
} from '../core/generated-output-localization'
import {
  fetchWithTimeout,
  readErrorResponseJson,
  readResponseBlob,
  readResponseJson,
} from './client'
import { normalizeError } from './errors'

export interface GeneratedOutputFetchOptions {
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export async function downloadGeneratedOutput(
  url: string,
  options: GeneratedOutputFetchOptions = {},
): Promise<Blob> {
  const response = await getGeneratedOutput(url, options)
  await assertGeneratedOutputResponse(response)
  return readResponseBlob(response)
}

export async function pollGeneratedVideoOutput(
  url: string,
  options: GeneratedOutputFetchOptions = {},
): Promise<GeneratedVideoJobSnapshot> {
  const response = await getGeneratedOutput(url, options)
  await assertGeneratedOutputResponse(response)
  return generatedVideoJobSnapshot(await readResponseJson<unknown>(response))
}

function getGeneratedOutput(url: string, options: GeneratedOutputFetchOptions): Promise<Response> {
  return fetchWithTimeout(
    url,
    {
      method: 'GET',
      ...(options.headers ? { headers: options.headers } : {}),
    },
    {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
  )
}

async function assertGeneratedOutputResponse(response: Response): Promise<void> {
  if (response.ok) return
  const body = await readErrorResponseJson(response)
  throw normalizeError(body, { midStream: false, httpStatus: response.status })
}
