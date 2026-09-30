export function installNativeWorkspaceStorageFixture() {
  if (globalThis.__natterNativeStorageFixture) return
  const lifetime = new AbortController()
  const holds = new Map()
  let nextHold = 0
  const purposes = new Set([
    'read-only-assertion',
    'fault-injection',
    'legacy-fixture',
    'physical-reclamation',
    'reset',
  ])
  const aborted = (signal) =>
    signal.reason ?? new DOMException('Fixture operation aborted', 'AbortError')
  const requestResult = (request) =>
    new Promise((resolve, reject) => {
      const clear = () => {
        request.removeEventListener('success', success)
        request.removeEventListener('error', error)
      }
      const success = () => {
        const value = request.result
        clear()
        resolve(value)
      }
      const error = () => {
        const failure = request.error
        clear()
        reject(failure)
      }
      request.addEventListener('success', success)
      request.addEventListener('error', error)
    })
  const operation = async (options, run) => {
    if (!purposes.has(options.purpose)) throw new Error('NativeFixturePurposeInvalid')
    const controller = new AbortController()
    const sources = [lifetime.signal, options.signal].filter(Boolean)
    const abort = (event) => controller.abort(event.target.reason)
    for (const signal of sources) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', abort, { once: true })
    }
    try {
      controller.signal.throwIfAborted()
      return await run(controller.signal)
    } finally {
      for (const signal of sources) signal.removeEventListener('abort', abort)
    }
  }
  /** @returns {Promise<IDBDatabase>} */
  const open = (databaseName, signal, upgrade) =>
    new Promise((resolve, reject) => {
      signal.throwIfAborted()
      const request = upgrade
        ? indexedDB.open(databaseName, upgrade.version)
        : indexedDB.open(databaseName)
      let settled = false
      let upgrading = null
      let upgradeFailure = null
      const clear = () => {
        request.onsuccess = null
        request.onerror = null
        request.onblocked = null
        request.onupgradeneeded = null
        signal.removeEventListener('abort', cancel)
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const cancel = () => {
        if (upgrading) upgrading.abort()
        fail(aborted(signal))
      }
      signal.addEventListener('abort', cancel, { once: true })
      request.onupgradeneeded = (event) => {
        upgrading = request.transaction
        if (settled || !upgrade || signal.aborted) {
          upgradeFailure = signal.aborted
            ? aborted(signal)
            : new Error(`NativeFixtureDatabaseMissing:${databaseName}`)
          upgrading.abort()
          return
        }
        try {
          upgrade.run(request.result, request.transaction, event.oldVersion, event.newVersion)
        } catch (error) {
          upgradeFailure = error
          upgrading.abort()
        }
      }
      request.onblocked = () => fail(new Error(`NativeFixtureDatabaseOpenBlocked:${databaseName}`))
      request.onerror = () => {
        fail(upgradeFailure ?? request.error)
        clear()
      }
      request.onsuccess = () => {
        const database = request.result
        clear()
        if (settled || signal.aborted) {
          database.close()
          fail(aborted(signal))
          return
        }
        settled = true
        database.onversionchange = () => database.close()
        resolve(database)
      }
    })
  /** @param {import('./native-workspace-storage-fixture.mjs').NativeFixtureCallback<unknown>} callback */
  const runDatabaseOperation = async (
    databaseName,
    options,
    signal,
    binding,
    callback,
    upgrade,
  ) => {
    const database = await open(databaseName, signal, upgrade)
    /** @type {Map<IDBTransaction, Promise<void>>} */
    const transactions = new Map()
    const requests = new Set()
    const read = (request) => {
      if (!accepting || signal.aborted) throw new Error('NativeFixtureOperationClosed')
      const result = requestResult(request)
      void result.catch(fail)
      requests.add(result)
      return result
    }
    let accepting = true
    let rejectFailure
    const failure = new Promise((_, reject) => {
      rejectFailure = reject
    })
    const fail = (error) => {
      accepting = false
      rejectFailure(error)
    }
    const cancel = () => {
      accepting = false
      for (const transaction of transactions.keys()) {
        try {
          transaction.abort()
        } catch {}
      }
      rejectFailure(aborted(signal))
    }
    const facade = Object.freeze({
      name: database.name,
      version: database.version,
      objectStoreNames: database.objectStoreNames,
      completion(transaction) {
        const terminal = transactions.get(transaction)
        if (!terminal) throw new Error('NativeFixtureTransactionNotOwned')
        return terminal
      },
      transaction(stores, mode = 'readonly', transactionOptions) {
        if (!accepting || signal.aborted) throw new Error('NativeFixtureOperationClosed')
        if (mode !== 'readonly' && options.purpose === 'read-only-assertion') {
          throw new Error('NativeFixtureReadOnlyMutation')
        }
        const transaction = database.transaction(stores, mode, transactionOptions)
        const terminal = new Promise((resolve, reject) => {
          let requestFailure = null
          const error = (event) => {
            requestFailure ??= event.target.error
          }
          const clear = () => {
            transaction.removeEventListener('complete', complete)
            transaction.removeEventListener('abort', abort)
            transaction.removeEventListener('error', error, true)
          }
          const complete = () => {
            clear()
            if (requestFailure) reject(requestFailure)
            else resolve()
          }
          const abort = () => {
            clear()
            reject(
              transaction.error ?? new DOMException('Fixture transaction aborted', 'AbortError'),
            )
          }
          transaction.addEventListener('complete', complete)
          transaction.addEventListener('abort', abort)
          transaction.addEventListener('error', error, true)
        })
        void terminal.catch(fail)
        transactions.set(transaction, terminal)
        return transaction
      },
    })
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const result = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted()
          return callback(facade, read, binding)
        }),
        failure,
      ])
      accepting = false
      await Promise.all([...transactions.values(), ...requests])
      signal.throwIfAborted()
      return result
    } catch (error) {
      accepting = false
      for (const transaction of transactions.keys()) {
        try {
          transaction.abort()
        } catch {}
      }
      await Promise.allSettled([...transactions.values(), ...requests])
      throw error
    } finally {
      accepting = false
      signal.removeEventListener('abort', cancel)
      database.close()
    }
  }
  const identity = (signal) =>
    runDatabaseOperation(
      'natter-control',
      { purpose: 'read-only-assertion' },
      signal,
      null,
      async (database, request) => {
        const manifest = await request(
          database.transaction('manifests').objectStore('manifests').get('workspace'),
        )
        if (
          typeof manifest?.activeDatabaseName !== 'string' ||
          !Number.isSafeInteger(manifest.activationSequence) ||
          manifest.activationSequence < 0
        ) {
          throw new Error('NativeFixtureWorkspaceIdentityInvalid')
        }
        return Object.freeze({
          databaseName: manifest.activeDatabaseName,
          activationSequence: manifest.activationSequence,
        })
      },
    )
  /** @param {import('./native-workspace-storage-fixture.mjs').NativeFixtureCallback<unknown>} callback */
  const active = (options, callback) =>
    operation(options, async (signal) => {
      for (;;) {
        signal.throwIfAborted()
        const candidate = await identity(signal)
        const attempt = await navigator.locks.request(
          `natter:workspace-slot:${candidate.databaseName}`,
          { mode: 'shared', signal },
          async () => {
            const current = await identity(signal)
            if (
              candidate.databaseName !== current.databaseName ||
              candidate.activationSequence !== current.activationSequence
            ) {
              return { kind: 'changed' }
            }
            return {
              kind: 'completed',
              value: await runDatabaseOperation(
                candidate.databaseName,
                options,
                signal,
                candidate,
                callback,
              ),
            }
          },
        )
        if (attempt.kind === 'completed') return attempt.value
      }
    })
  const driver = Object.freeze({
    active,
    control: (options, callback) =>
      operation(options, (signal) =>
        runDatabaseOperation('natter-control', options, signal, null, callback),
      ),
    observeNamed: (options, callback) =>
      operation(options, (signal) => {
        if (options.purpose !== 'read-only-assertion')
          throw new Error('NativeFixtureNamedObservationPurposeInvalid')
        return runDatabaseOperation(options.databaseName, options, signal, null, callback)
      }),
    offline: (options, callback) =>
      operation(options, (signal) => {
        if (
          !['legacy-fixture', 'reset', 'physical-reclamation', 'fault-injection'].includes(
            options.purpose,
          )
        )
          throw new Error('NativeFixtureOfflinePurposeInvalid')
        return runDatabaseOperation(
          options.databaseName,
          options,
          signal,
          null,
          callback,
          options.upgrade ? { version: options.version, run: options.upgrade } : undefined,
        )
      }),
    deleteOffline: (options) =>
      operation(
        options,
        (signal) =>
          new Promise((resolve, reject) => {
            if (!['legacy-fixture', 'reset', 'physical-reclamation'].includes(options.purpose))
              throw new Error('NativeFixtureOfflinePurposeInvalid')
            signal.throwIfAborted()
            const request = indexedDB.deleteDatabase(options.databaseName)
            request.onsuccess = () => resolve()
            request.onerror = () => reject(request.error)
            request.onblocked = () =>
              reject(new Error(`NativeFixtureDatabaseDeleteBlocked:${options.databaseName}`))
          }),
      ),
    databaseNames: async () =>
      (await indexedDB.databases()).flatMap(({ name }) => (name === undefined ? [] : [name])),
    readActiveIdentity: () => operation({ purpose: 'read-only-assertion' }, identity),
    async holdActiveStores(storeNames) {
      if (storeNames.length === 0) throw new Error('NativeFixtureHoldRequiresStore')
      const id = `native-storage-hold:${++nextHold}`
      const controller = new AbortController()
      let released = false
      let resolveReady
      let rejectReady
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const complete = active(
        { purpose: 'fault-injection', signal: controller.signal },
        (database, _request, binding) => {
          const transaction = database.transaction([...storeNames], 'readwrite')
          const store = transaction.objectStore(storeNames[0])
          return new Promise((resolve, reject) => {
            const keepAlive = () => {
              const request = store.get('__native_fixture_gate__')
              request.onsuccess = () => {
                resolveReady({ id, binding })
                if (released) resolve()
                else keepAlive()
              }
              request.onerror = () => reject(request.error)
            }
            transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
            keepAlive()
          })
        },
      )
      const hold = {
        complete,
        controller,
        release: () => {
          released = true
        },
        releasePromise: null,
      }
      holds.set(id, hold)
      void complete.catch(rejectReady)
      try {
        return await ready
      } catch (error) {
        holds.delete(id)
        throw error
      }
    },
    async holdNamed(options) {
      if (options.purpose !== 'physical-reclamation')
        throw new Error('NativeFixtureHoldPurposeInvalid')
      const id = `native-storage-hold:${++nextHold}`
      const controller = new AbortController()
      let resolveReady
      let rejectReady
      let release
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const released = new Promise((resolve) => {
        release = resolve
      })
      const complete = operation({ ...options, signal: controller.signal }, async (signal) => {
        const database = await open(options.databaseName, signal)
        database.onversionchange = () => undefined
        let rejectAbort
        const cancellation = new Promise((_, reject) => {
          rejectAbort = reject
        })
        const cancel = () => rejectAbort(aborted(signal))
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          resolveReady({ id })
          await Promise.race([released, cancellation])
        } finally {
          signal.removeEventListener('abort', cancel)
          database.close()
        }
      })
      holds.set(id, { complete, controller, release, releasePromise: null })
      void complete.catch(rejectReady)
      try {
        return await ready
      } catch (error) {
        holds.delete(id)
        throw error
      }
    },
    release(id) {
      const hold = holds.get(id)
      if (!hold) throw new Error(`NativeFixtureHoldMissing:${id}`)
      if (!hold.releasePromise) {
        hold.release()
        hold.releasePromise = hold.complete.finally(() => holds.delete(id))
      }
      return hold.releasePromise
    },
    cancel(id) {
      const hold = holds.get(id)
      if (!hold) throw new Error(`NativeFixtureHoldMissing:${id}`)
      hold.controller.abort()
      return this.release(id)
    },
    dispose() {
      globalThis.removeEventListener?.('pagehide', onPageHide)
      lifetime.abort()
    },
  })
  Object.defineProperty(globalThis, '__natterNativeStorageFixture', {
    configurable: true,
    value: driver,
  })
  const onPageHide = () => driver.dispose()
  globalThis.addEventListener?.('pagehide', onPageHide, { once: true })
}
