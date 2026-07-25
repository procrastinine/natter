import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_INVENTORY_PATH = resolve(SCRIPT_DIRECTORY, 'production-module-inventory.json')

export function enumerateProductionModules(rootDirectory) {
  const sourceRoot = resolve(rootDirectory, 'src')
  const pending = [sourceRoot]
  const modules = []

  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolutePath)
      } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
        modules.push(relative(rootDirectory, absolutePath).replaceAll('\\', '/'))
      }
    }
  }

  return modules.sort()
}

export function validateProductionModuleInventory(inventory, actualPaths) {
  const violations = []
  const classifiedPaths = []
  const classifiedPathCounts = new Map()
  const domainCounts = new Map()
  const layerCounts = new Map()

  if (!isRecord(inventory)) {
    return failure([{ code: 'inventory-invalid', detail: 'Inventory root must be an object.' }])
  }
  if (inventory.schemaVersion !== 1) {
    violations.push({
      code: 'schema-version-invalid',
      detail: `Expected schemaVersion 1; received ${JSON.stringify(inventory.schemaVersion)}.`,
    })
  }
  if (!Array.isArray(inventory.classifications)) {
    violations.push({
      code: 'classifications-invalid',
      detail: 'classifications must be an array.',
    })
  } else {
    for (const [classificationIndex, classification] of inventory.classifications.entries()) {
      const location = `classifications[${classificationIndex}]`
      if (!isRecord(classification)) {
        violations.push({
          code: 'classification-invalid',
          detail: `${location} must be an object.`,
        })
        continue
      }
      for (const field of ['domain', 'layer', 'responsibility']) {
        if (!isNonEmptyString(classification[field])) {
          violations.push({
            code: 'classification-field-invalid',
            detail: `${location}.${field} must be a non-empty string.`,
          })
        }
      }
      if (!Array.isArray(classification.paths) || classification.paths.length === 0) {
        violations.push({
          code: 'classification-paths-invalid',
          detail: `${location}.paths must be a non-empty array.`,
        })
        continue
      }

      for (const [pathIndex, path] of classification.paths.entries()) {
        const pathLocation = `${location}.paths[${pathIndex}]`
        if (!isInventoryModulePath(path)) {
          violations.push({
            code: 'classification-path-invalid',
            detail: `${pathLocation} must be an exact normalized src/**/*.ts or src/**/*.tsx path.`,
          })
          continue
        }
        classifiedPaths.push(path)
        classifiedPathCounts.set(path, (classifiedPathCounts.get(path) ?? 0) + 1)
        if (isNonEmptyString(classification.domain)) increment(domainCounts, classification.domain)
        if (isNonEmptyString(classification.layer)) increment(layerCounts, classification.layer)
      }
    }
  }

  const duplicatePaths = [...classifiedPathCounts]
    .filter(([, count]) => count > 1)
    .map(([path, count]) => ({ path, count }))
    .sort((left, right) => left.path.localeCompare(right.path))
  for (const duplicate of duplicatePaths) {
    violations.push({
      code: 'classification-duplicate',
      path: duplicate.path,
      detail: `${duplicate.path} is classified ${duplicate.count} times.`,
    })
  }

  const actual = new Set([...actualPaths].sort())
  const classified = new Set(classifiedPaths)
  const missingPaths = [...actual].filter((path) => !classified.has(path)).sort()
  const stalePaths = [...classified].filter((path) => !actual.has(path)).sort()
  for (const path of missingPaths) {
    violations.push({
      code: 'classification-missing',
      path,
      detail: `${path} exists on disk but is not classified.`,
    })
  }
  for (const path of stalePaths) {
    violations.push({
      code: 'classification-stale',
      path,
      detail: `${path} is classified but does not exist on disk.`,
    })
  }

  const ingressPaths = new Set()
  if (!Array.isArray(inventory.ingress)) {
    violations.push({ code: 'ingress-invalid', detail: 'ingress must be an array.' })
  } else {
    for (const [ingressIndex, ingress] of inventory.ingress.entries()) {
      const location = `ingress[${ingressIndex}]`
      if (!isRecord(ingress)) {
        violations.push({ code: 'ingress-entry-invalid', detail: `${location} must be an object.` })
        continue
      }
      if (!isInventoryModulePath(ingress.path)) {
        violations.push({
          code: 'ingress-path-invalid',
          detail: `${location}.path must be an exact normalized source-module path.`,
        })
      } else if (ingressPaths.has(ingress.path)) {
        violations.push({
          code: 'ingress-duplicate',
          path: ingress.path,
          detail: `${ingress.path} is declared as ingress more than once.`,
        })
      } else {
        ingressPaths.add(ingress.path)
        if (!classified.has(ingress.path)) {
          violations.push({
            code: 'ingress-unclassified',
            path: ingress.path,
            detail: `${ingress.path} is ingress but has no primary classification.`,
          })
        }
      }
      for (const field of ['kind', 'audience']) {
        if (!isNonEmptyString(ingress[field])) {
          violations.push({
            code: 'ingress-field-invalid',
            detail: `${location}.${field} must be a non-empty string.`,
          })
        }
      }
    }
  }

  violations.sort(compareViolations)
  return {
    ok: violations.length === 0,
    schemaVersion: inventory.schemaVersion,
    moduleCount: actual.size,
    classificationCount: classifiedPaths.length,
    uniqueClassifiedModuleCount: classified.size,
    ingressCount: ingressPaths.size,
    domainCounts: sortedRecord(domainCounts),
    layerCounts: sortedRecord(layerCounts),
    missingPaths,
    stalePaths,
    duplicatePaths,
    violations,
  }
}

export function auditProductionModuleInventory(
  rootDirectory = resolve(SCRIPT_DIRECTORY, '..'),
  inventoryPath = DEFAULT_INVENTORY_PATH,
) {
  let inventory
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  } catch (error) {
    return failure([
      {
        code: 'inventory-read-failed',
        detail: error instanceof Error ? error.message : String(error),
      },
    ])
  }
  return validateProductionModuleInventory(inventory, enumerateProductionModules(rootDirectory))
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isInventoryModulePath(value) {
  if (typeof value !== 'string' || value.includes('\\')) return false
  if (value !== posix.normalize(value) || value.startsWith('/') || value.includes('*')) return false
  return /^src\/(?:.+\/)?[^/]+\.tsx?$/u.test(value)
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function sortedRecord(counts) {
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

function compareViolations(left, right) {
  return (
    left.code.localeCompare(right.code) ||
    (left.path ?? '').localeCompare(right.path ?? '') ||
    left.detail.localeCompare(right.detail)
  )
}

function failure(violations) {
  return {
    ok: false,
    schemaVersion: null,
    moduleCount: 0,
    classificationCount: 0,
    uniqueClassifiedModuleCount: 0,
    ingressCount: 0,
    domainCounts: {},
    layerCounts: {},
    missingPaths: [],
    stalePaths: [],
    duplicatePaths: [],
    violations,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditProductionModuleInventory()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.ok) process.exitCode = 1
}
