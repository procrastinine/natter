import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(__dirname, '../../src')
const RAW_BUTTON_OWNERS = new Set([
  join(SRC_ROOT, 'ui/primitives/Button.tsx'),
  join(SRC_ROOT, 'ui/primitives/Dialog.tsx'),
])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) walk(full, out)
    else if (full.endsWith('.tsx') || full.endsWith('.ts') || full.endsWith('.css')) out.push(full)
  }
  return out
}

const TAILWIND_NAKED = new Set([
  'flex',
  'grid',
  'block',
  'inline',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'hidden',
  'contents',
  'flow-root',
  'absolute',
  'relative',
  'fixed',
  'sticky',
  'static',
  'visible',
  'invisible',
  'isolate',
  'container',
  'truncate',
  'italic',
  'underline',
  'overline',
  'line-through',
  'antialiased',
  'subpixel-antialiased',
  'uppercase',
  'lowercase',
  'capitalize',
  'normal-case',
  'grow',
  'shrink',
  'transform',
  'overflow-auto',
  'overflow-hidden',
  'overflow-scroll',
  'overflow-visible',
  'sr-only',
  'not-sr-only',
  'pointer-events-none',
  'pointer-events-auto',
])

const TAILWIND_PREFIXES = [
  'bg-',
  'text-',
  'border-',
  'ring-',
  'shadow-',
  'from-',
  'via-',
  'to-',
  'fill-',
  'stroke-',
  'accent-',
  'outline-',
  'decoration-',
  'divide-',
  'placeholder-',
  'flex-',
  'grid-',
  'col-',
  'row-',
  'items-',
  'justify-',
  'content-',
  'self-',
  'place-',
  'order-',
  'basis-',
  'p-',
  'px-',
  'py-',
  'pt-',
  'pb-',
  'pl-',
  'pr-',
  'm-',
  'mx-',
  'my-',
  'mt-',
  'mb-',
  'ml-',
  'mr-',
  'gap-',
  'space-',
  'w-',
  'h-',
  'min-w-',
  'min-h-',
  'max-w-',
  'max-h-',
  'size-',
  'inset-',
  'top-',
  'bottom-',
  'left-',
  'right-',
  'z-',
  'opacity-',
  'rounded-',
  'font-',
  'tracking-',
  'leading-',
  'whitespace-',
  'break-',
  'line-clamp-',
  'cursor-',
  'select-',
  'resize-',
  'scroll-',
  'overflow-',
  'overscroll-',
  'touch-',
  'transition-',
  'duration-',
  'delay-',
  'ease-',
  'transform-',
  'scale-',
  'rotate-',
  'translate-',
  'skew-',
  'backdrop-',
  'blur-',
]

function isTailwindToken(tok: string): boolean {
  if (tok === '') return false
  if (TAILWIND_NAKED.has(tok)) return true
  if (tok.includes(':')) return true
  for (const prefix of TAILWIND_PREFIXES) {
    if (tok.startsWith(prefix) && tok.length > prefix.length) return true
  }
  return false
}

function collectClassNameValues(source: string): string[] {
  const values: string[] = []
  const re = /\bclassName\s*=\s*"([^"]*)"/g
  let match = re.exec(source)
  while (match !== null) {
    values.push(match[1] as string)
    match = re.exec(source)
  }
  return values
}

