import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TOKENS_PATH = resolve(__dirname, '../../src/styles/tokens.css')
const THEMES_PATH = resolve(__dirname, '../../src/styles/themes.css')

// Full required set per plan/10-ui.md §10.21 (color, typography, spacing,
// motion, effects). Missing any of these is a Phase-8 contract failure.
const REQUIRED_TOKENS = [
  '--color-bg-app',
  '--color-bg-surface-1',
  '--color-bg-surface-2',
  '--color-bg-surface-3',
  '--color-bg-overlay',
  '--color-bg-hover',
  '--color-bg-active',
  '--color-bg-selected',
  '--color-bg-disabled',
  '--color-fg-primary',
  '--color-fg-secondary',
  '--color-fg-muted',
  '--color-fg-disabled',
  '--color-fg-inverse',
  '--color-border-subtle',
  '--color-border-default',
  '--color-border-strong',
  '--color-border-focus',
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-active',
  '--color-accent-contrast',
  '--color-link',
  '--color-link-hover',
  '--color-success',
  '--color-warning',
  '--color-danger',
  '--color-info',
  '--color-banner-info-bg',
  '--color-banner-success-bg',
  '--color-banner-warning-bg',
  '--color-banner-danger-bg',
  '--color-role-user',
  '--color-role-assistant',
  '--color-role-system',
  '--color-role-tool',
  '--color-role-imported',
  '--color-privacy-green',
  '--color-privacy-yellow',
  '--color-privacy-orange',
  '--color-privacy-red',
  '--color-privacy-open',
  '--color-streaming',
  '--color-generating',
  '--color-archived',
  '--color-pinned',
  '--color-blocked',
  '--color-citation',
  '--color-citation-hover',
  '--color-backdrop-scrim',
  '--color-code-bg',
  '--color-code-border',
  '--color-code-toolbar-bg',
  '--color-code-toolbar-fg',
  '--color-selection',
  '--font-sans',
  '--font-mono',
  '--font-size-xs',
  '--font-size-sm',
  '--font-size-md',
  '--font-size-lg',
  '--font-size-xl',
  '--line-height-tight',
  '--line-height-body',
  '--line-height-loose',
  '--font-weight-regular',
  '--font-weight-medium',
  '--font-weight-semibold',
  '--font-weight-bold',
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-8',
  '--space-10',
  '--sidebar-width',
  '--sidebar-width-collapsed',
  '--sidebar-folder-indent',
  '--sidebar-row-tag-gap',
  '--sidebar-search-progress-width',
  '--header-height',
  '--settings-pane-width',
  '--composer-min-height',
  '--composer-max-height',
  '--message-gutter',
  '--message-row-gap',
  '--message-max-width',
  '--branch-indent-step',
  '--banner-stack-gap',
  '--dropdown-max-height',
  '--attachment-chip-height',
  '--code-block-max-height',
  '--modal-width-sm',
  '--modal-width-md',
  '--modal-width-lg',
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-pill',
  '--shadow-sm',
  '--shadow-md',
  '--shadow-lg',
  '--shadow-overlay',
  '--focus-ring-width',
  '--z-sidebar',
  '--z-header',
  '--z-settings-pane',
  '--z-dropdown',
  '--z-toast',
  '--z-modal',
  '--z-overlay',
  '--z-drag-ghost',
  '--duration-instant',
  '--duration-fast',
  '--duration-normal',
  '--duration-slow',
  '--ease-standard',
  '--ease-emphasized',
  '--ease-decelerate',
  '--ease-accelerate',
  '--opacity-disabled',
  '--opacity-muted',
  '--backdrop-blur-overlay',
  '--stream-caret-width',
  '--content-fade-height',
]

describe('tokens.css required tokens', () => {
  const source = readFileSync(TOKENS_PATH, 'utf8')
  for (const token of REQUIRED_TOKENS) {
    it(`defines ${token}`, () => {
      expect(source).toMatch(new RegExp(`\\${token}\\s*:`))
    })
  }
})

describe('themes.css required selectors', () => {
  const source = readFileSync(THEMES_PATH, 'utf8')
  it('defines [data-theme="dark"] overrides', () => {
    expect(source).toMatch(/\[data-theme=["']dark["']\]/)
  })
  it('defines [data-theme="high-contrast"] overrides', () => {
    expect(source).toMatch(/\[data-theme=["']high-contrast["']\]/)
  })
  it('ships an automatic dark fallback under prefers-color-scheme', () => {
    expect(source).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/)
  })
})
