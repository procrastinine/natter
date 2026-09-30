import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'

export function selectVitestProofFiles(projects, selection) {
  const expected = projects.flatMap(({ project, files }) =>
    files.map((file) => ({ project, file })),
  )
  if (!selection) return expected
  const files = JSON.parse(selection)
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string'))
    throw new Error('VitestProofSelectionInvalid')
  const selected = new Set(files)
  if (selected.size !== files.length) throw new Error('VitestProofSelectionDuplicate')
  const known = new Set(expected.map(({ file }) => file))
  for (const file of selected) {
    if (!known.has(file)) throw new Error(`VitestProofSelectionUnknown:${file}`)
  }
  return expected.filter(({ file }) => selected.has(file))
}

export function vitestProofProblems(report, expectedFiles, invocation) {
  const problems = []
  if (invocation && report.invocation !== invocation) problems.push('VitestProofInvocationMismatch')
  if (report.schemaVersion !== 1) problems.push('VitestProofSchemaInvalid')
  if (report.reason !== 'passed') problems.push(`VitestProofRun:${report.reason}`)
  if (report.timedOut) problems.push('VitestProofProcessTimeout')
  if (report.unhandledErrors.length) problems.push('VitestProofUnhandledErrors')
  problems.push(...report.selectionProblems)
  const expected = new Set(report.expected.map(fileKey))
  if (expected.size === 0) problems.push('VitestProofEmptySelection')
  if (expected.size !== report.expected.length) problems.push('VitestProofDuplicateSelection')
  if (expectedFiles) {
    reconcile(
      expectedFiles,
      report.expected.map(({ file }) => file),
      'Selection',
      problems,
    )
  }
  for (const [phase, entries] of [
    ['Scheduled', report.scheduled],
    ['Collected', report.collected],
    ['Completed', report.completed],
    ['Final', report.finalModules],
  ])
    reconcile([...expected], entries.map(fileKey), phase, problems)

  const cases = report.collected.flatMap(({ project, file, cases }) =>
    cases.map((entry) => ({ project, file, ...entry })),
  )
  const collectedCases = new Map()
  for (const entry of report.collected) {
    if (!entry.cases.length) problems.push(`VitestProofEmptyModule:${fileKey(entry)}`)
  }
  for (const entry of cases) {
    const key = caseKey(entry)
    if (collectedCases.has(key)) problems.push(`VitestProofDuplicateCase:${key}`)
    collectedCases.set(key, entry)
    if (!['run', 'skip', 'todo'].includes(entry.mode))
      problems.push(`VitestProofCaseMode:${key}:${entry.mode}`)
  }
  reconcile([...collectedCases.keys()], report.results.map(caseKey), 'CaseResult', problems)
  for (const entry of report.results) {
    const key = caseKey(entry)
    const declaration = collectedCases.get(key)
    if (!declaration) continue
    const declaredSkip = declaration.mode === 'skip' || declaration.mode === 'todo'
    if (entry.state !== (declaredSkip ? 'skipped' : 'passed'))
      problems.push(`VitestProofCaseState:${key}:${entry.state}`)
    if (entry.errors.length) problems.push(`VitestProofCaseErrors:${key}`)
    if (!declaredSkip && !entry.diagnostic) problems.push(`VitestProofCaseUnfinished:${key}`)
    if (
      entry.diagnostic &&
      (entry.diagnostic.retryCount !== 0 ||
        entry.diagnostic.repeatCount !== 0 ||
        entry.diagnostic.flaky)
    )
      problems.push(`VitestProofCaseRepeated:${key}`)
  }
  for (const entry of report.completed) {
    if (entry.state !== 'passed' && entry.state !== 'skipped')
      problems.push(`VitestProofModuleState:${fileKey(entry)}:${entry.state}`)
  }
  return problems
}

export function readVitestProof(path, expectedFiles, invocation) {
  const report = JSON.parse(readFileSync(path, 'utf8'))
  const problems = vitestProofProblems(report, expectedFiles, invocation)
  if (report.status !== 'passed') problems.unshift('VitestProofNotPassed')
  if (problems.length) throw new Error(problems.join('\n'))
  return report
}

