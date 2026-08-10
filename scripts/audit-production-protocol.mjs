import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import { createProductionTypeScriptProgram } from './production-typescript-source.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_ROOT = resolve(ROOT, 'src')
const PROTOCOL_FILE = resolve(SRC_ROOT, 'store/workspace-protocol.ts')
const WORKSPACE_RUNTIME_FILE = resolve(SRC_ROOT, 'store/workspace-runtime.ts')

const WORKSPACE_PROTOCOL_ROOTS = Object.freeze({
  WorkspaceQuery: 'src/store/workspace-protocol.ts#WorkspaceQuery|kind',
  WorkspaceCommand: 'src/store/workspace-protocol.ts#WorkspaceCommand|kind',
})

export function buildProductionProtocolSourceFacts(options = {}) {
  const program = options.program ?? createProductionTypeScriptProgram(ROOT)
  const checker = program.getTypeChecker()
  const discovered = options.discovered ?? discoverProductionDiscriminatedUnions(ROOT, { program })
  const protocolSource = exactSource(program, PROTOCOL_FILE)
  const runtimeSource = exactSource(program, WORKSPACE_RUNTIME_FILE)
  const objectLiterals = productionObjectLiteralIndex(program)
  const dependencyProbeDeclarations = declarationKeysFromTypeCapability(
    checker,
    protocolSource,
    'WorkspaceProtocolDependencyProbe',
  )
  const protocols = Object.fromEntries(
    Object.entries(WORKSPACE_PROTOCOL_ROOTS).map(([name, id]) => {
      const union = exactUnion(discovered.unions, id)
      const protocolType = namedType(checker, protocolSource, name)
      return [
        name,
        Object.freeze({
          id,
          variants: Object.freeze([...union.variants].sort()),
          constructorSites: Object.freeze(
            union.constructorSites.map((site) =>
              Object.freeze({
                ...site,
                role: classifyProtocolConstructor(
                  program,
                  checker,
                  site,
                  protocolType,
                  dependencyProbeDeclarations,
                  objectLiterals,
                ),
              }),
            ),
          ),
        }),
      ]
    }),
  )
  const rootKinds = stringLiteralUnion(checker, runtimeSource, 'WorkspaceRootKind')
  const exclusiveRootKinds = stringLiteralUnion(
    checker,
    runtimeSource,
    'WorkspaceExclusiveRootKind',
  )
  const replacementDispositions = stringLiteralUnion(
    checker,
    runtimeSource,
    'WorkspaceReplacementDisposition',
  )
  const rootAdmissionCapabilities = exportedRootAdmissionCapabilities(
    program,
    checker,
    runtimeSource,
    rootKinds,
  )
  const rootAdmissionEvidence = collectRootAdmissions(
    program,
    checker,
    rootAdmissionCapabilities.bySymbol,
    rootAdmissionCapabilities.brand,
  )
  return Object.freeze({
    auditedUnionSubjects: Object.freeze(
      Object.entries(protocols).map(([name, protocol]) => Object.freeze({ name, id: protocol.id })),
    ),
    sourceFiles: discovered.sourceFiles,
    protocols: Object.freeze(protocols),
    rootKinds: Object.freeze(rootKinds),
    exclusiveRootKinds: Object.freeze(exclusiveRootKinds),
    replacementDispositions: Object.freeze(replacementDispositions),
    rootReplacementDispositions: Object.freeze(
      Object.fromEntries(rootReplacementDispositionEntries(runtimeSource)),
    ),
    rootAdmissionFunctions: rootAdmissionCapabilities.definitions.length,
    rootAdmissionDefinitions: rootAdmissionCapabilities.definitions,
    rootAdmissions: rootAdmissionEvidence.sites,
    rootCapabilityEscapes: rootAdmissionEvidence.escapes,
    rootCapabilityProblems: Object.freeze(
      [...rootAdmissionCapabilities.problems, ...rootAdmissionEvidence.problems].sort(),
    ),
  })
}

