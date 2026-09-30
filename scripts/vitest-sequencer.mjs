import { relative, sep } from 'node:path'
import { BaseSequencer } from 'vitest/node'

export class GlobalTestSequencer extends BaseSequencer {
  async sort(files) {
    const ranked = files.map((spec) => {
      const path = relative(this.ctx.config.root, spec.moduleId).split(sep).join('/')
      const key = `${spec.project.name}:${path}`
      const result = this.ctx.cache.getFileTestResults(key)
      return {
        spec,
        key,
        category: result ? (result.failed ? 0 : 2) : 1,
        result,
        stats: this.ctx.cache.getFileStats(key),
      }
    })
    // Project-name priority delays long tooling work until application tests finish.
    // Separate cache categories avoid non-transitive duration/size comparisons.
    ranked.sort((a, b) => {
      const group =
        a.spec.project.config.sequence.groupOrder - b.spec.project.config.sequence.groupOrder
      if (group !== 0) return group
      const isolation =
        Number(Boolean(b.spec.project.config.isolate)) -
        Number(Boolean(a.spec.project.config.isolate))
      if (isolation !== 0) return isolation
      const category = a.category - b.category
      if (category !== 0) return category
      let priority
      if (a.category !== 1) {
        priority = b.result.duration - a.result.duration
      } else if (!a.stats || !b.stats) {
        priority = Number(Boolean(a.stats)) - Number(Boolean(b.stats))
      } else {
        priority = b.stats.size - a.stats.size
      }
      return priority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    })
    return ranked.map(({ spec }) => spec)
  }
}