export default class VitestProofReporter {
  constructor({ path, expected, invocation }) {
    if (!invocation) throw new Error('VitestProofInvocationRequired')
    this.invocation = invocation
    this.path = path
    this.expected = expected
    this.collected = []
    this.completed = []
    this.results = []
    this.selectionProblems = []
    this.timedOut = false
  }

  onInit(context) {
    this.root = context.config.root
    if (context.config.testNamePattern || context.config.tagsFilter?.length)
      this.selectionProblems.push('VitestProofFilteredCases:configuration')
  }

  onTestRunStart(specifications) {
    this.scheduled = specifications.map((specification) => this.file(specification))
    for (const specification of specifications) {
      if (
        specification.testNamePattern ||
        specification.testLines?.length ||
        specification.testIds?.length ||
        specification.testTagsFilter?.length
      ) {
        this.selectionProblems.push(`VitestProofFilteredCases:${fileKey(this.file(specification))}`)
      }
    }
  }

  onTestModuleCollected(module) {
    this.collected.push({
      ...this.file(module),
      cases: [...module.children.allTests()].map((test) => ({
        id: test.id,
        name: test.fullName,
        mode: test.options.mode,
      })),
    })
  }

  onTestCaseResult(test) {
    const result = test.result()
    const diagnostic = test.diagnostic()
    this.results.push({
      ...this.file(test.module),
      id: test.id,
      state: result.state,
      errors: (result.errors ?? []).map((error) => error.message),
      diagnostic: diagnostic
        ? {
            retryCount: diagnostic.retryCount,
            repeatCount: diagnostic.repeatCount,
            flaky: diagnostic.flaky,
            duration: diagnostic.duration,
          }
        : null,
    })
  }

  onTestModuleEnd(module) {
    this.completed.push({ ...this.file(module), state: module.state() })
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    this.report = {
      schemaVersion: 1,
      invocation: this.invocation,
      reason,
      timedOut: this.timedOut,
      expected: this.expected,
      scheduled: this.scheduled ?? [],
      collected: this.collected,
      completed: this.completed,
      results: this.results,
      finalModules: modules.map((module) => this.file(module)),
      unhandledErrors: unhandledErrors.map((error) => error.message),
      selectionProblems: this.selectionProblems,
    }
    this.persist()
  }

  onProcessTimeout() {
    this.timedOut = true
    if (this.report) {
      this.report.timedOut = true
      this.persist()
    }
  }

  file(module) {
    return {
      project: module.project.name,
      file: relative(this.root, module.moduleId).replaceAll('\\', '/'),
    }
  }

  persist() {
    const problems = vitestProofProblems(this.report)
    const status = problems.length ? 'failed' : 'passed'
    const cases = this.collected.flatMap(({ cases }) => cases)
    const counts = {
      executed: this.results.filter(({ state }) => state === 'passed' || state === 'failed').length,
      passed: this.results.filter(({ state }) => state === 'passed').length,
      failed: this.results.filter(({ state }) => state === 'failed').length,
      declaredSkipped: cases.filter(({ mode }) => mode === 'skip').length,
      todo: cases.filter(({ mode }) => mode === 'todo').length,
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(
      this.path,
      `${JSON.stringify({ ...this.report, status, counts, problems }, null, 2)}\n`,
    )
    if (problems.length) {
      process.exitCode = 1
      for (const problem of problems) console.error(problem)
    }
  }
}

function fileKey({ project, file }) {
  return `${project}:${file}`
}

function caseKey({ project, file, id }) {
  return `${project}:${file}:${id}`
}

function reconcile(expected, actual, phase, problems) {
  const expectedSet = new Set(expected)
  const actualSet = new Set()
  for (const key of actual) {
    if (actualSet.has(key)) problems.push(`VitestProofDuplicate${phase}:${key}`)
    actualSet.add(key)
    if (!expectedSet.has(key)) problems.push(`VitestProofUnexpected${phase}:${key}`)
  }
  for (const key of expectedSet) {
    if (!actualSet.has(key)) problems.push(`VitestProofMissing${phase}:${key}`)
  }
}
