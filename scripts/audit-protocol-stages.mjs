import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import { createProductionTypeScriptProgram } from './production-typescript-source.mjs'
import { PROTOCOL_STAGE_SWITCHES } from './protocol-stage-inventory.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_ROOT = resolve(ROOT, 'src')
const PROTOCOL_STAGE_ROOTS = Object.freeze({
  command: 'src/store/workspace-protocol.ts#WorkspaceCommand|kind',
  query: 'src/store/workspace-protocol.ts#WorkspaceQuery|kind',
})
export function buildProtocolStageSourceFacts(options = {}) {
  const program = options.program ?? createProductionTypeScriptProgram(ROOT)
  const discovered = options.discovered ?? discoverProductionDiscriminatedUnions(ROOT, { program })
  const roots = Object.entries(PROTOCOL_STAGE_ROOTS).map(([subject, id]) => [
    subject,
    exactUnion(discovered.unions, id),
  ])
  const variants = Object.fromEntries(
    roots.map(([subject, union]) => [subject, Object.freeze([...union.variants].sort())]),
  )
  const knownVariants = Object.fromEntries(
    Object.entries(variants).map(([subject, kinds]) => [subject, new Set(kinds)]),
  )
  return Object.freeze({
    auditedUnionSubjects: Object.freeze(
      roots.map(([name, union]) => Object.freeze({ name, id: union.id })),
    ),
    sourceFiles: discovered.sourceFiles,
    variants: Object.freeze(variants),
    switches: Object.freeze(scanProtocolSwitches(program, knownVariants)),
  })
}

export function evaluateProtocolStages(
  manifest = PROTOCOL_STAGE_SWITCHES,
  facts = buildProtocolStageSourceFacts(),
) {
  const problems = []
  const variants = Object.fromEntries(
    Object.entries(facts.variants).map(([subject, kinds]) => [subject, new Set(kinds)]),
  )
  validateManifest(manifest, problems)
  const discoveredById = uniqueById(facts.switches, 'discovered switch', problems)
  const manifestById = uniqueById(manifest, 'manifest switch', problems)

  for (const id of difference(discoveredById.keys(), manifestById.keys())) {
    problems.push(`unclassified protocol stage switch: ${id}`)
  }
  for (const id of difference(manifestById.keys(), discoveredById.keys())) {
    problems.push(`stale protocol stage switch: ${id}`)
  }

  for (const [id, declared] of manifestById) {
    const actual = discoveredById.get(id)
    if (!actual) continue
    if (actual.subject !== declared.subject) {
      problems.push(`${id}: expected subject ${declared.subject}, found ${actual.subject}`)
      continue
    }
    const allowed = variants[declared.subject] ?? new Set()
    const actualKinds = new Set(actual.kinds)
    const staticKinds = new Set(actual.staticKinds)
    for (const kind of difference(actualKinds, allowed)) {
      problems.push(`${id}: unknown ${declared.subject} variant ${kind}`)
    }
    for (const kind of difference(staticKinds, allowed)) {
      problems.push(`${id}: static input has unknown ${declared.subject} variant ${kind}`)
    }
    for (const kind of difference(actualKinds, staticKinds)) {
      problems.push(`${id}: case is outside its typed input ${kind}`)
    }
    for (const kind of difference(staticKinds, actualKinds)) {
      problems.push(`${id}: typed input variant has no case ${kind}`)
    }
  }

  for (const subject of Object.keys(PROTOCOL_STAGE_ROOTS)) {
    const complete = facts.switches.filter(
      (entry) =>
        entry.subject === subject &&
        manifestById.has(entry.id) &&
        sameSet(new Set(entry.staticKinds), variants[subject] ?? new Set()),
    )
    if (complete.length === 0) {
      problems.push(`${subject}: no root-complete protocol stage is declared`)
    }
  }

  return Object.freeze({
    ok: problems.length === 0,
    sourceFiles: facts.sourceFiles,
    variants: facts.variants,
    switches: facts.switches,
    problems: Object.freeze(problems.sort()),
  })
}

function exactUnion(unions, id) {
  const matches = unions.filter((entry) => entry.id === id)
  if (matches.length !== 1) throw new Error(`ProtocolStageUnionExpectedOnce:${id}`)
  return matches[0]
}

