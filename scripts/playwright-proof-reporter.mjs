import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { playwrightProjects, projectCollectsFile } from './playwright-projects.mjs'

export function browserSuiteFiles(root) {
  const directory = resolve(root, 'tests/e2e')
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((path) => playwrightProjects().some((project) => projectCollectsFile(project, path)))
    .sort()
}

export function fullBrowserTasks(names, files) {
  const projects = playwrightProjects()
  const selected = new Set()
  const visit = (name) => {
    if (selected.has(name)) return
    const project = projects.find((entry) => entry.name === name)
    if (!project) throw new Error(`BrowserProjectUnknown:${name}`)
    selected.add(name)
    for (const dependency of project.dependencies ?? []) visit(dependency)
  }
  for (const name of names) visit(name)
  return projects
    .filter((project) => selected.has(project.name))
    .map((project) => ({
      project: project.name,
      files: files.filter((path) => projectCollectsFile(project, path)),
    }))
}

export function browserProofProblems(expected, cases) {
  const problems = []
  if (expected.length === 0 || expected.some((task) => task.files.length === 0)) {
    problems.push('BrowserProofEmptySelection')
  }
  const pairs = new Set(
    expected.flatMap((task) => task.files.map((file) => `${task.project}:${file}`)),
  )
  const seen = new Set()
  const ids = new Set()
  for (const entry of cases) {
    const pair = `${entry.project}:${entry.file}`
    if (!pairs.has(pair)) problems.push(`BrowserProofUnexpectedFile:${pair}`)
    if (ids.has(entry.id)) problems.push(`BrowserProofDuplicateTest:${entry.id}`)
    ids.add(entry.id)
    seen.add(pair)
    if (entry.results.length !== 1)
      problems.push(`BrowserProofAttemptCount:${entry.id}:${entry.results.length}`)
    if (entry.outcome !== 'expected' && entry.outcome !== 'skipped')
      problems.push(`BrowserProofOutcome:${entry.id}:${entry.outcome}`)
    if (entry.results.some((result) => result.retry !== 0 || result.status === 'interrupted'))
      problems.push(`BrowserProofIncomplete:${entry.id}`)
    if (
      entry.outcome === 'skipped' &&
      !entry.annotations.some(
        (annotation) => annotation.type === 'skip' || annotation.type === 'fixme',
      )
    )
      problems.push(`BrowserProofUnexplainedSkip:${entry.id}`)
  }
  for (const pair of pairs) if (!seen.has(pair)) problems.push(`BrowserProofMissingFile:${pair}`)
  return problems
}

export function readBrowserProof(path, expected) {
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (report.schemaVersion !== 1 || report.status !== 'passed')
    throw new Error('BrowserProofNotPassed')
  const problems = browserProofProblems(expected, report.cases)
  if (problems.length) throw new Error(problems.join('\n'))
  return report
}

export default class BrowserProofReporter {
  onBegin(config, suite) {
    this.root = resolve(config.rootDir, '../..')
    this.suite = suite
    this.path =
      process.env.E2E_BROWSER_PROOF_PATH ??
      resolve(config.projects[0].outputDir, '../browser-proof.json')
    this.expected = process.env.E2E_BROWSER_SELECTION
      ? JSON.parse(process.env.E2E_BROWSER_SELECTION)
      : process.env.E2E_BROWSER_PROJECTS
        ? fullBrowserTasks(
            JSON.parse(process.env.E2E_BROWSER_PROJECTS),
            browserSuiteFiles(this.root),
          )
        : null
  }

  onEnd(result) {
    const cases =
      this.suite?.allTests().map((test) => ({
        id: test.id,
        project: test.parent.project().name,
        file: relative(this.root, test.location.file).replaceAll('\\', '/'),
        title: test.titlePath(),
        outcome: test.outcome(),
        annotations: test.annotations,
        results: test.results.map((entry) => ({
          status: entry.status,
          retry: entry.retry,
          duration: entry.duration,
        })),
      })) ?? []
    const expected =
      this.expected ??
      [...new Set(cases.map((entry) => entry.project))].map((project) => ({
        project,
        files: [
          ...new Set(cases.filter((entry) => entry.project === project).map((entry) => entry.file)),
        ],
      }))
    const problems = browserProofProblems(expected, cases)
    const status = problems.length > 0 ? 'failed' : result.status
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(
        this.path,
        `${JSON.stringify({ schemaVersion: 1, status, expected, cases, problems }, null, 2)}\n`,
      )
    }
    for (const problem of problems) console.error(problem)
    return { status }
  }
}

export function reconcileBrowserPhaseProofs(expected, phases) {
  const cases = []
  const problems = []
  const selected = new Set(
    expected.flatMap((task) => task.files.map((file) => `${task.project}:${file}`)),
  )
  const seen = new Set()
  for (const phase of phases) {
    for (const task of phase.tasks) {
      for (const file of task.files) {
        const key = `${task.project}:${file}`
        if (!selected.has(key)) problems.push(`BrowserPhaseUnexpectedFile:${key}`)
        if (seen.has(key)) problems.push(`BrowserPhaseDuplicateFile:${key}`)
        seen.add(key)
      }
    }
    const proof = phase.proof
    if (
      proof?.schemaVersion !== 1 ||
      !Array.isArray(proof.cases) ||
      !Array.isArray(proof.expected)
    ) {
      problems.push(`BrowserPhaseReceiptMissing:${phase.name}`)
      continue
    }
    if (JSON.stringify(proof.expected) !== JSON.stringify(phase.tasks))
      problems.push(`BrowserPhaseReceiptSelection:${phase.name}`)
    if (
      phase.exitCode !== 0 ||
      phase.signal !== null ||
      phase.diagnostics?.length ||
      proof.status !== 'passed'
    )
      problems.push(`BrowserPhaseFailed:${phase.name}`)
    problems.push(...browserProofProblems(phase.tasks, proof.cases))
    cases.push(...proof.cases)
  }
  for (const key of selected) if (!seen.has(key)) problems.push(`BrowserPhaseMissingFile:${key}`)
  problems.push(...browserProofProblems(expected, cases))
  return {
    schemaVersion: 1,
    status: problems.length ? 'failed' : 'passed',
    expected,
    cases,
    problems,
  }
}
