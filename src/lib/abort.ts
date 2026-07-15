import { errorFromUnknown } from './error'

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Request aborted.', 'AbortError')
}

export function raceWithAbortSignal<T>(
  start: () => T | PromiseLike<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    try {
      return Promise.resolve(start())
    } catch (error) {
      return Promise.reject(errorFromUnknown(error))
    }
  }
  if (signal.aborted) return Promise.reject(abortError(signal))

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (publish: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      publish()
    }
    const onAbort = () => finish(() => reject(abortError(signal)))
    signal.addEventListener('abort', onAbort, { once: true })

    let pending: T | PromiseLike<T>
    try {
      pending = start()
    } catch (error) {
      finish(() => reject(errorFromUnknown(error)))
      return
    }
    void Promise.resolve(pending).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(errorFromUnknown(error))),
    )
  })
}
