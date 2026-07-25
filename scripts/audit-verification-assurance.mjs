import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { VERIFICATION_STAGES } from './run-verification.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export function auditVerificationAssurance(root = ROOT, stages = VERIFICATION_STAGES) {
  const problems = []
  const inventoryStages = stages.filter((stage) => {
    const modeIndex = stage.argv.indexOf('--mode')
    return modeIndex >= 0 && stage.argv[modeIndex + 1] === 'inventory'
  })

  for (const stage of inventoryStages) {
    const script = stage.argv.find(
      (argument) => argument.startsWith('scripts/') && argument.endsWith('.mjs'),
    )
    if (!script) {
      problems.push(`${stage.id}: inventory stage has no scripts/*.mjs entry point`)
      continue
    }
    let sourceText
    try {
      sourceText = readFileSync(resolve(root, script), 'utf8')
    } catch {
      problems.push(`${stage.id}: missing entry point ${script}`)
      continue
    }
    const source = ts.createSourceFile(script, sourceText, ts.ScriptTarget.Latest, true)
    if (!importsStateContract(source)) {
      problems.push(`${stage.id}: ${script} does not import staticAuditState`)
    }
    if (!spreadsStateContract(source)) {
      problems.push(`${stage.id}: ${script} does not publish the four-state audit contract`)
    }
  }

  return Object.freeze({
    ok: problems.length === 0,
    inventoryStageCount: inventoryStages.length,
    problems: Object.freeze(problems.sort()),
  })
}

function importsStateContract(source) {
  return source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === './audit-result-state.mjs' &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === 'staticAuditState',
      ),
  )
}

function spreadsStateContract(source) {
  let found = false
  visit(source)
  return found

  function visit(node) {
    if (
      ts.isSpreadAssignment(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'staticAuditState'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const report = auditVerificationAssurance()
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!report.ok) process.exitCode = 1
}
