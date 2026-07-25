import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { staticAuditState } from './audit-result-state.mjs'
import * as defaultInventory from './configuration-protocol-inventory.mjs'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import { createProductionTypeScriptProgram } from './production-typescript-source.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const COMMAND_UNION_ID =
  'src/store/configuration-domain-contract.ts#ConfigurationDomainCommandUnion|kind'
const RESULT_UNION_ID =
  'src/store/configuration-domain-contract.ts#ConfigurationDomainResultUnion|kind'

export function buildConfigurationProtocolSourceFacts(options = {}) {
  const program = options.program ?? createProductionTypeScriptProgram(ROOT)
  const report = options.discovered ?? discoverProductionDiscriminatedUnions(ROOT, { program })
  const commandUnion = exactUnion(report.unions, COMMAND_UNION_ID)
  const resultUnion = exactUnion(report.unions, RESULT_UNION_ID)
  const sourceProblems = []
  const constructorsByVariant = new Map(commandUnion.variants.map((variant) => [variant, []]))
  for (const site of commandUnion.constructorSites) {
    constructorsByVariant.get(site.variant)?.push(`${site.path}#${site.owner}`)
    if (site.confidence !== 'type-assignable') {
      sourceProblems.push(`${site.variant}: constructor is not type-assignable: ${site.id}`)
    }
  }
  const resultConstructorsByVariant = new Map(resultUnion.variants.map((variant) => [variant, []]))
  for (const site of resultUnion.constructorSites) {
    resultConstructorsByVariant.get(site.variant)?.push(`${site.path}#${site.owner}`)
    if (site.confidence !== 'type-assignable') {
      sourceProblems.push(`${site.variant}: result constructor is not type-assignable: ${site.id}`)
    }
  }
  for (const variant of resultUnion.variants) {
    if ((resultConstructorsByVariant.get(variant) ?? []).length === 0) {
      sourceProblems.push(`${variant}: result variant has no typed production constructor`)
    }
  }
  const browserConfigurationSource = exactSource(
    program,
    'src/store/browser-configuration-domain.ts',
  )
  const configurationDomainSource = exactSource(program, 'src/store/configuration-domain.ts')
  const configurationContractSource = exactSource(
    program,
    'src/store/configuration-domain-contract.ts',
  )
  const configurationWorkspaceSource = exactSource(program, 'src/store/configuration-workspace.ts')
  const controllerSource = exactSource(program, 'src/store/configuration-controller.ts')
  validateCommittedEffectProjection(configurationWorkspaceSource, controllerSource, sourceProblems)
  const resultMap = interfaceDiscriminantMap(
    program,
    configurationContractSource,
    'ConfigurationDomainResultMap',
    'kind',
  )
  return Object.freeze({
    auditedUnionSubjects: Object.freeze(
      [
        ['command', commandUnion],
        ['result', resultUnion],
      ].map(([name, union]) => Object.freeze({ name, id: union.id })),
    ),
    commandUnion,
    resultUnion,
    constructorsByVariant: frozenArrayRecord(constructorsByVariant),
    browserHandlerVariants: Object.freeze(
      objectLiteralKeys(browserConfigurationSource, 'configurationDomainHandlers'),
    ),
    optimisticStageVariants: Object.freeze(
      switchCaseValues(
        configurationDomainSource,
        'stagePendingConfigurationCommand',
        'command.kind',
      ),
    ),
    resultMap: frozenArrayRecord(resultMap),
    sourceProblems: Object.freeze(sourceProblems.sort()),
  })
}

