import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import {
  createProductionTypeScriptProgram,
  productionTypeScriptSources,
} from './production-typescript-source.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')

export function discoverProductionDiscriminatedUnions(root = DEFAULT_ROOT, options = {}) {
  const program = options.program ?? createProductionTypeScriptProgram(root)
  const checker = program.getTypeChecker()
  const productionSources = productionTypeScriptSources(program, root)
  const unions = []
  const runtimeUnions = []

  for (const source of productionSources) {
    const path = relative(root, source.fileName).split(sep).join('/')
    for (const statement of source.statements) {
      if (!ts.isTypeAliasDeclaration(statement)) continue
      const type = checker.getTypeFromTypeNode(statement.type)
      if (!type.isUnion() || type.types.length < 2) continue
      const discriminants = commonLiteralDiscriminants(type.types, statement, checker)
      for (const discriminant of discriminants) {
        const entry = {
          id: `${path}#${statement.name.text}|${discriminant.property}`,
          path,
          type: statement.name.text,
          property: discriminant.property,
          variants: discriminant.variants,
          memberCount: type.types.length,
          declarationKind: ts.isUnionTypeNode(statement.type) ? 'declared-union' : 'resolved-alias',
          declarationText: statement.type.getText(source),
          aliasReferences: ts.isUnionTypeNode(statement.type)
            ? []
            : sourceAliasReferences(statement.type, checker, root),
          exported:
            statement.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            ) ?? false,
          constructorSites: [],
        }
        unions.push(entry)
        runtimeUnions.push({ entry, type })
      }
    }
  }

  const candidatesByPropertyAndVariant = new Map()
  for (const candidate of runtimeUnions) {
    for (const variant of candidate.entry.variants) {
      const key = `${candidate.entry.property}\u0000${String(variant)}`
      const candidates = candidatesByPropertyAndVariant.get(key) ?? []
      candidates.push(candidate)
      candidatesByPropertyAndVariant.set(key, candidates)
    }
  }

  for (const source of productionSources) {
    const path = relative(root, source.fileName).split(sep).join('/')
    const occurrences = new Map()
    visit(source, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return
      const objectType = checker.getTypeAtLocation(node)
      const contextualType = checker.getContextualType(node)
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const propertyKey = propertyName(property.name)
        const variant = literalExpressionValue(property.initializer)
        if (!propertyKey || variant === undefined) continue
        const candidates = candidatesByPropertyAndVariant.get(
          `${propertyKey}\u0000${String(variant)}`,
        )
        if (!candidates) continue
        const assignable = candidates.filter(
          (candidate) =>
            checker.isTypeAssignableTo(objectType, candidate.type) ||
            (contextualType !== undefined &&
              checker.isTypeAssignableTo(contextualType, candidate.type)),
        )
        const accepted =
          assignable.length > 0 ? assignable : candidates.length === 1 ? candidates : []
        for (const candidate of accepted) {
          const owner = enclosingOwner(node)
          const start = source.getLineAndCharacterOfPosition(node.getStart(source))
          const stem = `${path}#${owner}|${propertyKey}:${String(variant)}`
          const occurrenceKey = `${candidate.entry.id}\u0000${stem}`
          const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1
          occurrences.set(occurrenceKey, occurrence)
          candidate.entry.constructorSites.push({
            id: `${candidate.entry.id}::${stem}|${occurrence}`,
            unionId: candidate.entry.id,
            path,
            line: start.line + 1,
            column: start.character + 1,
            offset: node.getStart(source),
            owner,
            variant,
            confidence: assignable.includes(candidate) ? 'type-assignable' : 'unique-literal',
          })
        }
      }
    })
  }

  for (const union of unions) {
    union.constructorSites.sort((left, right) => left.id.localeCompare(right.id))
  }
  unions.sort((left, right) => left.id.localeCompare(right.id))
  return {
    sourceFiles: productionSources.length,
    discriminatedUnions: unions.length,
    unions,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(discoverProductionDiscriminatedUnions(), null, 2)}\n`)
}

function commonLiteralDiscriminants(members, declaration, checker) {
  const commonNames = new Set(members[0].getProperties().map((property) => property.name))
  for (const member of members.slice(1)) {
    const names = new Set(member.getProperties().map((property) => property.name))
    for (const name of commonNames) {
      if (!names.has(name)) commonNames.delete(name)
    }
  }

  const found = []
  for (const property of [...commonNames].sort()) {
    const variants = new Set()
    let literalOnly = true
    for (const member of members) {
      const symbol = member.getProperty(property)
      if (!symbol) {
        literalOnly = false
        break
      }
      const location = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? declaration
      const propertyType = checker.getTypeOfSymbolAtLocation(symbol, location)
      const alternatives = propertyType.isUnion() ? propertyType.types : [propertyType]
      if (alternatives.length === 0) {
        literalOnly = false
        break
      }
      for (const alternative of alternatives) {
        const literal = literalValue(alternative)
        if (literal === undefined) {
          literalOnly = false
          break
        }
        variants.add(literal)
      }
      if (!literalOnly) break
    }
    if (literalOnly && variants.size >= 2) {
      found.push({ property, variants: [...variants].sort(compareLiteralValues) })
    }
  }
  return found
}

function sourceAliasReferences(typeNode, checker, root) {
  const references = new Set()
  visit(typeNode, (node) => {
    if (!ts.isTypeReferenceNode(node)) return
    let symbol = checker.getSymbolAtLocation(node.typeName)
    if (!symbol) return
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
    for (const declaration of symbol.declarations ?? []) {
      if (!ts.isTypeAliasDeclaration(declaration)) continue
      const sourcePath = relative(root, declaration.getSourceFile().fileName).split(sep).join('/')
      if (!sourcePath.startsWith('src/')) continue
      references.add(`${sourcePath}#${declaration.name.text}`)
    }
  })
  return [...references].sort()
}

function literalValue(type) {
  if (type.isStringLiteral()) return type.value
  if (type.isNumberLiteral()) return type.value
  if (type.flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName === 'true'
  return undefined
}

function compareLiteralValues(left, right) {
  return String(left).localeCompare(String(right))
}

function literalExpressionValue(expression) {
  const current = unwrapExpression(expression)
  if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current)) return current.text
  if (current.kind === ts.SyntaxKind.TrueKeyword) return 'true'
  if (current.kind === ts.SyntaxKind.FalseKeyword) return 'false'
  return undefined
}

function unwrapExpression(expression) {
  let current = expression
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

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined
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

function visit(node, callback) {
  callback(node)
  node.forEachChild((child) => visit(child, callback))
}
