import { errorFromUnknown } from '../lib/error'

type AdapterStream<Item> = AsyncGenerator<Item, void, unknown>

interface RequestState {
  pending: boolean
}

const requestStates = import.meta.env.DEV ? new WeakMap<object, RequestState>() : undefined

export function deferAdapterRequest<Request, Item>(
  request: Request,
  open: (request: Request) => AdapterStream<Item>,
): AdapterStream<Item> {
  let pendingRequest: Request | undefined = request
  let pendingOpen: ((request: Request) => AdapterStream<Item>) | undefined = open
  let delegate: AdapterStream<Item> | undefined
  let closedBeforeOpen = false
  const state: RequestState = { pending: true }

  const releasePending = () => {
    pendingRequest = undefined
    pendingOpen = undefined
    state.pending = false
  }

  const openDelegate = (): AdapterStream<Item> => {
    if (delegate) return delegate
    try {
      delegate = (pendingOpen as (request: Request) => AdapterStream<Item>)(
        pendingRequest as Request,
      )
      return delegate
    } catch (error) {
      closedBeforeOpen = true
      throw error
    } finally {
      releasePending()
    }
  }

  const iterator = {
    next(value?: unknown) {
      if (closedBeforeOpen) return Promise.resolve({ done: true, value: undefined })
      try {
        return openDelegate().next(value)
      } catch (error) {
        return Promise.reject(errorFromUnknown(error))
      }
    },
    return(value?: void | PromiseLike<void>) {
      if (!delegate) {
        closedBeforeOpen = true
        releasePending()
        return Promise.resolve(value).then((resolved) => ({ done: true, value: resolved }))
      }
      return delegate.return(value)
    },
    throw(error?: unknown) {
      if (!delegate) {
        closedBeforeOpen = true
        releasePending()
        return Promise.reject(errorFromUnknown(error))
      }
      return delegate.throw(error)
    },
    [Symbol.asyncIterator]() {
      return this
    },
  } as AdapterStream<Item>

  const asyncDispose = (Symbol as SymbolConstructor & { asyncDispose?: symbol }).asyncDispose
  if (asyncDispose) {
    Object.defineProperty(iterator, asyncDispose, {
      value: async () => {
        await iterator.return(undefined)
      },
    })
  }

  requestStates?.set(iterator, state)
  return iterator
}

export function __adapterRequestPendingForTests(stream: object): boolean | undefined {
  return requestStates?.get(stream)?.pending
}