export function evaluateConfigurationProtocol(
  inventory = defaultInventory,
  mode = 'inventory',
  facts = buildConfigurationProtocolSourceFacts(),
) {
  const { CONFIGURATION_COMMANDS, CONFIGURATION_OPTIMISTIC_STAGE_VARIANTS } = inventory
  const { commandUnion, resultUnion, constructorsByVariant, resultMap } = facts
  const problems = [...facts.sourceProblems]
  compareExact(
    'command inventory variants',
    Object.keys(CONFIGURATION_COMMANDS ?? {}),
    commandUnion.variants,
    problems,
  )
  const gaps = []
  for (const variant of commandUnion.variants) {
    const contract = CONFIGURATION_COMMANDS?.[variant]
    if (!contract) continue
    compareExact(
      `${variant}: constructor owners`,
      contract.owners,
      constructorsByVariant[variant] ?? [],
      problems,
    )
    if (contract.status === 'reachable') {
      if (contract.owners.length === 0) problems.push(`${variant}: reachable command has no owner`)
      if ('gap' in contract) problems.push(`${variant}: reachable command cannot declare a gap`)
    } else if (contract.status === 'gap') {
      if (contract.owners.length > 0) problems.push(`${variant}: gap command cannot declare owners`)
      if (typeof contract.gap !== 'string' || contract.gap.length === 0) {
        problems.push(`${variant}: gap command needs a rationale`)
      } else {
        gaps.push({ variant, rationale: contract.gap })
      }
    } else {
      problems.push(`${variant}: invalid command status ${contract.status}`)
    }
  }
  compareExact(
    'browser handler variants',
    commandUnion.variants,
    facts.browserHandlerVariants,
    problems,
  )
  compareExact(
    'optimistic stage variants',
    CONFIGURATION_OPTIMISTIC_STAGE_VARIANTS ?? [],
    facts.optimisticStageVariants,
    problems,
  )
  compareExact(
    'result-map command variants',
    commandUnion.variants,
    Object.keys(resultMap),
    problems,
  )
  compareExact(
    'result-map result variants',
    resultUnion.variants,
    [...new Set(Object.values(resultMap).flat())],
    problems,
  )
  const structurallyValid = problems.length === 0
  return Object.freeze({
    mode,
    ok: structurallyValid && (mode !== 'enforce' || gaps.length === 0),
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps }),
    commandVariants: commandUnion.variants.length,
    constructorSites: commandUnion.constructorSites.length,
    reachableCommands: commandUnion.variants.length - gaps.length,
    gaps: Object.freeze(gaps),
    resultVariants: resultUnion.variants.length,
    resultConstructorSites: resultUnion.constructorSites.length,
    resultMappings: Object.keys(resultMap).length,
    problems: Object.freeze(problems.sort()),
  })
}

