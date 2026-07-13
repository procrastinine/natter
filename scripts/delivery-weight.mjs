import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, relative } from 'node:path'
import { gzipSync } from 'node:zlib'

export function collectDeliveryWeight(root, deliveryConfig) {
  const dist = join(root, 'dist')
  const files = walkFiles(dist)
  const artifacts = files.map((file) => artifactFor(dist, file))
  const javascript = artifacts
    .filter((artifact) => artifact.extension === '.js')
    .sort((left, right) => right.gzipBytes - left.gzipBytes)
  const coldStaticGraph = collectColdStaticGraph(dist, artifacts)
  const namedAssets = Object.fromEntries(
    Object.entries(deliveryConfig.namedAssets).map(([name, config]) => [
      name,
      findNamedAsset(artifacts, config),
    ]),
  )

  return {
    fileCount: artifacts.length,
    assetCount: artifacts.filter((artifact) => artifact.path.startsWith('assets/')).length,
    javascriptCount: javascript.length,
    stylesheetCount: artifacts.filter((artifact) => artifact.extension === '.css').length,
    fontCount: artifacts.filter((artifact) => artifact.extension === '.woff2').length,
    totalBytes: sum(artifacts, 'bytes'),
    totalGzipBytes: sum(artifacts, 'gzipBytes'),
    largestJavascript: javascript[0] ?? null,
    coldStaticGraph,
    namedAssets,
    topologyProblems: checkTopology(artifacts, deliveryConfig.topology),
  }
}

export function deliveryBudgetProblems(delivery, deliveryConfig) {
  const problems = [...delivery.topologyProblems]
  checkMaximums(problems, 'distribution', delivery, deliveryConfig.maximums)
  checkMaximums(
    problems,
    'largest JavaScript asset',
    delivery.largestJavascript,
    deliveryConfig.largestJavascriptMaximums,
  )
  checkMaximums(
    problems,
    'cold static graph',
    delivery.coldStaticGraph,
    deliveryConfig.coldStaticGraphMaximums,
  )

  for (const [name, config] of Object.entries(deliveryConfig.namedAssets)) {
    const artifact = delivery.namedAssets[name]
    if (!artifact) {
      problems.push(`missing named distribution asset: ${name}`)
      continue
    }
    checkMaximums(problems, `named asset ${name}`, artifact, config.maximums)
  }
  return problems
}

function artifactFor(dist, file) {
  const contents = readFileSync(file)
  return {
    path: toPosix(relative(dist, file)),
    extension: extname(file),
    bytes: contents.byteLength,
    gzipBytes: gzipSync(contents).byteLength,
  }
}

function collectColdStaticGraph(dist, artifacts) {
  const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]))
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const pending = htmlStaticResources(html)
  const visited = new Set()

  while (pending.length > 0) {
    const path = pending.pop()
    if (!path || visited.has(path)) continue
    const artifact = artifactByPath.get(path)
    if (!artifact) throw new Error(`Cold static graph references missing asset: ${path}`)
    visited.add(path)
    if (artifact.extension !== '.js') continue
    const contents = readFileSync(join(dist, path), 'utf8')
    for (const specifier of staticModuleSpecifiers(contents)) {
      const dependency = resolveLocalSpecifier(path, specifier)
      if (dependency) pending.push(dependency)
    }
  }

  const coldArtifacts = [...visited]
    .map((path) => artifactByPath.get(path))
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    fileCount: coldArtifacts.length,
    javascriptCount: coldArtifacts.filter((artifact) => artifact.extension === '.js').length,
    stylesheetCount: coldArtifacts.filter((artifact) => artifact.extension === '.css').length,
    bytes: sum(coldArtifacts, 'bytes'),
    gzipBytes: sum(coldArtifacts, 'gzipBytes'),
    files: coldArtifacts.map((artifact) => artifact.path),
  }
}

function htmlStaticResources(html) {
  const resources = []
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[0]
    const kind = match[1].toLowerCase()
    const attributes = new Map()
    for (const attribute of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)) {
      attributes.set(attribute[1].toLowerCase(), attribute[3])
    }
    if (kind === 'script' && attributes.get('type') === 'module') {
      const source = attributes.get('src')
      if (source) resources.push(htmlLocalPath(source))
      continue
    }
    const relationships = new Set((attributes.get('rel') ?? '').toLowerCase().split(/\s+/))
    if (!relationships.has('modulepreload') && !relationships.has('stylesheet')) continue
    const href = attributes.get('href')
    if (href) resources.push(htmlLocalPath(href))
  }
  return resources
}

function htmlLocalPath(value) {
  const url = new URL(value, 'https://natter.invalid/')
  if (url.origin !== 'https://natter.invalid') {
    throw new Error(`Cold static graph contains an external asset: ${value}`)
  }
  return decodeURIComponent(url.pathname.replace(/^\//, ''))
}

function staticModuleSpecifiers(contents) {
  const specifiers = []
  const fromPattern = /\b(?:import|export)(?![\w$]|\s*\()[^;]*?\bfrom\s*(["'])([^"']+)\1/g
  const bareImportPattern = /\bimport\s*(["'])([^"']+)\1/g
  for (const match of contents.matchAll(fromPattern)) specifiers.push(match[2])
  for (const match of contents.matchAll(bareImportPattern)) specifiers.push(match[2])
  return specifiers
}

function resolveLocalSpecifier(importer, specifier) {
  if (!specifier.startsWith('.')) return null
  const resolved = posix.normalize(posix.join(posix.dirname(importer), specifier))
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new Error(`Distribution import escapes dist: ${importer} -> ${specifier}`)
  }
  return resolved
}

function findNamedAsset(artifacts, config) {
  const matches = artifacts.filter(
    (artifact) =>
      artifact.extension === config.extension &&
      basename(artifact.path).startsWith(`${config.prefix}-`),
  )
  if (matches.length > 1) {
    throw new Error(`Named asset ${config.prefix}${config.extension} matched more than one file`)
  }
  return matches[0] ?? null
}

function checkTopology(artifacts, topology) {
  const problems = []
  const allowedRootFiles = new Set(topology.rootFiles)
  const allowedAssetExtensions = new Set(topology.assetExtensions)
  const paths = new Set(artifacts.map((artifact) => artifact.path))
  for (const required of allowedRootFiles) {
    if (!paths.has(required)) problems.push(`missing required distribution file: ${required}`)
  }
  for (const artifact of artifacts) {
    if (allowedRootFiles.has(artifact.path)) continue
    if (!artifact.path.startsWith('assets/')) {
      problems.push(`unexpected distribution path: ${artifact.path}`)
      continue
    }
    if (dirname(artifact.path) !== 'assets') {
      problems.push(`nested distribution asset path: ${artifact.path}`)
    }
    if (!allowedAssetExtensions.has(artifact.extension)) {
      problems.push(`unexpected distribution asset type: ${artifact.path}`)
    }
  }
  return problems
}

function checkMaximums(problems, label, actual, maximums) {
  for (const [field, maximum] of Object.entries(maximums)) {
    const value = actual[field]
    if (typeof value !== 'number') throw new Error(`Unknown ${label} budget field: ${field}`)
    if (value > maximum) problems.push(`${label} ${field} ${value} exceeds budget ${maximum}`)
  }
}

function sum(values, field) {
  return values.reduce((total, value) => total + value[field], 0)
}

function toPosix(value) {
  return value.split('\\').join('/')
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walkFiles(path) : [path]
  })
}