export function evaluateProductionProtocol(facts = buildProductionProtocolSourceFacts()) {
  const problems = [...(facts.rootCapabilityProblems ?? [])]
  const protocols = Object.fromEntries(
    Object.entries(facts.protocols).map(([name, protocol]) => {
      const ingressByVariant = new Map(protocol.variants.map((variant) => [variant, []]))
      const probesByVariant = new Map(protocol.variants.map((variant) => [variant, []]))
      const unclassified = []
      for (const site of protocol.constructorSites) {
        if (!protocol.variants.includes(site.variant)) {
          problems.push(
            `${name}.${site.variant}: constructor is not a protocol variant: ${site.id}`,
          )
          continue
        }
        if (site.confidence !== 'type-assignable') {
          problems.push(`${name}.${site.variant}: constructor is not type-assignable: ${site.id}`)
        }
        if (site.role === 'ingress') ingressByVariant.get(site.variant)?.push(site)
        else if (site.role === 'dependency-probe') probesByVariant.get(site.variant)?.push(site)
        else {
          unclassified.push(site)
          problems.push(`${name}.${site.variant}: constructor has no typed role: ${site.id}`)
        }
      }
      const missingIngress = protocol.variants.filter(
        (variant) => (ingressByVariant.get(variant) ?? []).length === 0,
      )
      for (const variant of missingIngress) {
        const probeCount = probesByVariant.get(variant)?.length ?? 0
        problems.push(
          `${name}.${variant}: no typed production ingress` +
            (probeCount > 0
              ? ` (${probeCount} dependency probe${probeCount === 1 ? '' : 's'} only)`
              : ''),
        )
      }
      return [
        name,
        Object.freeze({
          id: protocol.id,
          variants: protocol.variants,
          constructorSites: protocol.constructorSites,
          ingressSites: [...ingressByVariant.values()].reduce(
            (total, sites) => total + sites.length,
            0,
          ),
          dependencyProbeSites: [...probesByVariant.values()].reduce(
            (total, sites) => total + sites.length,
            0,
          ),
          unclassifiedSites: unclassified.length,
          missingIngress: Object.freeze(missingIngress),
        }),
      ]
    }),
  )

  compareExact(
    'workspace root replacement keys',
    Object.keys(facts.rootReplacementDispositions),
    facts.rootKinds,
    problems,
  )
  for (const [kind, disposition] of Object.entries(facts.rootReplacementDispositions)) {
    if (!facts.replacementDispositions.includes(disposition)) {
      problems.push(`${kind}: invalid workspace replacement disposition ${disposition}`)
    }
  }
  for (const kind of facts.exclusiveRootKinds) {
    if (!facts.rootKinds.includes(kind)) {
      problems.push(`${kind}: exclusive workspace root is not a WorkspaceRootKind`)
    }
  }
  for (const capabilityEscape of facts.rootCapabilityEscapes ?? []) {
    problems.push(
      `${capabilityEscape.path}:${capabilityEscape.line}: root admission capability escapes direct invocation: ${capabilityEscape.admission}`,
    )
  }

  const admissionsByRoot = new Map(facts.rootKinds.map((kind) => [kind, []]))
  let finiteAdmissions = 0
  let unboundedAdmissions = 0
  for (const site of facts.rootAdmissions) {
    if (!Array.isArray(site.kinds) || site.kinds.length === 0) {
      unboundedAdmissions += 1
      problems.push(`${site.path}:${site.line}: root admission is not a finite static kind set`)
      continue
    }
    finiteAdmissions += 1
    for (const kind of site.kinds) {
      if (!facts.rootKinds.includes(kind)) {
        problems.push(`${site.path}:${site.line}: unexpected workspace root ${kind}`)
        continue
      }
      admissionsByRoot.get(kind)?.push(site)
    }
    for (const exclusiveKind of facts.exclusiveRootKinds) {
      if (site.kinds.includes(exclusiveKind) && site.kinds.length !== 1) {
        problems.push(
          `${site.path}:${site.line}: exclusive root ${exclusiveKind} shares an admission capability`,
        )
      }
    }
  }
  for (const kind of facts.rootKinds) {
    if ((admissionsByRoot.get(kind) ?? []).length === 0) {
      problems.push(`${kind}: no typed production root admission`)
    }
  }
  for (const kind of facts.exclusiveRootKinds) {
    const owners = [
      ...new Set(
        (admissionsByRoot.get(kind) ?? []).map((site) => `${site.path}#${site.ownerOffset}`),
      ),
    ].sort()
    if (owners.length !== 1) {
      problems.push(
        `${kind}: exclusive root needs exactly one production admission owner, found ${owners.length}`,
      )
    }
  }

  return Object.freeze({
    ok: problems.length === 0,
    sourceFiles: facts.sourceFiles,
    protocols: Object.freeze(protocols),
    roots: Object.freeze({
      variants: facts.rootKinds.length,
      exclusiveVariants: facts.exclusiveRootKinds.length,
      admissionFunctions: facts.rootAdmissionFunctions,
      admissionDefinitions: facts.rootAdmissionDefinitions ?? [],
      finiteAdmissions,
      unboundedAdmissions,
      capabilityEscapes: facts.rootCapabilityEscapes?.length ?? 0,
      replacementDispositions: Object.freeze({ ...facts.rootReplacementDispositions }),
      admissions: facts.rootAdmissions,
    }),
    problems: Object.freeze(problems.sort()),
  })
}

