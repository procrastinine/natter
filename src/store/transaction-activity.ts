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

export function runWithLocalReadActivity<T>(run: () => T | PromiseLike<T>): Promise<T> {
  return admitActivity('read', run)
}

export function runWithLocalWriteActivity<T>(run: () => T | PromiseLike<T>): Promise<T> {
  return admitActivity('write', run)
}

function admitActivity<T>(mode: ActivityMode, run: () => T | PromiseLike<T>): Promise<T> {
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
  if (activePhase) startQueuedPhase(activePhase)
}
