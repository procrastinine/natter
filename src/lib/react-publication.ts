import { unstable_NormalPriority, unstable_scheduleCallback } from 'scheduler'

export function scheduleReactPublication(task: () => void): void {
  unstable_scheduleCallback(unstable_NormalPriority, task)
}
