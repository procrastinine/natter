import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditProductionModuleInventory,
  enumerateProductionModules,
  validateProductionModuleInventory,
} from '../../scripts/audit-production-modules.mjs'

const ROOT = resolve(__dirname, '../..')

describe('production module inventory', () => {
  it('classifies every current source module exactly once', () => {
    const result = auditProductionModuleInventory(ROOT)
    const discovered = enumerateProductionModules(ROOT)

    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.moduleCount).toBe(discovered.length)
    expect(result.classificationCount).toBe(discovered.length)
    expect(result.uniqueClassifiedModuleCount).toBe(discovered.length)
    expect(result.ingressCount).toBeGreaterThan(0)
  })

  it('reports missing, stale, and duplicate exact-path classifications', () => {
    const result = validateProductionModuleInventory(
      {
        schemaVersion: 1,
        classifications: [
          {
            domain: 'example',
            layer: 'domain-model',
            responsibility: 'First classification.',
            paths: ['src/example/a.ts', 'src/example/stale.ts'],
          },
          {
            domain: 'example',
            layer: 'application',
            responsibility: 'Duplicate classification.',
            paths: ['src/example/a.ts'],
          },
        ],
        ingress: [
          {
            path: 'src/example/a.ts',
            kind: 'example-entry',
            audience: 'test',
          },
        ],
      },
      ['src/example/a.ts', 'src/example/missing.ts'],
    )

    expect(result.ok).toBe(false)
    expect(result.missingPaths).toEqual(['src/example/missing.ts'])
    expect(result.stalePaths).toEqual(['src/example/stale.ts'])
    expect(result.duplicatePaths).toEqual([{ path: 'src/example/a.ts', count: 2 }])
  })
})
