import { playwrightProjects, projectCollectsFile } from './playwright-projects.mjs'

export function browserProjectsForFile(path) {
  return playwrightProjects().filter((project) => projectCollectsFile(project, path))
}

export function selectBrowserTasks(files, allFiles) {
  const projects = playwrightProjects()
  const selected = new Map()
  const problems = []
  const add = (project, path) => {
    const paths = selected.get(project.name) ?? new Set()
    paths.add(path)
    selected.set(project.name, paths)
  }
  for (const path of files) {
    const owners = projects.filter((project) => projectCollectsFile(project, path))
    if (owners.length === 0) problems.push(`VerificationBrowserFileUncollected:${path}`)
    for (const owner of owners) add(owner, path)
  }
  const affectedSetups = projects
    .filter((project) => project.setup && selected.has(project.name))
    .map((project) => project.name)
  for (const project of projects) {
    if (!project.dependencies?.some((name) => affectedSetups.includes(name))) continue
    for (const path of allFiles.filter((path) => projectCollectsFile(project, path))) {
      add(project, path)
    }
  }
  for (const project of projects) {
    if (!selected.has(project.name)) continue
    for (const name of project.dependencies ?? []) {
      const setup = projects.find((candidate) => candidate.name === name)
      const paths = allFiles.filter((path) => projectCollectsFile(setup, path))
      if (paths.length === 0) problems.push(`VerificationBrowserSetupMissing:${name}`)
      for (const path of paths) add(setup, path)
    }
  }
  return {
    tasks: projects
      .filter((project) => selected.has(project.name))
      .map((project) => ({
        project: project.name,
        files: [...selected.get(project.name)].sort(),
      })),
    problems,
  }
}

export function browserTaskGroups(tasks) {
  const groups = new Map()
  for (const task of tasks) {
    const project = playwrightProjects().find((entry) => entry.name === task.project)
    if (!project) throw new Error(`BrowserProjectUnknown:${task.project}`)
    const group = browserProjectGroup(project)
    const entries = groups.get(group) ?? []
    entries.push(task)
    groups.set(group, entries)
  }
  return ['chromium', 'firefox', 'parity', 'headed']
    .filter((name) => groups.has(name))
    .map((name) => ({ name, tasks: groups.get(name) }))
}

export function browserGroupProjects(group) {
  return playwrightProjects()
    .filter((project) => browserProjectGroup(project) === group)
    .map(({ name }) => name)
}

function browserProjectGroup(project) {
  return project.headed ? 'headed' : project.activation ? 'parity' : project.browser
}

export function browserExecutionPhases(tasks) {
  const projects = playwrightProjects()
  const seen = new Set()
  for (const task of tasks) {
    if (seen.has(task.project)) throw new Error(`BrowserPhaseDuplicateProject:${task.project}`)
    seen.add(task.project)
    const project = projects.find(({ name }) => name === task.project)
    if (!project || !task.files.length)
      throw new Error(`BrowserPhaseProjectInvalid:${task.project}`)
    for (const dependency of project.dependencies ?? []) {
      if (!tasks.some(({ project: name }) => name === dependency))
        throw new Error(`BrowserPhaseProducerMissing:${task.project}:${dependency}`)
    }
  }
  return ['ordinary', 'workspace', 'measurement'].flatMap((name) => {
    const selected = tasks.filter(
      (task) =>
        (projects.find(({ name: project }) => project === task.project).executionPhase ??
          'ordinary') === name,
    )
    if (!selected.length) return []
    const headed = selected.some(
      (task) => projects.find(({ name: project }) => project === task.project).headed,
    )
    const argv = headed
      ? ['pnpm', 'run', 'e2e:headed-visibility']
      : [
          'pnpm',
          'exec',
          'playwright',
          'test',
          ...selected.map((task) => `--project=${task.project}`),
        ]
    return [
      Object.freeze({
        name,
        tasks: Object.freeze(
          selected.map((task) =>
            Object.freeze({ project: task.project, files: Object.freeze([...task.files]) }),
          ),
        ),
        argv: Object.freeze(argv),
      }),
    ]
  })
}
