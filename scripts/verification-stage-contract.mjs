export function verificationStage(id, label, policy, argv, options = {}) {
  return Object.freeze({
    ...options,
    id,
    label,
    policy,
    argv: Object.freeze([...argv]),
    kind: options.kind ?? 'node',
    ...(options.performanceStageAliases
      ? { performanceStageAliases: Object.freeze({ ...options.performanceStageAliases }) }
      : {}),
    ...(options.environment ? { environment: Object.freeze({ ...options.environment }) } : {}),
    stderr: options.stderr ?? 'allow',
    nodeOptions: Object.freeze([...(options.nodeOptions ?? [])]),
    prerequisites: Object.freeze(
      (options.prerequisites ?? []).map((dependency) =>
        Object.freeze({
          ...dependency,
          ...(dependency.consumerModules
            ? { consumerModules: Object.freeze([...dependency.consumerModules]) }
            : {}),
        }),
      ),
    ),
    inputPaths: Object.freeze([...(options.inputPaths ?? [])]),
    inputPrefixes: Object.freeze([...(options.inputPrefixes ?? [])]),
    ...(options.unitFiles ? { unitFiles: Object.freeze([...options.unitFiles]) } : {}),
    ...(options.browserProjects
      ? { browserProjects: Object.freeze([...options.browserProjects]) }
      : {}),
    ...(options.browserTasks
      ? {
          browserTasks: Object.freeze(
            options.browserTasks.map((task) =>
              Object.freeze({
                project: task.project,
                files: Object.freeze([...task.files]),
              }),
            ),
          ),
        }
      : {}),
  })
}

export function verificationStageAssurance(item) {
  if (item.assurance) return item.assurance
  if (item.policy === 'advisory') return 'hygiene'
  if (item.argv.some((arg, index) => arg === '--mode' && item.argv[index + 1] === 'inventory')) {
    return 'inventory'
  }
  if (item.kind === 'vitest' || item.kind === 'playwright') return 'runtime'
  return 'guarantee'
}

export function verificationStageStatus(item, execution) {
  if (execution.exitCode !== 0 || execution.signal !== null || execution.diagnostics.length > 0) {
    return 'failed'
  }
  return verificationStageAssurance(item) === 'inventory' ? 'inventoried' : 'passed'
}

export function resolveVerificationStagePrerequisites(selected, catalog, inputPaths = null) {
  const byId = new Map(catalog.map((item) => [item.id, item]))
  for (const item of selected) byId.set(item.id, item)
  const resolved = new Map()
  const visiting = new Set()
  const visit = (item) => {
    if (resolved.has(item.id)) return
    if (visiting.has(item.id)) throw new Error(`VerificationStagePrerequisiteCycle:${item.id}`)
    visiting.add(item.id)
    const prerequisiteIds =
      inputPaths === null && item.prerequisiteIds !== undefined
        ? item.prerequisiteIds
        : (item.prerequisites ?? [])
            .filter(
              (dependency) =>
                inputPaths === null ||
                !dependency.consumerModules ||
                dependency.consumerModules.some((path) => inputPaths.has(path)),
            )
            .map((dependency) => dependency.id)
    for (const id of prerequisiteIds) {
      const dependency = byId.get(id)
      if (!dependency) throw new Error(`VerificationStagePrerequisiteMissing:${item.id}:${id}`)
      visit(dependency)
    }
    visiting.delete(item.id)
    resolved.set(
      item.id,
      Object.freeze({ ...item, prerequisiteIds: Object.freeze([...prerequisiteIds]) }),
    )
  }
  for (const item of selected) visit(item)
  const rank = (item) => {
    const index = catalog.findIndex(
      (candidate) =>
        candidate.id === item.id ||
        (item.kind === 'playwright' &&
          candidate.kind === 'playwright' &&
          item.browserProjects?.length > 0 &&
          item.browserProjects.every((project) => candidate.browserProjects?.includes(project))),
    )
    return index < 0 ? catalog.length : index
  }
  const ordered = new Map()
  const append = (item) => {
    if (ordered.has(item.id)) return
    for (const dependency of item.prerequisiteIds
      .map((id) => resolved.get(id))
      .sort((left, right) => rank(left) - rank(right))) {
      append(dependency)
    }
    ordered.set(item.id, item)
  }
  for (const item of [...resolved.values()].sort((left, right) => rank(left) - rank(right))) {
    append(item)
  }
  return Object.freeze([...ordered.values()])
}

export function verificationPrerequisiteDiagnostics(item, results) {
  const byId = new Map(results.map((result) => [result.stageId ?? result.id, result]))
  return (item.prerequisiteIds ?? []).flatMap((id) => {
    const status = byId.get(id)?.status
    return status === 'passed' || status === 'inventoried'
      ? []
      : [`VerificationStagePrerequisiteUnfulfilled:${item.id}:${id}:${status ?? 'missing'}`]
  })
}

export function verificationStageBlocks(result) {
  return result.policy === 'blocking' && result.status === 'failed'
}

const VERIFICATION_STAGE_SOURCE_PATH = 'scripts/run-verification.mjs'

export function verificationStageReference(id, expected) {
  return Object.freeze({
    path: VERIFICATION_STAGE_SOURCE_PATH,
    stage: Object.freeze({
      ...expected,
      id,
      ...(expected.browserProjects
        ? { browserProjects: Object.freeze([...expected.browserProjects]) }
        : {}),
    }),
  })
}

export function verificationStageReferenceProblems(reference, stages) {
  const expected = reference.stage
  if (
    reference.path !== VERIFICATION_STAGE_SOURCE_PATH ||
    reference.locator !== undefined ||
    reference.requiredLocators !== undefined ||
    typeof expected?.id !== 'string' ||
    !expected.id ||
    !['blocking', 'advisory'].includes(expected.policy) ||
    !['node', 'vitest', 'playwright'].includes(expected.kind) ||
    (expected.kind === 'playwright' &&
      (!Array.isArray(expected.browserProjects) ||
        !expected.browserProjects.length ||
        expected.browserProjects.some((project) => typeof project !== 'string' || !project)))
  ) {
    return ['VerificationStageReferenceInvalid']
  }
  const matches = stages.filter(({ id }) => id === expected.id)
  if (matches.length !== 1)
    return [`VerificationStageReferenceCardinality:${expected.id}:${matches.length}`]
  const actual = matches[0]
  const problems = []
  if (actual.policy !== expected.policy)
    problems.push(
      `VerificationStageReferencePolicy:${expected.id}:${expected.policy}:${actual.policy}`,
    )
  if (actual.kind !== expected.kind)
    problems.push(`VerificationStageReferenceKind:${expected.id}:${expected.kind}:${actual.kind}`)
  if (
    expected.kind === 'playwright' &&
    JSON.stringify([...(actual.browserProjects ?? [])].sort()) !==
      JSON.stringify([...expected.browserProjects].sort())
  )
    problems.push(`VerificationStageReferenceBrowserProjects:${expected.id}`)
  return problems
}
