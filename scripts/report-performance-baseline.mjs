import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDeliveryWeight, deliveryBudgetProblems } from './delivery-weight.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(readFileSync(join(root, 'scripts/performance-baseline.json'), 'utf8'))
const args = parseArgs(process.argv.slice(2))
const cycleReport = collectDependencyCycles()
const duplication = collectDuplication()
const bundle = collectDeliveryWeight(root, baseline.deliveryBudgets)
const bundleBudgetProblems = deliveryBudgetProblems(bundle, baseline.deliveryBudgets)
const stream = args.streamReport ? readStreamReport(args.streamReport) : { available: false }
const streamProblems = collectStreamProblems(stream)
const testDurationMs = args.testDurationMs ?? numericEnvironmentValue('NATTER_TEST_DURATION_MS')

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  dependencyCycles: cycleReport,
  duplication,
  bundle: {
    ...bundle,
    budgetRecordedAt: baseline.deliveryBudgets.recordedAt,
    budgetProblems: bundleBudgetProblems,
  },
  tests:
    testDurationMs === undefined
      ? { available: false }
      : { available: true, durationMs: testDurationMs },
  stream: stream.available ? { ...stream, reportProblems: streamProblems } : stream,
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (cycleReport.count > 0 || bundleBudgetProblems.length > 0 || streamProblems.length > 0) {
  process.exitCode = 1
}

function collectDependencyCycles() {
  const cli = join(root, 'node_modules/dependency-cruiser/bin/dependency-cruise.mjs')
  const raw = execFileSync(
    process.execPath,
    [cli, 'src', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const result = JSON.parse(raw)
  const signatures = result.summary.violations
    .filter((violation) => violation.rule.name === 'no-circular')
    .map(cycleSignature)
    .sort()
  return {
    count: signatures.length,
    signatures,
  }
}

function collectDuplication() {
  const output = mkdtempSync(join(tmpdir(), 'natter-jscpd-'))
  try {
    const cli = join(root, 'node_modules/jscpd/run-jscpd.js')
    execFileSync(
      process.execPath,
      [
        cli,
        'src',
        'tests',
        '--config',
        'jscpd.config.json',
        '--reporters',
        'json',
        '--output',
        output,
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const result = JSON.parse(readFileSync(join(output, 'jscpd-report.json'), 'utf8'))
    return { available: true, ...result.statistics.total }
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}

function readStreamReport(path) {
  const value = JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(value) || !isRecord(value.scenario)) {
    throw new Error(`Invalid stream report: ${path}`)
  }
  const kind = streamReportKind(value)
  return { ...value, available: true, kind }
}

function streamReportKind(value) {
  if (
    isRecord(value.phaseElapsedMs) &&
    isRecord(value.heap) &&
    isRecord(value.beforeReload) &&
    isRecord(value.afterReload) &&
    Array.isArray(value.pageStates) &&
    Array.isArray(value.consoleProblems) &&
    Array.isArray(value.failures)
  ) {
    return 'concurrent'
  }
  if (
    Array.isArray(value.turnElapsedMs) &&
    Array.isArray(value.regenElapsedMs) &&
    Array.isArray(value.samples)
  ) {
    return 'single-chat'
  }
  throw new Error('Unsupported stream report shape')
}

function collectStreamProblems(stream) {
  if (!stream.available || stream.kind !== 'concurrent') return []
  const problems = stream.failures.map((failure) => `stream failure: ${String(failure)}`)
  if (stream.consoleProblems.length > 0 && stream.failures.length === 0) {
    problems.push(`${stream.consoleProblems.length} stream console problems`)
  }
  return problems
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cycleSignature(violation) {
  const nodes = [violation.from, ...violation.cycle.map((entry) => entry.name)]
  if (nodes.at(-1) === nodes[0]) nodes.pop()
  const rotations = nodes.map((_, index) =>
    nodes.slice(index).concat(nodes.slice(0, index)).join(' -> '),
  )
  return rotations.sort()[0]
}

function parseArgs(values) {
  const result = {}
  for (const value of values) {
    if (value.startsWith('--stream-report=')) {
      result.streamReport = value.slice('--stream-report='.length)
    } else if (value.startsWith('--test-duration-ms=')) {
      result.testDurationMs = positiveNumber(value.slice('--test-duration-ms='.length), value)
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  return result
}

function numericEnvironmentValue(name) {
  const value = process.env[name]
  return value === undefined ? undefined : positiveNumber(value, name)
}

function positiveNumber(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`)
  return parsed
}
