const ordinaryTests = /\.(?:spec|test)\.[cm]?[jt]sx?$/u
const largeSetup = /large-workspace\.setup\.ts$/u
const largeTests = /large-workspace-startup\.spec\.ts$/u
const parityTests = /dev-preview-parity\.spec\.ts$/u
const sendTests = /send-performance\.spec\.ts$/u
const viewportTests = /render-window\.spec\.ts$/u

export function playwrightProjects() {
  return [
    {
      name: 'large-workspace-setup',
      browser: 'chromium',
      testMatch: [largeSetup],
      setup: true,
      executionPhase: 'workspace',
    },
    {
      name: 'chromium',
      browser: 'chromium',
      testMatch: [ordinaryTests],
      testIgnore: [largeSetup, largeTests, parityTests, sendTests, viewportTests],
    },
    {
      name: 'chromium-large-workspace',
      browser: 'chromium',
      testMatch: [largeTests],
      dependencies: ['large-workspace-setup'],
      executionPhase: 'workspace',
    },
    {
      name: 'chromium-send-performance',
      browser: 'chromium',
      testMatch: [sendTests, viewportTests],
      executionPhase: 'measurement',
      fullyParallel: false,
      workers: 1,
    },
    {
      name: 'firefox',
      browser: 'firefox',
      testMatch: [ordinaryTests],
      testIgnore: [largeSetup, largeTests, parityTests, sendTests],
    },
    {
      name: 'firefox-send-performance',
      browser: 'firefox',
      testMatch: [sendTests],
      executionPhase: 'measurement',
      fullyParallel: false,
      workers: 1,
    },
    {
      name: 'chromium-preview-parity',
      browser: 'chromium',
      testMatch: [parityTests],
      activation: 'E2E_DEV_PREVIEW_PARITY',
    },
    {
      name: 'chromium-dev-parity',
      browser: 'chromium',
      testMatch: [parityTests],
      activation: 'E2E_DEV_PREVIEW_PARITY',
      development: true,
    },
    {
      name: 'chromium-headed-visibility',
      browser: 'chromium',
      testMatch: [/reactive-storage-stress\.spec\.ts$/u],
      activation: 'E2E_HEADED_VISIBILITY',
      headed: true,
      fullyParallel: false,
      workers: 1,
    },
  ]
}

export function projectCollectsFile(project, path) {
  return (
    path.startsWith('tests/e2e/') &&
    project.testMatch.some((pattern) => pattern.test(path)) &&
    !project.testIgnore?.some((pattern) => pattern.test(path))
  )
}

export function selectedPlaywrightProjects(environment = {}) {
  const projects = playwrightProjects()
  if (!environment.E2E_BROWSER_SELECTION) return projects
  const tasks = JSON.parse(environment.E2E_BROWSER_SELECTION)
  const selected = new Map(tasks.map((task) => [task.project, task.files]))
  for (const task of tasks) {
    const project = projects.find((entry) => entry.name === task.project)
    if (
      !project ||
      task.files.length === 0 ||
      task.files.some((file) => !projectCollectsFile(project, file))
    ) {
      throw new Error(`BrowserSelectionInvalid:${task.project}`)
    }
  }
  const dependencies = (name) =>
    selected.has(name)
      ? [name]
      : (projects.find((project) => project.name === name)?.dependencies ?? []).flatMap(
          dependencies,
        )
  return projects
    .filter((project) => selected.has(project.name))
    .map((project) => ({
      ...project,
      testMatch: selected
        .get(project.name)
        .map((file) => new RegExp(`(?:^|/)${file.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u')),
      dependencies: [...new Set((project.dependencies ?? []).flatMap(dependencies))],
    }))
}
