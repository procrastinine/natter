import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(__dirname, '../../src')

function sourceFiles(dir = SRC_ROOT): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/u.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function rel(file: string): string {
  return relative(SRC_ROOT, file).replaceAll('\\', '/')
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '')
}

function importStatements(text: string): string[] {
  return text.match(/import[\s\S]*?\sfrom ['"][^'"]+['"]/gu) ?? []
}

describe('generation request path audit', () => {
  it('only api/assistant-stream.ts imports and calls generation adapters', () => {
    const allowed = new Set([
      'api/assistant-stream.ts',
      'api/chat-completions.ts',
      'api/gemini-native.ts',
      'api/responses.ts',
      'api/text-completions.ts',
    ])
    const adapterImport = /from ['"][^'"]*(chat-completions|gemini-native|responses|text-completions)['"]/u
    const adapterCall =
      /\b(chatCompletions|chatCompletionsOnce|geminiStream|geminiOnce|responses|responsesOnce|textCompletions|textCompletionsOnce)\s*\(/u
    const failures: string[] = []
    for (const file of sourceFiles()) {
      const path = rel(file)
      if (allowed.has(path)) continue
      const text = withoutComments(readFileSync(file, 'utf8'))
      const importsAdapter = importStatements(text).some(
        (stmt) => !/^import\s+type\b/u.test(stmt) && adapterImport.test(stmt),
      )
      if (importsAdapter || adapterCall.test(text)) failures.push(path)
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('only core/send-planning.ts owns generation route and wire transforms', () => {
    const allowed = new Set([
      'core/api-choice.ts',
      'core/send-planning.ts',
      'core/transforms.ts',
      'ui/settings/ParamForm.tsx',
    ])
    const routeOrTransformImport = /from ['"][^'"]*core\/(api-choice|transforms)['"]/u
    const directTransformCall =
      /\b(chooseApi|toChatCompletions|toResponses|toGeminiNative|toTextCompletions)\s*\(/u
    const failures: string[] = []
    for (const file of sourceFiles()) {
      const path = rel(file)
      if (allowed.has(path)) continue
      const text = withoutComments(readFileSync(file, 'utf8'))
      const importsRouteOrTransform = importStatements(text).some(
        (stmt) => !/^import\s+type\b/u.test(stmt) && routeOrTransformImport.test(stmt),
      )
      if (importsRouteOrTransform || directTransformCall.test(text)) failures.push(path)
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
