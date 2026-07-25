import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSettingsFieldPatch } from '../core/chat-metadata'
import type { ChatId } from '../core/types'
import { configurationApplication } from '../store/configuration-application'
import { configurationController } from '../store/configuration-controller'
import type { ConfigurationEditSession } from '../store/presentation-contracts'

interface SettledConfigurationEditInput<T> {
  readonly ownerChatId?: ChatId
  readonly ownerKey?: string
  readonly fieldKey: string
  readonly storedValue: T
  readonly settleMs?: number
  readonly equal?: (left: T, right: T) => boolean
  readonly stage?: (value: T) => void
  readonly commit: (value: T) => Promise<unknown>
}

export interface SettledConfigurationEdit<T> {
  readonly value: T
  readonly setValue: (value: T) => void
  readonly acceptValue: (value: T) => void
  readonly flush: () => Promise<void>
  readonly onBlur: () => void
  readonly onPointerUp: () => void
}

interface SettledChatSettingsEditInput<T>
  extends Pick<
    SettledConfigurationEditInput<T>,
    'equal' | 'fieldKey' | 'settleMs' | 'storedValue'
  > {
  readonly chatId: ChatId
  readonly patches: (value: T) => readonly ChatSettingsFieldPatch[]
  readonly cancelModelResolution?: boolean
}

export function useSettledConfigurationEdit<T>(
  input: SettledConfigurationEditInput<T>,
): SettledConfigurationEdit<T> {
  const equal = input.equal ?? Object.is
  const [value, setValueState] = useState(input.storedValue)
  const valueRef = useRef(input.storedValue)
  const acceptedStoredRef = useRef(input.storedValue)
  const lastEnqueuedRef = useRef<T | undefined>(undefined)
  const hasEnqueuedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const tailRef = useRef<Promise<void>>(Promise.resolve())
  const sessionRef = useRef<ConfigurationEditSession | null>(null)
  const inputRef = useRef(input)
  inputRef.current = input
  const equalRef = useRef(equal)
  equalRef.current = equal
  const workspaceFenceRef = useRef(workspaceFenceKey())

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const flush = useCallback(async () => {
    clearTimer()
    if (workspaceFenceKey() !== workspaceFenceRef.current) return
    const next = valueRef.current
    const lastEnqueued = lastEnqueuedRef.current
    if (hasEnqueuedRef.current && equalRef.current(lastEnqueued, next)) {
      await tailRef.current
      return
    }
    if (equalRef.current(acceptedStoredRef.current, next)) {
      await tailRef.current
      return
    }
    lastEnqueuedRef.current = next
    hasEnqueuedRef.current = true
    const operation = tailRef.current
      .catch(() => undefined)
      .then(async () => {
        if (workspaceFenceKey() !== workspaceFenceRef.current) return
        await inputRef.current.commit(next)
        acceptedStoredRef.current = next
      })
      .finally(() => {
        if (hasEnqueuedRef.current && equalRef.current(lastEnqueuedRef.current, next)) {
          hasEnqueuedRef.current = false
          lastEnqueuedRef.current = undefined
        }
      })
    const tracked = sessionRef.current?.track(operation) ?? operation
    tailRef.current = tracked.then(
      () => undefined,
      () => undefined,
    )
    await tracked
  }, [clearTimer])

  const flushRef = useRef(flush)
  flushRef.current = flush

  const schedule = useCallback(() => {
    clearTimer()
    const settleMs = inputRef.current.settleMs ?? 200
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void flushRef.current().catch(() => undefined)
    }, settleMs)
  }, [clearTimer])

  const setValue = useCallback(
    (next: T) => {
      if (workspaceFenceKey() !== workspaceFenceRef.current) return
      valueRef.current = next
      setValueState(next)
      inputRef.current.stage?.(next)
      schedule()
    },
    [schedule],
  )

  const acceptValue = useCallback(
    (next: T) => {
      clearTimer()
      acceptedStoredRef.current = next
      lastEnqueuedRef.current = undefined
      hasEnqueuedRef.current = false
      valueRef.current = next
      setValueState(next)
    },
    [clearTimer],
  )

  useEffect(() => {
    if (workspaceFenceKey() !== workspaceFenceRef.current) return
    const dirty = !equal(valueRef.current, acceptedStoredRef.current)
    if (!equal(acceptedStoredRef.current, input.storedValue)) {
      acceptedStoredRef.current = input.storedValue
    }
    if (dirty || hasEnqueuedRef.current) return
    valueRef.current = input.storedValue
    setValueState(input.storedValue)
  }, [equal, input.storedValue])

  useEffect(() => {
    workspaceFenceRef.current = workspaceFenceKey()
    if (input.ownerChatId || input.ownerKey) {
      const session = configurationController.openEditSession({
        ...(input.ownerChatId ? { chatId: input.ownerChatId } : {}),
        ...(input.ownerKey ? { ownerKey: input.ownerKey } : {}),
        fieldKey: input.fieldKey,
        flush: () => flushRef.current(),
      })
      sessionRef.current = session
      return () => {
        clearTimer()
        if (sessionRef.current === session) sessionRef.current = null
        void session.close('flush').catch(() => undefined)
      }
    }
    return () => {
      clearTimer()
      void flushRef.current().catch(() => undefined)
    }
  }, [clearTimer, input.fieldKey, input.ownerChatId, input.ownerKey])

  return {
    value,
    setValue,
    acceptValue,
    flush,
    onBlur: () => void flush().catch(() => undefined),
    onPointerUp: () => void flush().catch(() => undefined),
  }
}

export function useSettledChatSettingsEdit<T>(
  input: SettledChatSettingsEditInput<T>,
): SettledConfigurationEdit<T> {
  const patchesRef = useRef(input.patches)
  patchesRef.current = input.patches
  return useSettledConfigurationEdit({
    ownerChatId: input.chatId,
    fieldKey: input.fieldKey,
    storedValue: input.storedValue,
    ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
    ...(input.equal === undefined ? {} : { equal: input.equal }),
    stage(value) {
      configurationController.stageChatSettingsFields(input.chatId, patchesRef.current(value))
    },
    async commit(value) {
      await configurationApplication.patchChatSettingsFields(
        input.chatId,
        patchesRef.current(value),
        {
          ...(input.cancelModelResolution === undefined
            ? {}
            : { cancelModelResolution: input.cancelModelResolution }),
        },
      )
    },
  })
}

function workspaceFenceKey(): string {
  const fence = configurationController.getSnapshot().workspaceFence
  return fence ? `${fence.workspaceId}:${fence.replacementEpoch}` : 'unreconciled'
}