function exactUnion(unions, id) {
  const matches = unions.filter((union) => union.id === id)
  if (matches.length !== 1) throw new Error(`ProductionProtocolUnionExpectedOnce:${id}`)
  return matches[0]
}

function exactSource(program, path) {
  const source = program.getSourceFile(path)
  if (!source) throw new Error(`ProductionProtocolSourceMissing:${relative(ROOT, path)}`)
  return source
}

function namedType(checker, source, typeName) {
  const declaration = source.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  )
  if (!declaration) throw new Error(`ProductionProtocolTypeMissing:${typeName}`)
  return checker.getTypeFromTypeNode(declaration.type)
}

function stringLiteralUnion(checker, source, typeName) {
  const values = finiteStringLiteralValues(checker, namedType(checker, source, typeName))
  if (!values) throw new Error(`ProductionProtocolTypeNotStringLiteralUnion:${typeName}`)
  return values
}

function declarationKeysFromTypeCapability(checker, source, typeName) {
  const declaration = source.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  )
  if (!declaration) throw new Error(`ProductionProtocolCapabilityMissing:${typeName}`)
  const keys = new Set()
  visit(declaration.type, (node) => {
    if (!ts.isTypeQueryNode(node)) return
    let symbol = checker.getSymbolAtLocation(node.exprName)
    if (!symbol) return
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    const location = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? node
    const type = checker.getTypeOfSymbolAtLocation(symbol, location)
    for (const signature of type.getCallSignatures()) {
      if (signature.declaration) keys.add(declarationKey(signature.declaration))
    }
  })
  if (keys.size === 0) throw new Error(`ProductionProtocolCapabilityEmpty:${typeName}`)
  return keys
}

function classifyProtocolConstructor(
  program,
  checker,
  site,
  protocolType,
  dependencyProbeDeclarations,
  objectLiterals,
) {
  const source = program.getSourceFile(resolve(ROOT, site.path))
  if (!source) return 'unclassified'
  const node = objectLiterals.get(`${resolve(source.fileName)}:${site.offset}`)
  if (!node) return 'unclassified'
  const carrier = liftTransparentExpression(node)
  const call = ts.isCallExpression(carrier.parent) ? carrier.parent : null
  if (!call) return 'unclassified'
  const argumentIndex = call.arguments.indexOf(carrier)
  if (argumentIndex < 0) return 'unclassified'
  const signature = checker.getResolvedSignature(call)
  if (!signature?.declaration) return 'unclassified'
  if (dependencyProbeDeclarations.has(declarationKey(signature.declaration))) {
    return 'dependency-probe'
  }
  const parameter = declaredParameter(signature.declaration, argumentIndex)
  if (!parameter) return 'unclassified'
  const parameterType = checker.getTypeAtLocation(parameter)
  const constrained = checker.getBaseConstraintOfType(parameterType) ?? parameterType
  return checker.isTypeAssignableTo(constrained, protocolType) ? 'ingress' : 'unclassified'
}

