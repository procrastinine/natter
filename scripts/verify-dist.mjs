import { readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDeliveryWeight } from './delivery-weight.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const dist = join(root, 'dist')
const files = walkFiles(dist)
const baseline = JSON.parse(readFileSync(join(root, 'scripts/performance-baseline.json'), 'utf8'))
const delivery = collectDeliveryWeight(root, baseline.deliveryBudgets)
const forbiddenExtensions = new Set(['.map', '.ttf', '.wasm', '.woff'])
const forbiddenMarkers = [
  '/Users/',
  '[Streamdown Code]',
  '__debugFakeStream',
  '__debugRuntime',
  '__debugScroll',
  '__debugStreams',
  '__nuke',
  'VITE_NATTER_DEBUG',
  'natter.debug.streams',
  'natter.debug.request_plans',
  'natter.debug.scroll',
  'browser-devtools',
  'natter/fake-stream',
  '/__control/scenarios/',
  'E2E_FAKE_PROVIDER_ORIGIN',
  'fake-stream-server.mjs',
]
const problems = [...delivery.topologyProblems]
const javascriptArtifacts = []
const indexHtml = readFileSync(join(dist, 'index.html'), 'utf8')
const moduleEntryCount = [...indexHtml.matchAll(/<script\b(?=[^>]*\btype=["']module["'])[^>]*>/giu)]
  .length

if (moduleEntryCount !== 1) {
  problems.push(`expected one module entry script, found ${moduleEntryCount}`)
}

for (const file of files) {
  const relativePath = relative(dist, file)
  if (forbiddenExtensions.has(extname(file))) {
    problems.push(`unneeded distribution asset: ${relativePath}`)
  }
  if (!/\.(?:css|html|js|json|svg|txt)$/.test(file)) continue
  const contents = readFileSync(file, 'utf8')
  if (extname(file) === '.js') {
    javascriptArtifacts.push({ name: basename(file), contents })
    if (/atob\([`'"]AGFzbQ/.test(contents)) {
      problems.push(`inlined WebAssembly payload: ${relativePath}`)
    }
  }
  for (const marker of forbiddenMarkers) {
    if (contents.includes(marker)) problems.push(`forbidden marker ${marker} in ${relativePath}`)
  }
}

const allowedShikiThemes = new Set(['dracula', 'github-dark', 'github-light', 'tokyo-night'])
const themePackage = JSON.parse(
  readFileSync(join(root, 'node_modules/@shikijs/themes/package.json'), 'utf8'),
)
const availableShikiThemes = new Set(
  Object.keys(themePackage.exports)
    .filter((key) => key.startsWith('./') && key !== './package.json' && !key.includes('*'))
    .map((key) => key.slice(2)),
)
const emittedShikiThemes = new Set()
const javascriptContents = javascriptArtifacts.map((artifact) => artifact.contents).join('\n')
for (const match of javascriptContents.matchAll(/"name":"([^"]+)"/g)) {
  const theme = match[1]
  if (availableShikiThemes.has(theme)) emittedShikiThemes.add(theme)
}
for (const theme of availableShikiThemes) {
  if (
    javascriptArtifacts.some(
      (artifact) => artifact.name === `${theme}.js` || artifact.name.startsWith(`${theme}-`),
    )
  ) {
    emittedShikiThemes.add(theme)
  }
}
for (const theme of emittedShikiThemes) {
  if (!allowedShikiThemes.has(theme)) problems.push(`unconfigured Shiki theme: ${theme}`)
}
for (const theme of allowedShikiThemes) {
  if (!emittedShikiThemes.has(theme)) problems.push(`missing configured Shiki theme: ${theme}`)
}

if (problems.length > 0) {
  throw new Error(`Distribution verification failed:\n${problems.join('\n')}`)
}

process.stdout.write(
  `Verified dist: ${delivery.fileCount} files, ${delivery.totalBytes} raw bytes, ${delivery.totalGzipBytes} gzip bytes; cold static graph ${delivery.coldStaticGraph.fileCount} files / ${delivery.coldStaticGraph.gzipBytes} gzip bytes; topology and module entry checks pass; no maps/debug paths/legacy fonts/WebAssembly; four Shiki themes.\n`,
)

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? walkFiles(path) : [path]
  })
}
