import { relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BaseSequencer, type TestSpecification, type Vitest } from 'vitest/node'
import { GlobalTestSequencer } from '../../scripts/vitest-sequencer.mjs'

interface Entry {
  project: string
  file: string
  size?: number
  duration?: number
  failed?: boolean
  groupOrder?: number
  isolate?: boolean
}

function fixture(entries: readonly Entry[]) {
  const root = resolve('test-root')
  const byKey = new Map(entries.map((entry) => [`${entry.project}:${entry.file}`, entry]))
  const files = entries.map((entry) => ({
    moduleId: resolve(root, entry.file),
    project: {
      name: entry.project,
      config: { isolate: entry.isolate ?? true, sequence: { groupOrder: entry.groupOrder ?? 0 } },
    },
  })) as unknown as TestSpecification[]
  const context = {
    config: { root, shard: { index: 1, count: 2 } },
    cache: {
      getFileTestResults(key: string) {
        const entry = byKey.get(key)
        return entry?.duration === undefined
          ? undefined
          : { duration: entry.duration, failed: entry.failed ?? false }
      },
      getFileStats(key: string) {
        const size = byKey.get(key)?.size
        return size === undefined ? undefined : { size }
      },
    },
  } as unknown as Vitest
  return {
    context,
    files,
    keys: (selected: readonly TestSpecification[]) =>
      selected.map(
        (spec) => `${spec.project.name}:${relative(root, spec.moduleId).split(sep).join('/')}`,
      ),
  }
}

describe('global Vitest scheduling', () => {
  it('starts long files across projects instead of queuing a whole project first', async () => {
    const { context, files, keys } = fixture([
      { project: 'app', file: 'quick.test.ts', duration: 1 },
      { project: 'tooling', file: 'long.test.ts', duration: 8 },
      { project: 'app', file: 'medium.test.ts', duration: 4 },
      { project: 'tooling', file: 'short.test.ts', duration: 2 },
    ])
    const original = [...files]
    expect(keys(await new GlobalTestSequencer(context).sort(files))).toEqual([
      'tooling:long.test.ts',
      'app:medium.test.ts',
      'tooling:short.test.ts',
      'app:quick.test.ts',
    ])
    expect(files).toEqual(original)
  })

  it('keeps cached failures ahead of passing files regardless of project or duration', async () => {
    const { context, files, keys } = fixture([
      { project: 'app', file: 'slow.test.ts', duration: 9 },
      { project: 'tooling', file: 'failure.test.ts', duration: 1, failed: true },
      { project: 'app', file: 'unseen.test.ts', size: 999 },
    ])
    expect(keys(await new GlobalTestSequencer(context).sort(files))).toEqual([
      'tooling:failure.test.ts',
      'app:unseen.test.ts',
      'app:slow.test.ts',
    ])
  })

  it('uses global file size on a cold cache and deterministic ties independent of input order', async () => {
    const { context, files, keys } = fixture([
      { project: 'app', file: 'z.test.ts', size: 10 },
      { project: 'tooling', file: 'large.test.ts', size: 100 },
      { project: 'app', file: 'a.test.ts', size: 10 },
      { project: 'tooling', file: 'unknown.test.ts' },
    ])
    const sequencer = new GlobalTestSequencer(context)
    const expected = [
      'tooling:unknown.test.ts',
      'tooling:large.test.ts',
      'app:a.test.ts',
      'app:z.test.ts',
    ]
    expect(keys(await sequencer.sort(files))).toEqual(expected)
    expect(keys(await sequencer.sort([...files].reverse()))).toEqual(expected)
  })

  it('orders mixed caches transitively when duration and size disagree', async () => {
    const { context, files, keys } = fixture([
      { project: 'tooling', file: 'slow-small.test.ts', duration: 100, size: 1 },
      { project: 'app', file: 'fast-large.test.ts', duration: 1, size: 100 },
      { project: 'app', file: 'unseen.test.ts', size: 50 },
    ])
    const sequencer = new GlobalTestSequencer(context)
    const rotations = files.map((_, start) => [...files.slice(start), ...files.slice(0, start)])
    for (const order of rotations.flatMap((rotation) => [rotation, [...rotation].reverse()])) {
      expect(keys(await sequencer.sort(order))).toEqual([
        'app:unseen.test.ts',
        'tooling:slow-small.test.ts',
        'app:fast-large.test.ts',
      ])
    }
  })

  it('retains explicit group order and isolation priority before workload priority', async () => {
    const { context, files, keys } = fixture([
      { project: 'app', file: 'later.test.ts', groupOrder: 1, duration: 99 },
      { project: 'app', file: 'shared.test.ts', isolate: false, duration: 20 },
      { project: 'tooling', file: 'isolated.test.ts', duration: 1 },
    ])
    expect(keys(await new GlobalTestSequencer(context).sort(files))).toEqual([
      'tooling:isolated.test.ts',
      'app:shared.test.ts',
      'app:later.test.ts',
    ])
  })

  it('inherits the pinned framework sharding unchanged', async () => {
    const { context, files } = fixture([
      { project: 'app', file: 'a.test.ts' },
      { project: 'tooling', file: 'b.test.ts' },
      { project: 'app', file: 'c.test.ts' },
    ])
    const sequencer = new GlobalTestSequencer(context)
    expect(sequencer.shard).toBe(BaseSequencer.prototype.shard)
    expect(await sequencer.shard(files)).toEqual(await new BaseSequencer(context).shard(files))
  })
})