function productionObjectLiteralIndex(program) {
  const index = new Map()
  for (const source of program.getSourceFiles().filter(isProductionSource)) {
    visit(source, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return
      index.set(`${resolve(source.fileName)}:${node.getStart(source)}`, node)
    })
  }
  return index
}

function liftTransparentExpression(node) {
  let current = node
  while (
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent
  }
  return current
}

function declaredParameter(declaration, argumentIndex) {
  const parameters = declaration.parameters
  if (!parameters || parameters.length === 0) return null
  if (argumentIndex < parameters.length) return parameters[argumentIndex]
  const last = parameters.at(-1)
  return last?.dotDotDotToken ? last : null
}

function exportedRootAdmissionCapabilities(program, checker, runtimeSource, rootKinds) {
  const brand = namedValueSymbol(checker, runtimeSource, 'workspaceRootAdmissionCapabilityBrand')
  const bySymbol = new Map()
  const problems = [...rootAdmissionIssuanceProblems(program, checker, brand)]
  for (const source of program.getSourceFiles().filter(isProductionSource)) {
    const moduleSymbol = checker.getSymbolAtLocation(source)
    if (!moduleSymbol) continue
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolveAlias(checker, exported)
      const location = symbol.valueDeclaration ?? symbol.declarations?.[0]
      if (!location) continue
      const type = checker.getTypeOfSymbolAtLocation(symbol, location)
      const marker = rootAdmissionMarker(checker, type, brand)
      if (!marker) continue
      const descriptor = checker.getTypeOfSymbolAtLocation(marker, location)
      const parsed = rootAdmissionDescriptor(checker, descriptor, type, rootKinds)
      const path = relative(ROOT, location.getSourceFile().fileName).split(sep).join('/')
      const start = location
        .getSourceFile()
        .getLineAndCharacterOfPosition(location.getStart(location.getSourceFile()))
      const key = symbolKey(symbol)
      if (!key) {
        problems.push(`${path}:${start.line + 1}: root admission capability has no declaration`)
        continue
      }
      if (parsed.problem) {
        problems.push(`${path}:${start.line + 1}: ${parsed.problem}`)
        continue
      }
      const originProblem = rootAdmissionOriginProblem(checker, location, parsed)
      if (originProblem) {
        problems.push(`${path}:${start.line + 1}: ${originProblem}`)
        continue
      }
      const existing = bySymbol.get(key)
      if (existing && !sameRootCapability(existing, parsed)) {
        problems.push(`${path}:${start.line + 1}: root admission capability aliases disagree`)
        continue
      }
      if (!existing) {
        bySymbol.set(key, {
          ...parsed,
          name: exported.name,
          path,
          line: start.line + 1,
          column: start.character + 1,
        })
      }
    }
  }
  if (bySymbol.size === 0) throw new Error('WorkspaceRootAdmissionCapabilityMissing')
  const definitions = [...bySymbol.values()]
    .map(({ name, path, line, column, source, kindArgument, allowedKinds }) =>
      Object.freeze({ name, path, line, column, source, kindArgument, allowedKinds }),
    )
    .sort(compareSourceSites)
  return Object.freeze({
    brand,
    bySymbol,
    definitions: Object.freeze(definitions),
    problems: Object.freeze(problems.sort()),
  })
}

