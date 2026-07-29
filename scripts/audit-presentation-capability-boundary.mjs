import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const REQUIRED_CAPABILITY_PROP = Object.freeze({
  'src/app/Shell.tsx': Object.freeze({
    Composer: 'generationCapability',
  }),
})
const FORBIDDEN_JSX_PROPS = new Set([
  'connectionAvailability',
  'editResendCapability',
  'generationCapabilityFrame',
  'hasConnection',
  'regenerateCapability',
  'sendBlockedReason',
  'sendUnavailable',
])
const CONNECTION_COPY_OWNER = 'src/core/interaction-capability.ts'

export function auditPresentationCapabilityBoundary(root = process.cwd()) {
  const violations = []
  const files = sourceFiles(root, ['src/app', 'src/ui', 'src/core/interaction-capability.ts'])
  let requiredConsumers = 0

  for (const absolutePath of files) {
    const path = relative(root, absolutePath)
    const text = readFileSync(absolutePath, 'utf8')
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    visit(source, (node) => {
      if (ts.isStringLiteralLike(node)) {
        if (
          node.text.includes('Resolving the active branch before sending.') ||
          (node.text.startsWith('Add a connection to ') && path !== CONNECTION_COPY_OWNER)
        ) {
          violations.push(
            `${path}:${lineOf(source, node)} owns forbidden transient capability copy`,
          )
        }
      }

      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return
      const component = node.tagName.getText(source)
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue
        const name = attribute.name.getText(source)
        if (FORBIDDEN_JSX_PROPS.has(name)) {
          violations.push(`${path}:${lineOf(source, attribute)} uses forbidden JSX prop ${name}`)
        }
      }
      const requiredProp = REQUIRED_CAPABILITY_PROP[path]?.[component]
      if (!requiredProp) return
      requiredConsumers += 1
      const hasCapability = node.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) && attribute.name.getText(source) === requiredProp,
      )
      if (!hasCapability) {
        violations.push(`${path}:${lineOf(source, node)} ${component} lacks ${requiredProp}`)
      }
    })
  }

  return Object.freeze({
    ok: violations.length === 0,
    requiredConsumers,
    violations: Object.freeze(violations),
  })
}

function visit(node, inspect) {
  inspect(node)
  ts.forEachChild(node, (child) => visit(child, inspect))
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function sourceFiles(root, entries) {
  const files = []
  for (const entry of entries) collect(resolve(root, entry), files)
  return files.sort()
}

function collect(path, files) {
  const entries = readdirSafe(path)
  if (entries === null) {
    if (['.ts', '.tsx'].includes(extname(path))) files.push(path)
    return
  }
  for (const entry of entries) collect(join(path, entry.name), files)
}

function readdirSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return null
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = auditPresentationCapabilityBoundary()
  console.log(`Presentation capability boundary: ${result.requiredConsumers} exact consumers`)
  if (!result.ok) {
    for (const violation of result.violations) console.error(violation)
    process.exitCode = 1
  }
}