function findStyleAttrs(source: string): number {
  const re = /\bstyle\s*=\s*\{/g
  let count = 0
  while (re.exec(source) !== null) count += 1
  return count
}

interface SourceLocation {
  file: string
  line: number
  column: number
}

function findIntrinsicButtons(file: string): SourceLocation[] {
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const locations: SourceLocation[] = []

  function visit(node: ts.Node): void {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === 'button'
    ) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      locations.push({
        file: relative(SRC_ROOT, file),
        line: position.line + 1,
        column: position.character + 1,
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return locations
}

function findButtonComponentsUsingIconHook(file: string): SourceLocation[] {
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const locations: SourceLocation[] = []

  function visit(node: ts.Node): void {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === 'Button'
    ) {
      const usesIconHook = node.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(sourceFile) === 'data-ui' &&
          attribute.initializer !== undefined &&
          ts.isStringLiteral(attribute.initializer) &&
          attribute.initializer.text === 'icon-button',
      )
      if (usesIconHook) {
        const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        locations.push({
          file: relative(SRC_ROOT, file),
          line: position.line + 1,
          column: position.character + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return locations
}

interface CssSegment {
  text: string
  offset: number
}

interface CssSelectorOffender {
  file: string
  line: number
  selector: string
}

function maskCssComments(source: string): string {
  const characters = source.split('')
  let quote: '"' | "'" | null = null

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character !== '/' || characters[index + 1] !== '*') continue

    characters[index] = ' '
    characters[index + 1] = ' '
    index += 2
    while (index < characters.length) {
      if (characters[index] === '*' && characters[index + 1] === '/') {
        characters[index] = ' '
        characters[index + 1] = ' '
        index += 1
        break
      }
      if (characters[index] !== '\n' && characters[index] !== '\r') characters[index] = ' '
      index += 1
    }
  }

  return characters.join('')
}

function collectCssRulePreludes(source: string): CssSegment[] {
  const masked = maskCssComments(source)
  const preludes: CssSegment[] = []
  let statementStart = 0
  let quote: '"' | "'" | null = null
  let parentheses = 0
  let brackets = 0

  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (parentheses === 0 && brackets === 0 && character === ';') statementStart = index + 1
    else if (parentheses === 0 && brackets === 0 && character === '}') statementStart = index + 1
    else if (parentheses === 0 && brackets === 0 && character === '{') {
      const rawPrelude = masked.slice(statementStart, index)
      const leadingWhitespace = rawPrelude.search(/\S/u)
      if (leadingWhitespace >= 0) {
        const text = rawPrelude.slice(leadingWhitespace).trimEnd()
        if (!text.startsWith('@')) {
          preludes.push({ text, offset: statementStart + leadingWhitespace })
        }
      }
      statementStart = index + 1
    }
  }

  return preludes
}

function splitSelectorArms(selectorList: CssSegment): CssSegment[] {
  const arms: CssSegment[] = []
  let armStart = 0
  let quote: '"' | "'" | null = null
  let parentheses = 0
  let brackets = 0

  function pushArm(end: number): void {
    const rawArm = selectorList.text.slice(armStart, end)
    const leadingWhitespace = rawArm.search(/\S/u)
    arms.push({
      text: leadingWhitespace >= 0 ? rawArm.slice(leadingWhitespace) : '',
      offset:
        selectorList.offset +
        armStart +
        (leadingWhitespace >= 0 ? leadingWhitespace : rawArm.length),
    })
  }

  for (let index = 0; index < selectorList.text.length; index += 1) {
    const character = selectorList.text[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      pushArm(index)
      armStart = index + 1
    }
  }

  pushArm(selectorList.text.length)
  return arms
}

function collectSelectorAttributeNames(selector: string): Set<string> {
  const names = new Set<string>()
  let quote: '"' | "'" | null = null

  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index]
    if (quote !== null) {
      if (character === '\\') index += 1
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character !== '[') continue

    let nameStart = index + 1
    while (/\s/u.test(selector[nameStart] ?? '')) nameStart += 1
    let nameEnd = nameStart
    while (/[-_a-zA-Z0-9]/u.test(selector[nameEnd] ?? '')) nameEnd += 1
    if (nameEnd > nameStart) names.add(selector.slice(nameStart, nameEnd).toLowerCase())
  }

  return names
}

function lineNumberAt(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

function findUnscopedStateSelectors(source: string, file: string): CssSelectorOffender[] {
  const offenders: CssSelectorOffender[] = []
  for (const prelude of collectCssRulePreludes(source)) {
    for (const arm of splitSelectorArms(prelude)) {
      const attributes = collectSelectorAttributeNames(arm.text)
      const hasState = attributes.has('data-tone') || attributes.has('data-variant')
      const hasSurface = attributes.has('data-ui') || attributes.has('data-control')
      if (!hasState || hasSurface) continue
      offenders.push({
        file,
        line: lineNumberAt(source, arm.offset),
        selector: arm.text.replace(/\s+/gu, ' ').trim(),
      })
    }
  }
  return offenders
}

describe('style discipline', () => {
  const files = walk(SRC_ROOT)
  const tsxFiles = files.filter((f) => f.endsWith('.tsx'))
  const cssFiles = files.filter((f) => f.endsWith('.css'))

  it('no JSX style={} attributes in src/**/*.tsx (visual design must live in stylesheets)', () => {
    const offenders: Array<{ file: string; count: number }> = []
    for (const file of tsxFiles) {
      const source = readFileSync(file, 'utf8')
      const count = findStyleAttrs(source)
      if (count > 0) offenders.push({ file, count })
    }
    expect(offenders).toEqual([])
  })

  it('no Tailwind utility tokens in className="..." in feature components', () => {
    const offenders: Array<{ file: string; tokens: string[] }> = []
    for (const file of tsxFiles) {
      const source = readFileSync(file, 'utf8')
      for (const value of collectClassNameValues(source)) {
        const bad = value
          .split(/\s+/)
          .filter((t) => t.length > 0)
          .filter(isTailwindToken)
        if (bad.length > 0) offenders.push({ file, tokens: bad })
      }
    }
    expect(offenders).toEqual([])
  })

  it('uses shared button primitives outside their two native-element owners', () => {
    const offenders = tsxFiles
      .filter((file) => !RAW_BUTTON_OWNERS.has(file))
      .flatMap(findIntrinsicButtons)
    expect(offenders).toEqual([])
  })

  it('routes the icon-button hook through IconButton', () => {
    expect(tsxFiles.flatMap(findButtonComponentsUsingIconHook)).toEqual([])
  })

  it('parses CSS selector arms without splitting :is() lists or rejecting scoped descendants', () => {
    const css = `
      :is(
        [data-ui="banner"],
        [data-control="notice"]
      )[data-tone="danger"],
      [data-ui="panel"] [data-variant="compact"] { color: red; }

      [data-ui="safe"][data-tone="info"],
      [data-tone="warning"],
      button[data-variant="danger"] { color: orange; }

      /* [data-tone="example"] { comments are not selectors } */
    `

    expect(findUnscopedStateSelectors(css, 'fixture.css')).toEqual([
      { file: 'fixture.css', line: 9, selector: '[data-tone="warning"]' },
      { file: 'fixture.css', line: 10, selector: 'button[data-variant="danger"]' },
    ])
  })

  it('scopes data-tone and data-variant selector arms to a UI or control surface', () => {
    const offenders = cssFiles.flatMap((file) =>
      findUnscopedStateSelectors(readFileSync(file, 'utf8'), relative(SRC_ROOT, file)),
    )
    expect(offenders).toEqual([])
  })
})
