const MAX_RUNNING_TASKS = 2
const MAX_QUEUED_TASKS = 16
const DEFAULT_TIMEOUT_MS = 15_000

interface PostCommitTask {
  operation: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>
  epoch: number
  current: boolean
  started: boolean
  controller: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  logicalPromise: Promise<void>
  resolveLogical: () => void
}

const running = new Set<PostCommitTask>()
const queued: PostCommitTask[] = []
const logicalTasks = new Set<Promise<void>>()
let epoch = 0

function removeQueued(task: PostCommitTask): void {
  const index = queued.indexOf(task)
  if (index >= 0) queued.splice(index, 1)
}

function settleLogical(task: PostCommitTask): void {
  if (!task.current) return
  task.current = false
  task.controller.abort()
  if (task.timer !== undefined) clearTimeout(task.timer)
  task.timer = undefined
  removeQueued(task)
  logicalTasks.delete(task.logicalPromise)
  task.resolveLogical()
}

function pump(): void {
  while (running.size < MAX_RUNNING_TASKS && queued.length > 0) {
    const task = queued.shift() as PostCommitTask
    if (!task.current || task.epoch !== epoch) {
      settleLogical(task)
      continue
    }
    task.started = true
    running.add(task)
    void Promise.resolve()
      .then(() =>
        task.operation(() => task.current && task.epoch === epoch, task.controller.signal),
      )
      .catch(() => undefined)
      .finally(() => {
        running.delete(task)
        settleLogical(task)
        pump()
      })
  }
}

export function schedulePostCommitTask(
  operation: (isCurrent: () => boolean, signal: AbortSignal) => Promise<void>,
  options: { timeoutMs?: number } = {},
): boolean {
  if (running.size + queued.length >= MAX_RUNNING_TASKS + MAX_QUEUED_TASKS) return false

  let resolveLogical!: () => void
  const logicalPromise = new Promise<void>((resolve) => {
    resolveLogical = resolve
  })
  const task: PostCommitTask = {
    operation,
    epoch,
    current: true,
    started: false,
    controller: new AbortController(),
    timer: undefined,
    logicalPromise,
    resolveLogical,
  }
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  task.timer = setTimeout(() => {
    settleLogical(task)
    pump()
  }, timeoutMs)
  logicalTasks.add(logicalPromise)
  queued.push(task)
  pump()
  return true
}

export function invalidatePostCommitTasks(): void {
  epoch += 1
  for (const task of queued.splice(0)) settleLogical(task)
  for (const task of running) settleLogical(task)
}

export async function flushPostCommitTasksForTests(): Promise<void> {
  while (logicalTasks.size > 0) await Promise.all([...logicalTasks])
}

export function resetPostCommitTasksForTests(): void {
  invalidatePostCommitTasks()
  running.clear()
}

export function postCommitTaskStatsForTests(): {
  running: number
  queued: number
  logical: number
} {
  return { running: running.size, queued: queued.length, logical: logicalTasks.size }
}
