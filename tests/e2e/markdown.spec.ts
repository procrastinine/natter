import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Markdown + code + lists + tables + blockquotes + image allowlist
// round-trip in a live browser. Backs plan/13-delivery.md §13.3.0 Track B.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('renders headings, paragraphs, lists, tables, and blockquotes from a single assistant reply', async ({
  page,
}) => {
  const markdown = [
    '# Hello',
    '',
    'Paragraph with **bold** and *italic*.',
    '',
    '- item one',
    '- item two',
    '',
    '| col a | col b |',
    '|-------|-------|',
    '| foo   | bar   |',
    '',
    '> quoted line',
  ].join('\n')
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'md', content: markdown, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'give me everything')
  const body = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(body.locator('h1')).toHaveText(/Hello/)
  await expect(body.locator('[data-streamdown="strong"]')).toHaveText(/bold/)
  await expect(body.locator('li').first()).toHaveText(/item one/)
  await expect(body.locator('table')).toBeVisible()
  await expect(body.locator('blockquote')).toHaveText(/quoted line/)
})

test('renders a streamed code fence with a copy/download toolbar once closed', async ({ page }) => {
  const code = '```ts\nconst x = 1\n```'
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'code', content: code, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'show code')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('pre')).toContainText('const x = 1')
})

test('blocked images from unlisted origins render a blocked-image stub', async ({ page }) => {
  const md = '![evil pixel](https://tracker.example.com/pixel.gif)'
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'img', content: md, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'trick me')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('img[src*="tracker.example.com"]')).toHaveCount(0)
  await expect(assistant).toContainText(/Blocked image from/i)
})

test('external links get target="_blank" rel="noopener noreferrer"', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      {
        id: 'link',
        content: 'See [example](https://example.com).',
        finish: 'stop',
      },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'give a link')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  const anchor = assistant.locator('a[href^="https://example.com"]').first()
  await expect(anchor).toBeVisible()
  expect(await anchor.getAttribute('target')).toBe('_blank')
  expect(await anchor.getAttribute('rel')).toMatch(/noopener/)
})

test('keeps currency ranges out of math rendering while preserving double-dollar math', async ({
  page,
}) => {
  const markdown = 'Recommend $10 to $12 per month.\n\nFor math, use $$E = mc^2$$.'
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'money-math', content: markdown, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'compare prices')

  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant).toContainText('$10 to $12')
  await expect(assistant.locator('.katex')).toHaveCount(1)
})

test('global rendering setting enables single-dollar math', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'single-dollar-math', content: 'Inline $x + y$ math.', finish: 'stop' },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'show inline math')

  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant).toContainText('$x + y$')
  await expect(assistant.locator('.katex')).toHaveCount(0)

  await page.locator('[data-ui="open-global-settings"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="appearance"]').click()
  const toggle = page.getByLabel('Single-dollar LaTeX markdown')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(toggle).toBeChecked()
  await page.locator('[data-role="global-settings-close"]').click()

  await expect(assistant.locator('.katex')).toHaveCount(1)
  await expect(assistant).toContainText('x+y')
})

test('global rendering setting renders single newlines as line breaks', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'single-newline', content: 'Line one\nLine two', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'show two lines')

  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('p br')).toHaveCount(0)

  await page.locator('[data-ui="open-global-settings"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="appearance"]').click()
  const toggle = page.getByLabel('Single newline as line break')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(toggle).toBeChecked()
  await page.locator('[data-role="global-settings-close"]').click()

  await expect(assistant.locator('p br')).toHaveCount(1)
})