function rootAdmissionOriginProblem(checker, declaration, descriptor) {
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return 'root admission capability is not issued by a variable initializer'
  }
  const initializer = unwrap(declaration.initializer)
  if (!ts.isCallExpression(initializer)) {
    return 'root admission capability bypasses its typed issuance owner'
  }
  const issuer = calledValueSymbol(checker, initializer.expression)
  const issuerDeclaration = issuer?.valueDeclaration ?? issuer?.declarations?.[0]
  if (!issuer || !issuerDeclaration) {
    return 'root admission capability issuer cannot be resolved'
  }
  const issuerPath = relative(ROOT, issuerDeclaration.getSourceFile().fileName).split(sep).join('/')
  if (descriptor.source === 'argument') {
    if (
      issuer.name !== 'exposeWorkspaceRootAdmission' ||
      issuerPath !== 'src/store/workspace-runtime.ts'
    ) {
      return 'argument-root capability bypasses exposeWorkspaceRootAdmission'
    }
    const target = initializer.arguments[0] ? unwrap(initializer.arguments[0]) : null
    if (!target || !ts.isPropertyAccessExpression(target)) {
      return 'argument-root capability does not expose a direct runtime admission'
    }
    if (
      !ts.isIdentifier(target.expression) ||
      target.expression.text !== 'productionWorkspaceRuntime'
    ) {
      return 'argument-root capability does not originate from the production runtime kernel'
    }
    if (!ts.isIdentifier(declaration.name) || target.name.text !== declaration.name.text) {
      return 'argument-root capability export does not match its runtime admission'
    }
    return null
  }
  if (
    issuer.name !== 'createWorkspaceReplacementAdmission' ||
    issuerPath !== 'src/store/workspace-runtime-control.ts'
  ) {
    return 'fixed-root capability bypasses createWorkspaceReplacementAdmission'
  }
  const kind = initializer.arguments[0]
  const requireIdle = initializer.arguments[1]
  const target = initializer.arguments[2] ? unwrap(initializer.arguments[2]) : null
  if (!kind || !ts.isStringLiteral(kind) || !descriptor.allowedKinds.includes(kind.text)) {
    return 'fixed-root capability metadata disagrees with its bound root'
  }
  const expectedRequireIdle = kind.text === 'maintenance'
  if (
    !requireIdle ||
    (expectedRequireIdle
      ? requireIdle.kind !== ts.SyntaxKind.TrueKeyword
      : requireIdle.kind !== ts.SyntaxKind.FalseKeyword)
  ) {
    return 'fixed-root capability has the wrong idle-admission policy'
  }
  if (
    !target ||
    !ts.isPropertyAccessExpression(target) ||
    !ts.isIdentifier(target.expression) ||
    target.expression.text !== 'productionWorkspaceRuntimeControl' ||
    ![
      'launchWorkspaceRuntimeReplacementNow',
      'launchWorkspaceRuntimeReplacementWhenUnblocked',
    ].includes(target.name.text)
  ) {
    return 'fixed-root capability does not bind the production replacement admission'
  }
  return null
}

function rootAdmissionIssuanceProblems(program, checker, brand) {
  const allowedOwners = new Map([
    ['src/store/workspace-runtime.ts#exposeWorkspaceRootAdmission', 0],
    ['src/store/workspace-runtime-control.ts#createWorkspaceReplacementAdmission', 0],
  ])
  const problems = []
  for (const source of program.getSourceFiles().filter(isProductionSource)) {
    visit(source, (node) => {
      if (!ts.isAsExpression(node) && !ts.isTypeAssertionExpression(node)) return
      if (!rootAdmissionMarker(checker, checker.getTypeAtLocation(node), brand)) return
      const path = relative(ROOT, source.fileName).split(sep).join('/')
      const owner = enclosingOwnerRecord(node).name
      const key = `${path}#${owner}`
      if (!allowedOwners.has(key)) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source))
        problems.push(
          `${path}:${start.line + 1}: root admission capability forged outside its issuance owner`,
        )
        return
      }
      allowedOwners.set(key, (allowedOwners.get(key) ?? 0) + 1)
    })
  }
  for (const [owner, count] of allowedOwners) {
    if (count !== 1)
      problems.push(`${owner}: expected exactly one capability issuance cast, found ${count}`)
  }
  return Object.freeze(problems.sort())
}

