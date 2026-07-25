let yieldChannel: MessageChannel | null = null
const yieldResolvers: Array<() => void> = []

export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  const scheduler = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } })
    .scheduler
  if (typeof scheduler?.yield === 'function') {
    try {
      await settleYield(scheduler.yield(), signal)
      return
    } catch {
      if (signal?.aborted) return
    }
  }
  if (typeof MessageChannel !== 'undefined') {
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const scheduled = () => finish()
      const abort = () => {
        const index = yieldResolvers.indexOf(scheduled)
        if (index >= 0) yieldResolvers.splice(index, 1)
        finish()
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
        return
      }
      yieldResolvers.push(scheduled)
      if (yieldResolvers.length > 1) return
      yieldChannel ??= new MessageChannel()
      yieldChannel.port1.onmessage = () => {
        const next = yieldResolvers.shift()
        next?.()
        if (yieldResolvers.length > 0) yieldChannel?.port2.postMessage(undefined)
      }
      yieldChannel.port2.postMessage(undefined)
    })
    return
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const timer = setTimeout(finish, 0)
    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted) finish()
  })
}

function settleYield(yielded: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return yielded
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      operation()
    }
    const abort = () => finish(resolve)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void yielded.then(
      () => finish(resolve),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error ? error : new Error('EventLoopYieldFailed', { cause: error }),
          ),
        ),
    )
  })
}
