import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatSettingsFieldPatch } from '../core/chat-metadata'
import type { ChatId } from '../core/types'
import { configurationApplication } from '../store/configuration-application'
import { configurationController } from '../store/configuration-controller'
import type { PreparedConfigurationEdit } from '../store/configuration-domain'
import type { ConfigurationEditSession } from '../store/presentation-contracts'
import { useToastStore } from '../store/zustand/toastStore'

interface SettledConfigurationEditOwner<T> {
  readonly ownerChatId?: ChatId
  readonly ownerKey?: string
  readonly fieldKey: string
  readonly storedValue: T
  readonly settleMs?: number
  readonly equal?: (left: T, right: T) => boolean
}

type SettledConfigurationEditInput<T> = SettledConfigurationEditOwner<T> &
  (
    | { readonly prepare: (value: T) => PreparedConfigurationEdit; readonly commit?: never }
    | { readonly prepare?: never; readonly commit: (value: T) => Promise<unknown> }
  )

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

interface PendingConfigurationEdit {
  readonly prepared: PreparedConfigurationEdit
  readonly prepare: () => PreparedConfigurationEdit
  readonly ownerKey: string
}

export function useSettledConfigurationEdit<T>(
  input: SettledConfigurationEditInput<T>,
): SettledConfigurationEdit<T> {
  const equal = input.equal ?? Object.is
  const [value, setValueState] = useState(input.storedValue)
  const valueRef = useRef(input.storedValue)
  const pendingRef = useRef<PendingConfigurationEdit | null>(null)
  const inFlightRef = useRef(0)
  const mountedRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const tailRef = useRef<Promise<void>>(Promise.resolve())
  const sessionRef = useRef<ConfigurationEditSession | null>(null)
  const inputRef = useRef(input)
  inputRef.current = input
  const equalRef = useRef(equal)
  equalRef.current = equal
  const workspaceFenceRef = useRef(workspaceFenceKey())
  const pushToast = useToastStore((state) => state.push)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const flush = useCallback(async () => {
    clearTimer()
    const pending = pendingRef.current
    pendingRef.current = null
    if (workspaceFenceKey() !== workspaceFenceRef.current) {
      pending?.prepared.discard()
      return
    }
    if (!pending) {
      await tailRef.current
      return
    }
    const fence = workspaceFenceRef.current
    inFlightRef.current += 1
    const operation = tailRef.current
      .catch(() => undefined)
      .then(async () => {
        if (workspaceFenceKey() !== fence) {
          pending.prepared.discard()
          return
        }
        await pending.prepared.commit()
      })
      .catch((error: unknown) => {
        if (
          mountedRef.current &&
          workspaceFenceKey() === fence &&
          configurationEditOwnerKey(inputRef.current) === pending.ownerKey &&
          !pendingRef.current &&
          inFlightRef.current === 1
        ) {
          pendingRef.current = { ...pending, prepared: pending.prepare() }
        }
        pushToast({ level: 'danger', text: 'Could not save settings. Please try again.' })
        throw error
      })
      .finally(() => {
        inFlightRef.current -= 1
      })
    const tracked = sessionRef.current?.track(operation) ?? operation
    tailRef.current = tracked
    const releaseTail = () => {
      if (tailRef.current === tracked) tailRef.current = Promise.resolve()
    }
    void tracked.then(releaseTail, releaseTail)
    await tracked
  }, [clearTimer, pushToast])

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
      if (equalRef.current(valueRef.current, next)) return
      const owner = inputRef.current
      const previous = pendingRef.current
      valueRef.current = next
      setValueState(next)
      const prepare = () =>
        owner.prepare
          ? owner.prepare(next)
          : { commit: () => owner.commit(next), discard: () => undefined }
      pendingRef.current = {
        prepared: prepare(),
        prepare,
        ownerKey: configurationEditOwnerKey(owner),
      }
      previous?.prepared.discard()
      schedule()
    },
    [schedule],
  )

  const acceptValue = useCallback(
    (next: T) => {
      clearTimer()
      pendingRef.current?.prepared.discard()
      pendingRef.current = null
      valueRef.current = next
      setValueState(next)
    },
    [clearTimer],
  )

  useEffect(() => {
    if (workspaceFenceKey() !== workspaceFenceRef.current) return
    if (pendingRef.current || inFlightRef.current > 0) return
    valueRef.current = input.storedValue
    setValueState(input.storedValue)
  }, [input.storedValue])

  useEffect(() => {
    mountedRef.current = true
    workspaceFenceRef.current = workspaceFenceKey()
    valueRef.current = inputRef.current.storedValue
    setValueState(inputRef.current.storedValue)
    if (input.ownerChatId || input.ownerKey) {
      const session = configurationController.openEditSession({
        ...(input.ownerChatId ? { chatId: input.ownerChatId } : {}),
        ...(input.ownerKey ? { ownerKey: input.ownerKey } : {}),
        fieldKey: input.fieldKey,
        flush: () => flushRef.current(),
      })
      sessionRef.current = session
      return () => {
        mountedRef.current = false
        clearTimer()
        if (sessionRef.current === session) sessionRef.current = null
        void session.close('flush').catch(() => undefined)
      }
    }
    return () => {
      mountedRef.current = false
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
  return useSettledConfigurationEdit({
    ownerChatId: input.chatId,
    fieldKey: input.fieldKey,
    storedValue: input.storedValue,
    ...(input.settleMs === undefined ? {} : { settleMs: input.settleMs }),
    ...(input.equal === undefined ? {} : { equal: input.equal }),
    prepare(value) {
      return configurationApplication.prepareChatSettingsFields(
        input.chatId,
        input.patches(value),
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

function configurationEditOwnerKey(
  input: Pick<SettledConfigurationEditOwner<unknown>, 'ownerChatId' | 'ownerKey' | 'fieldKey'>,
): string {
  return JSON.stringify([input.ownerChatId, input.ownerKey, input.fieldKey])
}