function rootAdmissionDescriptor(checker, descriptor, capabilityType, rootKinds) {
  const kindArgument = checker.getPropertyOfType(descriptor, 'kindArgument')
  const fixedKind = checker.getPropertyOfType(descriptor, 'fixedKind')
  if (kindArgument && fixedKind) {
    return { problem: 'root admission capability has two kind sources' }
  }
  if (kindArgument) {
    const location = kindArgument.valueDeclaration ?? kindArgument.declarations?.[0]
    const indices = location
      ? finiteNumberLiteralValues(
          checker,
          checker.getTypeOfSymbolAtLocation(kindArgument, location),
        )
      : null
    if (indices?.length !== 1 || indices[0] !== 0) {
      return { problem: 'root admission capability kindArgument must be exactly 0' }
    }
    const signatures = capabilityType.getCallSignatures()
    if (signatures.length === 0) {
      return { problem: 'root admission capability is not callable' }
    }
    const allowedKinds = new Set()
    for (const signature of signatures) {
      const parameter = signature.parameters[0]
      const declaration = parameter?.valueDeclaration ?? parameter?.declarations?.[0]
      const values =
        parameter && declaration
          ? finiteStringLiteralValues(
              checker,
              checker.getTypeOfSymbolAtLocation(parameter, declaration),
            )
          : null
      if (!values || values.length === 0) {
        return { problem: 'root admission capability kind argument is not finite' }
      }
      for (const value of values) allowedKinds.add(value)
    }
    const values = [...allowedKinds].sort()
    if (values.some((value) => !rootKinds.includes(value))) {
      return { problem: `root admission capability includes non-root kinds ${values.join(',')}` }
    }
    return {
      source: 'argument',
      kindArgument: 0,
      allowedKinds: Object.freeze(values),
    }
  }
  if (fixedKind) {
    const location = fixedKind.valueDeclaration ?? fixedKind.declarations?.[0]
    const values = location
      ? finiteStringLiteralValues(checker, checker.getTypeOfSymbolAtLocation(fixedKind, location))
      : null
    if (values?.length !== 1 || !rootKinds.includes(values[0])) {
      return { problem: 'root admission capability fixedKind must be exactly one workspace root' }
    }
    if (capabilityType.getCallSignatures().length === 0) {
      return { problem: 'root admission capability is not callable' }
    }
    return {
      source: 'fixed',
      kindArgument: null,
      allowedKinds: Object.freeze(values),
    }
  }
  return { problem: 'root admission capability has no kind source' }
}

function rootAdmissionMarker(checker, capabilityType, brand) {
  const brandKey = symbolKey(brand)
  for (const property of checker.getPropertiesOfType(capabilityType)) {
    for (const declaration of property.declarations ?? []) {
      if (!ts.isComputedPropertyName(declaration.name)) continue
      const symbol = resolveNodeSymbol(checker, declaration.name.expression)
      if (symbolKey(symbol) === brandKey) return property
    }
  }
  return null
}

