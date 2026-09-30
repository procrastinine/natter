type LockCallback<T> = (lock: Lock | null) => T | PromiseLike<T>

type QueuedRequest = {
  readonly mode: LockMode
  readonly ifAvailable: boolean
  grant(): void
  unavailable(): void
}

export class TestWebLockManager {
  readonly attempts = new Map<string, number>()
  private readonly held = new Map<string, Set<Lock>>()
  private readonly queues = new Map<string, QueuedRequest[]>()
  private readonly scheduled = new Set<string>()

  async query(): Promise<LockManagerSnapshot> {
    return {
      held: [...this.held.values()].flatMap((locks) =>
        [...locks].map(({ name, mode }) => ({ name, mode })),
      ),
      pending: [...this.queues].flatMap(([name, requests]) =>
        requests.map(({ mode }) => ({ name, mode })),
      ),
    }
  }

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockCallback<T>,
    maybeCallback?: LockCallback<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    if (!callback) throw new Error('LockCallbackMissing')
    if (options.steal) return Promise.reject(new Error('TestWebLockStealUnsupported'))
    if (options.ifAvailable && options.signal)
      return Promise.reject(
        new DOMException('ifAvailable cannot use a signal', 'NotSupportedError'),
      )
    this.attempts.set(name, (this.attempts.get(name) ?? 0) + 1)
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(name) ?? []
      this.queues.set(name, queue)
      const request: QueuedRequest = {
        mode: options.mode ?? 'exclusive',
        ifAvailable: options.ifAvailable ?? false,
        grant: () => {
          options.signal?.removeEventListener('abort', abort)
          const lock: Lock = { name, mode: request.mode }
          const held = this.held.get(name) ?? new Set<Lock>()
          this.held.set(name, held)
          held.add(lock)
          const release = () => {
            held.delete(lock)
            if (held.size === 0) this.held.delete(name)
            this.scheduleDrain(name)
          }
          void Promise.resolve()
            .then(() => callback(lock))
            .then(
              (value) => {
                release()
                resolve(value)
              },
              (error: unknown) => {
                release()
                reject(error)
              },
            )
        },
        unavailable: () => {
          options.signal?.removeEventListener('abort', abort)
          void Promise.resolve()
            .then(() => callback(null))
            .then(resolve, reject)
        },
      }
      const abort = () => {
        const index = queue.indexOf(request)
        if (index < 0) return
        queue.splice(index, 1)
        options.signal?.removeEventListener('abort', abort)
        reject(options.signal?.reason)
        this.scheduleDrain(name)
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      queue.push(request)
      this.scheduleDrain(name)
    })
  }

  protected canGrant(name: string, mode: LockMode, _ifAvailable: boolean): boolean {
    const held = this.held.get(name)
    return (
      (held?.size ?? 0) === 0 ||
      (mode === 'shared' && [...(held ?? [])].every((lock) => lock.mode === 'shared'))
    )
  }

  private scheduleDrain(name: string): void {
    if (this.scheduled.has(name)) return
    this.scheduled.add(name)
    queueMicrotask(() => {
      this.scheduled.delete(name)
      this.drain(name)
    })
  }

  private drain(name: string): void {
    const queue = this.queues.get(name)
    while (queue?.length) {
      const request = queue[0] as QueuedRequest
      if (this.canGrant(name, request.mode, request.ifAvailable)) {
        queue.shift()
        request.grant()
      } else if (request.ifAvailable) {
        queue.shift()
        request.unavailable()
      } else {
        for (let index = 1; index < queue.length; ) {
          const pending = queue[index] as QueuedRequest
          if (pending.ifAvailable) {
            queue.splice(index, 1)
            pending.unavailable()
          } else index += 1
        }
        break
      }
    }
    if (queue?.length === 0) this.queues.delete(name)
  }
}
