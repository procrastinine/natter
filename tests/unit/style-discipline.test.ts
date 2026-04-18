import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = resolve(__dirname, '../../src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const s = statSync(full)
    if (s.isDirectory()) walk(full, out)
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full)
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

describe('style discipline', () => {
  const files = walk(SRC_ROOT)
  const tsxFiles = files.filter((f) => f.endsWith('.tsx'))

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
})