function collectRootAdmissions(program, checker, capabilities, brand) {
  const sites = []
  const escapes = []
  const problems = []
  for (const source of program.getSourceFiles().filter(isProductionSource)) {
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return
      const symbol = calledValueSymbol(checker, node.expression)
      const capability = symbol ? capabilities.get(symbolKey(symbol)) : undefined
      if (!capability) {
        if (rootAdmissionMarker(checker, checker.getTypeAtLocation(node.expression), brand)) {
          const start = source.getLineAndCharacterOfPosition(node.getStart(source))
          const path = relative(ROOT, source.fileName).split(sep).join('/')
          problems.push(`${path}:${start.line + 1}: unregistered root admission capability invoked`)
        }
        return
      }
      const argument =
        capability.source === 'argument' ? node.arguments[capability.kindArgument] : undefined
      const kinds =
        capability.source === 'fixed'
          ? capability.allowedKinds
          : argument
            ? finiteStringLiteralValues(checker, checker.getTypeAtLocation(argument))
            : null
      const start = source.getLineAndCharacterOfPosition(node.getStart(source))
      const owner = enclosingOwnerRecord(node)
      sites.push({
        path: relative(ROOT, source.fileName).split(sep).join('/'),
        line: start.line + 1,
        column: start.character + 1,
        offset: node.getStart(source),
        owner: owner.name,
        ownerOffset: owner.offset,
        admission: capability.name,
        kinds,
      })
    })
    visit(source, (node) => {
      if (!ts.isIdentifier(node)) return
      const symbol = resolveNodeSymbol(checker, node)
      const capability = symbol ? capabilities.get(symbolKey(symbol)) : undefined
      if (!capability || isAllowedCapabilityReference(node)) return
      const start = source.getLineAndCharacterOfPosition(node.getStart(source))
      escapes.push({
        path: relative(ROOT, source.fileName).split(sep).join('/'),
        line: start.line + 1,
        column: start.character + 1,
        offset: node.getStart(source),
        admission: capability.name,
      })
    })
  }
  return Object.freeze({
    sites: Object.freeze(sites.sort(compareSourceSites)),
    escapes: Object.freeze(escapes.sort(compareSourceSites)),
    problems: Object.freeze(problems.sort()),
  })
}

function finiteStringLiteralValues(checker, input, seen = new Set()) {
  if (input.isStringLiteral()) return [input.value]
  if (seen.has(input)) return null
  seen.add(input)
  if (input.isUnion()) {
    const values = []
    for (const member of input.types) {
      const memberValues = finiteStringLiteralValues(checker, member, seen)
      if (!memberValues) return null
      values.push(...memberValues)
    }
    return [...new Set(values)].sort()
  }
  const constraint = checker.getBaseConstraintOfType(input)
  if (constraint && constraint !== input) {
    return finiteStringLiteralValues(checker, constraint, seen)
  }
  return null
}

function finiteNumberLiteralValues(checker, input, seen = new Set()) {
  if (input.isNumberLiteral()) return [input.value]
  if (seen.has(input)) return null
  seen.add(input)
  if (input.isUnion()) {
    const values = []
    for (const member of input.types) {
      const memberValues = finiteNumberLiteralValues(checker, member, seen)
      if (!memberValues) return null
      values.push(...memberValues)
    }
    return [...new Set(values)].sort((left, right) => left - right)
  }
  const constraint = checker.getBaseConstraintOfType(input)
  if (constraint && constraint !== input) {
    return finiteNumberLiteralValues(checker, constraint, seen)
  }
  return null
}

function namedValueSymbol(checker, source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const symbol = checker.getSymbolAtLocation(declaration.name)
      if (symbol) return symbol
    }
  }
  throw new Error(`ProductionProtocolValueMissing:${name}`)
}

function resolveAlias(checker, symbol) {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
}

function resolveNodeSymbol(checker, node) {
  const symbol = checker.getSymbolAtLocation(node)
  return symbol ? resolveAlias(checker, symbol) : null
}

function calledValueSymbol(checker, expression) {
  const target = unwrap(expression)
  if (ts.isIdentifier(target)) return resolveNodeSymbol(checker, target)
  if (ts.isPropertyAccessExpression(target)) return resolveNodeSymbol(checker, target.name)
  if (ts.isElementAccessExpression(target))
    return resolveNodeSymbol(checker, target.argumentExpression)
  return null
}

function symbolKey(symbol) {
  const declarations =
    symbol?.declarations ?? (symbol?.valueDeclaration ? [symbol.valueDeclaration] : [])
  if (declarations.length === 0) return null
  return declarations.map(declarationKey).sort().join('|')
}

function sameRootCapability(left, right) {
  return (
    left.source === right.source &&
    left.kindArgument === right.kindArgument &&
    left.allowedKinds.length === right.allowedKinds.length &&
    left.allowedKinds.every((kind, index) => kind === right.allowedKinds[index])
  )
}