function parseArgs(argv) {
  const parsed = { mode: 'inventory', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg !== '--mode') {
      throw new Error(`Unknown configuration-protocol argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) throw new Error(`Missing value for ${arg}`)
    if (value !== 'inventory' && value !== 'enforce') {
      throw new Error(`Invalid configuration-protocol mode: ${value}`)
    } else {
      parsed.mode = value
    }
    index += 1
  }
  return parsed
}

function exactUnion(unions, id) {
  const matches = unions.filter((entry) => entry.id === id)
  if (matches.length !== 1) throw new Error(`ConfigurationProtocolUnionExpectedOnce:${id}`)
  return matches[0]
}

function exactSource(currentProgram, suffix) {
  const source = currentProgram
    .getSourceFiles()
    .find((candidate) => candidate.fileName.replaceAll('\\', '/').endsWith(`/${suffix}`))
  if (!source) throw new Error(`ConfigurationProtocolSourceMissing:${suffix}`)
  return source
}

function objectLiteralKeys(source, variableName) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        throw new Error(`ConfigurationProtocolObjectInvalid:${variableName}`)
      }
      return initializer.properties
        .flatMap((property) => {
          if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return []
          const name = propertyName(property.name)
          return name ? [name] : []
        })
        .sort()
    }
  }
  throw new Error(`ConfigurationProtocolObjectMissing:${variableName}`)
}

function switchCaseValues(source, functionName, expressionText) {
  const owner = namedFunction(source, functionName)
  const values = []
  visit(owner, (node) => {
    if (!ts.isSwitchStatement(node) || unwrap(node.expression).getText(source) !== expressionText) {
      return
    }
    for (const clause of node.caseBlock.clauses) {
      if (!ts.isCaseClause(clause)) continue
      const value = literalText(clause.expression)
      if (value) values.push(value)
    }
  })
  return values.sort()
}

function namedFunction(source, name) {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
  }
  throw new Error(`ConfigurationProtocolFunctionMissing:${name}`)
}

function interfaceDiscriminantMap(currentProgram, source, interfaceName, discriminant) {
  const declaration = source.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  )
  if (!declaration) throw new Error(`ConfigurationProtocolInterfaceMissing:${interfaceName}`)
  const checker = currentProgram.getTypeChecker()
  const mappings = new Map()
  for (const member of declaration.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue
    const name = propertyName(member.name)
    if (!name) throw new Error(`ConfigurationProtocolMapKeyDynamic:${interfaceName}`)
    const type = checker.getTypeAtLocation(member)
    const variants = (type.isUnion() ? type.types : [type]).flatMap((candidate) => {
      const property = checker.getPropertyOfType(candidate, discriminant)
      if (!property) return []
      const propertyType = checker.getTypeOfSymbolAtLocation(property, member)
      return propertyType.isStringLiteral() ? [propertyType.value] : []
    })
    if (variants.length === 0) {
      throw new Error(`ConfigurationProtocolMapResultUnclassified:${interfaceName}:${name}`)
    }
    mappings.set(name, [...new Set(variants)].sort())
  }
  return mappings
}

function validateCommittedEffectProjection(workspaceSource, controllerSource, output) {
  const workspaceText = workspaceSource.getText()
  const controllerText = controllerSource.getText()
  for (const fragment of [
    'subscribeWorkspaceEffects({',
    'apply: (effect) => this.receiveEffect(effect)',
    'configurationController.observeWorkspaceEffect(effect)',
    'configurationController.recoverWorkspaceEffect(effect)',
  ]) {
    if (!workspaceText.includes(fragment)) {
      output.push(`configuration committed-effect projection proof missing ${fragment}`)
    }
  }
  for (const fragment of [
    'this.reloadActiveFrameForDependencies(effect.impact)',
    'this.publishCatalogChange(effect.impact)',
    "this.reloadActiveFrameForDependencies('all')",
    "this.publishCatalogChange('all')",
  ]) {
    if (!controllerText.includes(fragment)) {
      output.push(`configuration committed-effect projection proof missing ${fragment}`)
    }
  }
}

function frozenArrayRecord(entries) {
  return Object.freeze(
    Object.fromEntries([...entries].map(([key, values]) => [key, Object.freeze([...values])])),
  )
}

function compareExact(label, expected, actual, problems) {
  const expectedValues = [...expected].sort()
  const actualValues = [...actual].sort()
  for (const value of difference(expectedValues, actualValues)) {
    problems.push(`${label}: missing ${value}`)
  }
  for (const value of difference(actualValues, expectedValues)) {
    problems.push(`${label}: unclassified ${value}`)
  }
  for (const value of duplicates(actualValues)) problems.push(`${label}: duplicate ${value}`)
}

function difference(left, right) {
  const rightSet = new Set(right)
  return left.filter((value) => !rightSet.has(value))
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    else seen.add(value)
  }
  return [...repeated].sort()
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined
}

function literalText(expression) {
  const current = unwrap(expression)
  return ts.isStringLiteralLike(current) ? current.text : undefined
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

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2))
  const output = evaluateConfigurationProtocol(defaultInventory, args.mode)
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  } else {
    process.stdout.write(
      `Configuration protocol inventory: commands=${output.commandVariants}, constructors=${output.constructorSites}, reachable=${output.reachableCommands}, gaps=${output.gaps.length}, results=${output.resultVariants}.\n`,
    )
    for (const gap of output.gaps) {
      process.stdout.write(`  gap ${gap.variant}: ${gap.rationale}\n`)
    }
    for (const problem of output.problems) process.stderr.write(`  ${problem}\n`)
  }
  if (!output.ok) process.exitCode = 1
}
