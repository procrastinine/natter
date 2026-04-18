import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const THEME_CSS = resolve(__dirname, '../../src/app/theme.css')

function parseImports(source: string): string[] {
  const imports: string[] = []
  const re = /@import\s+['"]([^'"]+)['"]\s*;/g
  let match = re.exec(source)
  while (match !== null) {
    imports.push(match[1] as string)
    match = re.exec(source)
  }
  return imports
}

const EXPECTED_ORDER = [
  'tailwindcss',
  '../styles/tokens.css',
  '../styles/themes.css',
  '../styles/motion.css',
  '../styles/primitives.css',
  '../styles/icons.css',
  '../styles/forms.css',
  '../styles/modals.css',
  '../styles/shell.css',
  '../styles/sidebar.css',
  '../styles/header.css',
  '../styles/messages.css',
  '../styles/branching.css',
  '../styles/composer.css',
  '../styles/reasoning.css',
  '../styles/tools.css',
  '../styles/settings-pane.css',
  '../styles/pickers.css',
  '../styles/privacy.css',
  '../styles/manager.css',
  '../styles/banners.css',
  '../styles/rendering.css',
  '../styles/utilities.css',
]

describe('theme.css import order', () => {
  const source = readFileSync(THEME_CSS, 'utf8')
  const imports = parseImports(source)

  it('imports the shared style files in the declared order', () => {
    expect(imports).toEqual(EXPECTED_ORDER)
  })

  it('starts with tailwindcss so primitives can use @layer components', () => {
    expect(imports[0]).toBe('tailwindcss')
  })

  it('places tokens before themes before motion before primitives', () => {
    const order = imports.filter((i) => i.startsWith('../styles/'))
    const first = order.slice(0, 4)
    expect(first).toEqual([
      '../styles/tokens.css',
      '../styles/themes.css',
      '../styles/motion.css',
      '../styles/primitives.css',
    ])
  })

  it('ends with utilities.css', () => {
    expect(imports.at(-1)).toBe('../styles/utilities.css')
  })

  it('imports every style file listed in Phase 1', () => {
    const expectedStyleFiles = EXPECTED_ORDER.filter((i) => i.startsWith('../styles/'))
    const actualStyleFiles = imports.filter((i) => i.startsWith('../styles/'))
    expect(new Set(actualStyleFiles)).toEqual(new Set(expectedStyleFiles))
  })
})