function isAllowedCapabilityReference(node) {
  if (
    (ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
    ts.isImportSpecifier(node.parent) ||
    ts.isExportSpecifier(node.parent)
  ) {
    return true
  }
  let expression = node
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) {
    expression = node.parent
  }
  while (
    (ts.isParenthesizedExpression(expression.parent) ||
      ts.isAsExpression(expression.parent) ||
      ts.isSatisfiesExpression(expression.parent) ||
      ts.isTypeAssertionExpression(expression.parent) ||
      ts.isNonNullExpression(expression.parent)) &&
    expression.parent.expression === expression
  ) {
    expression = expression.parent
  }
  return ts.isCallExpression(expression.parent) && expression.parent.expression === expression
}

function rootReplacementDispositionEntries(source) {
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === 'WORKSPACE_ROOT_REPLACEMENT_DISPOSITIONS',
    )
  let initializer = declaration?.initializer
  if (
    initializer &&
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    initializer.expression.expression.getText(source) === 'Object' &&
    initializer.expression.name.text === 'freeze'
  ) {
    initializer = initializer.arguments[0]
  }
  const value = initializer ? unwrap(initializer) : undefined
  if (!value || !ts.isObjectLiteralExpression(value)) {
    throw new Error('WorkspaceRootReplacementDispositionMapInvalid')
  }
  return value.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return []
    const key = propertyName(property.name)
    const disposition = literalText(property.initializer)
    return key && disposition ? [[key, disposition]] : []
  })
}

function declarationKey(node) {
  const original = ts.getOriginalNode(node)
  const source = original.getSourceFile()
  return `${resolve(source.fileName)}:${original.getStart(source)}:${original.getEnd()}`
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined
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

function enclosingOwnerRecord(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return { name: enclosingOwner(node), offset: current.getStart(current.getSourceFile()) }
    }
  }
  return { name: '<module>', offset: 0 }
}

function enclosingOwner(node) {
  const names = []
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current)) {
      names.push(propertyName(current.name) ?? '<computed-method>')
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

function compareExact(label, actual, expected, problems) {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  for (const value of [...expectedSet].filter((candidate) => !actualSet.has(candidate)).sort()) {
    problems.push(`${label}: missing ${value}`)
  }
  for (const value of [...actualSet].filter((candidate) => !expectedSet.has(candidate)).sort()) {
    problems.push(`${label}: unexpected ${value}`)
  }
}

function compareSourceSites(left, right) {
  return left.path.localeCompare(right.path) || left.offset - right.offset
}

function isProductionSource(source) {
  const path = resolve(source.fileName)
  return path.startsWith(`${SRC_ROOT}${sep}`) && /\.tsx?$/u.test(path) && !path.endsWith('.d.ts')
}

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}

function printHumanReport(report, inventory) {
  for (const [name, protocol] of Object.entries(report.protocols)) {
    process.stdout.write(
      `${name}: ${protocol.variants.length} variants, ${protocol.ingressSites} ingress constructors, ` +
        `${protocol.dependencyProbeSites} dependency probes, ${protocol.unclassifiedSites} unclassified, ` +
        `${protocol.missingIngress.length} missing ingress\n`,
    )
    if (inventory) {
      for (const variant of protocol.variants) {
        const sites = protocol.constructorSites.filter((site) => site.variant === variant)
        process.stdout.write(
          `  ${variant}${sites.length > 0 ? ` <- ${sites.map((site) => `${site.path}:${site.line}:${site.column} [${site.role}]`).join(', ')}` : ''}\n`,
        )
      }
    }
  }
  process.stdout.write(
    `Workspace roots: ${report.roots.variants} variants, ${report.roots.admissionFunctions} typed admission functions, ` +
      `${report.roots.finiteAdmissions} finite admissions, ${report.roots.unboundedAdmissions} unbounded admissions, ` +
      `${report.roots.exclusiveVariants} exclusive roots\n`,
  )
  for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = evaluateProductionProtocol()
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else printHumanReport(report, process.argv.includes('--inventory'))
  if (!report.ok) process.exitCode = 1
}
