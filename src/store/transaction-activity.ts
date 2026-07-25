import { errorFromUnknown } from '../lib/error'

type ActivityMode = 'read' | 'write'

interface QueuedActivity {
  run: () => unknown
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface ActivityPhase {
  mode: ActivityMode
  active: number
  queued: QueuedActivity[]
}

const PlatformPromise = Promise
let activePhase: ActivityPhase | null = null
const queuedPhases: ActivityPhase[] = []
let acceptingActivity = false
let idlePromise: Promise<void> | null = null
let resolveIdle: (() => void) | null = null

export class LocalTransactionActivityClosedError extends Error {
  constructor() {
    super('LocalTransactionActivityClosed')
    this.name = 'LocalTransactionActivityClosedError'
  }
}

export function runWithLocalReadActivity<T>(run: () => T | PromiseLike<T>): Promise<T> {
  return admitActivity('read', run)
}

export function runWithLocalWriteActivity<T>(run: () => T | PromiseLike<T>): Promise<T> {
  return admitActivity('write', run)
}

function admitActivity<T>(mode: ActivityMode, run: () => T | PromiseLike<T>): Promise<T> {
  if (!acceptingActivity) {
    return PlatformPromise.reject(new LocalTransactionActivityClosedError())
  }
  if (activePhase === null) {
    const phase: ActivityPhase = { mode, active: 0, queued: [] }
    activePhase = phase
    return startImmediateActivity(phase, run)
  }
  if (activePhase.mode === mode && queuedPhases.length === 0) {
    return startImmediateActivity(activePhase, run)
  }

  let phase = queuedPhases.at(-1)
  if (phase?.mode !== mode) {
    phase = { mode, active: 0, queued: [] }
    queuedPhases.push(phase)
  }
  return new PlatformPromise<T>((resolve, reject) => {
    phase.queued.push({
      run,
      resolve,
      reject,
    })
  })
}

function startImmediateActivity<T>(
  phase: ActivityPhase,
  run: () => T | PromiseLike<T>,
): Promise<T> {
  phase.active += 1
  let result: T | PromiseLike<T>
  try {
    result = run()
  } catch (error) {
    finishActivity(phase)
    return PlatformPromise.reject(errorFromUnknown(error))
  }
  return PlatformPromise.resolve(result).then(
    (value) => {
      finishActivity(phase)
      return value
    },
    (error: unknown) => {
      finishActivity(phase)
      throw error
    },
  )
}

function startQueuedPhase(phase: ActivityPhase): void {
  const activities = phase.queued.splice(0)
  phase.active = activities.length
  for (const activity of activities) {
    let result: unknown
    try {
      result = activity.run()
    } catch (error) {
      activity.reject(error)
      finishActivity(phase)
      continue
    }
    PlatformPromise.resolve(result).then(
      (value) => {
        activity.resolve(value)
        finishActivity(phase)
      },
      (error: unknown) => {
        activity.reject(error)
        finishActivity(phase)
      },
    )
  }
}

function finishActivity(phase: ActivityPhase): void {
  phase.active -= 1
  if (phase.active !== 0) return
  if (activePhase !== phase) throw new Error('LocalTransactionActivityPhaseMismatch')
  activePhase = queuedPhases.shift() ?? null
  if (activePhase) {
    startQueuedPhase(activePhase)
    return
  }
  settleIdle()
}

export function stopLocalTransactionAdmissions(): void {
  if (!acceptingActivity) return
  acceptingActivity = false
  const error = new LocalTransactionActivityClosedError()
  for (const phase of queuedPhases.splice(0)) {
    for (const activity of phase.queued.splice(0)) activity.reject(error)
  }
  if (activePhase === null) settleIdle()
}

export function waitForLocalTransactionIdle(): Promise<void> {
  if (activePhase === null) return PlatformPromise.resolve()
  if (idlePromise) return idlePromise
  idlePromise = new PlatformPromise<void>((resolve) => {
    resolveIdle = resolve
  })
  return idlePromise
}

export function resumeLocalTransactionAdmissions(): void {
  if (activePhase !== null || queuedPhases.length > 0) {
    throw new Error('LocalTransactionActivityStillRunning')
  }
  acceptingActivity = true
  settleIdle()
}

export function localTransactionActivityStats(): {
  accepting: boolean
  active: number
  queued: number
} {
  return {
    accepting: acceptingActivity,
    active: activePhase?.active ?? 0,
    queued: queuedPhases.reduce((total, phase) => total + phase.queued.length, 0),
  }
}

export function assertLocalTransactionAdmissionsClosed(): void {
  if (acceptingActivity || activePhase || queuedPhases.length > 0) {
    throw new Error('LocalTransactionAdmissionsNotClosed')
  }
}

function settleIdle(): void {
  resolveIdle?.()
  resolveIdle = null
  idlePromise = null
}