function scanProtocolSwitches(currentProgram, knownVariants) {
  const typeChecker = currentProgram.getTypeChecker()
  const switches = []
  const occurrences = new Map()
  for (const source of currentProgram.getSourceFiles().filter(isProductionSource)) {
    const path = relative(ROOT, source.fileName).split(sep).join('/')
    visit(source, (node) => {
      if (!ts.isSwitchStatement(node)) return
      const subject = switchSubject(node.expression)
      if (!subject) return
      const target = unwrap(unwrap(node.expression).expression)
      const staticKinds = discriminantKinds(typeChecker, typeChecker.getTypeAtLocation(target))
      const owner = enclosingOwner(node)
      const stem = `${path}#${owner}|${subject}`
      const occurrence = (occurrences.get(stem) ?? 0) + 1
      occurrences.set(stem, occurrence)
      const kinds = []
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue
        const value = literalText(clause.expression)
        if (value) kinds.push(value)
      }
      if (!kinds.some((kind) => knownVariants[subject].has(kind))) return
      switches.push({
        id: `${stem}|${occurrence}`,
        subject,
        kinds: [...new Set(kinds)].sort(),
        staticKinds: [...staticKinds].sort(),
        coverage: sameSet(staticKinds, knownVariants[subject]) ? 'all' : 'subset',
      })
    })
  }
  return switches.sort(compareIds)
}

function discriminantKinds(typeChecker, inputType) {
  const type = typeChecker.getBaseConstraintOfType(inputType) ?? inputType
  const kinds = new Set()
  for (const member of type.isUnion() ? type.types : [type]) {
    const property = member.getProperty('kind')
    if (!property) continue
    const declaration = property.valueDeclaration ?? property.declarations?.[0]
    if (!declaration) continue
    const propertyType = typeChecker.getTypeOfSymbolAtLocation(property, declaration)
    for (const alternative of propertyType.isUnion() ? propertyType.types : [propertyType]) {
      if (alternative.isStringLiteral()) kinds.add(alternative.value)
    }
  }
  return kinds
}

function switchSubject(expression) {
  const value = unwrap(expression)
  if (!ts.isPropertyAccessExpression(value) || value.name.text !== 'kind') return undefined
  const target = unwrap(value.expression)
  if (!ts.isIdentifier(target)) return undefined
  return target.text === 'command' || target.text === 'query' ? target.text : undefined
}

function literalText(expression) {
  const value = unwrap(expression)
  return ts.isStringLiteralLike(value) ? value.text : undefined
}

function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function enclosingOwner(node) {
  const names = []
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current)) {
      names.push(memberName(current.name) ?? '<computed-method>')
    } else if (
      ts.isFunctionDeclaration(current) ||
      ts.isClassDeclaration(current) ||
      ts.isClassExpression(current)
    ) {
      if (current.name) names.push(current.name.text)
    } else if (
      (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      names.push(current.parent.name.text)
    }
  }
  return names.reverse().join('.') || '<module>'
}

function memberName(name) {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return undefined
}

function validateManifest(manifest, problems) {
  const validSubjects = new Set(Object.keys(PROTOCOL_STAGE_ROOTS))
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') {
      problems.push('protocol stage manifest contains a non-object entry')
      continue
    }
    for (const key of ['id', 'subject', 'role', 'domain', 'reason']) {
      if (typeof entry[key] !== 'string' || entry[key].length === 0) {
        problems.push(`${entry.id ?? '<unknown>'}: missing ${key}`)
      }
    }
    if (!validSubjects.has(entry.subject)) {
      problems.push(`${entry.id ?? '<unknown>'}: invalid subject ${entry.subject}`)
    }
    if ('coverage' in entry || 'expectedKinds' in entry) {
      problems.push(`${entry.id ?? '<unknown>'}: variant coverage must be source-derived`)
    }
  }
}

function uniqueById(entries, label, problems) {
  const byId = new Map()
  for (const entry of entries) {
    if (byId.has(entry.id)) problems.push(`${label} duplicated: ${entry.id}`)
    else byId.set(entry.id, entry)
  }
  return byId
}

function difference(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right)
  return [...left].filter((value) => !rightSet.has(value)).sort()
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function isProductionSource(source) {
  const path = resolve(source.fileName)
  return path.startsWith(`${SRC_ROOT}${sep}`) && /\.tsx?$/u.test(path) && !path.endsWith('.d.ts')
}

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

function compareIds(left, right) {
  return left.id.localeCompare(right.id)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = evaluateProtocolStages()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
}
