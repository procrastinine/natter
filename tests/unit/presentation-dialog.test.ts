import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  cancelPresentationDialog,
  getPresentationDialogSnapshot,
  requestPresentationConfirmation,
  requestPresentationText,
  settlePresentationDialog,
  subscribePresentationDialog,
} from '../../src/app/presentation-dialog'

const SOURCE_ROOT = join(process.cwd(), 'src')

describe('presentation dialog', () => {
  it('settles a text request through one subscribed host', async () => {
    const unsubscribe = subscribePresentationDialog(() => undefined)
    try {
      const result = requestPresentationText({ title: 'Rename', initialValue: 'before' })
      const request = getPresentationDialogSnapshot()
      expect(request).toMatchObject({ kind: 'text', title: 'Rename', initialValue: 'before' })
      if (!request) throw new Error('PresentationDialogRequestMissing')
      settlePresentationDialog(request.id, 'after')
      await expect(result).resolves.toBe('after')
      expect(getPresentationDialogSnapshot()).toBeNull()
    } finally {
      unsubscribe()
    }
  })

  it('rejects overlapping requests and cancels confirmation explicitly', async () => {
    const unsubscribe = subscribePresentationDialog(() => undefined)
    try {
      const first = requestPresentationConfirmation({ title: 'Delete?', message: 'Confirm' })
      await expect(requestPresentationText({ title: 'Rename' })).rejects.toThrow(
        'PresentationDialogAlreadyActive',
      )
      const request = getPresentationDialogSnapshot()
      if (!request) throw new Error('PresentationDialogRequestMissing')
      cancelPresentationDialog(request.id)
      await expect(first).resolves.toBe(false)
    } finally {
      unsubscribe()
    }
  })

  it('rejects a request when no presentation host can own it', async () => {
    await expect(requestPresentationText({ title: 'Rename' })).rejects.toThrow(
      'PresentationDialogHostUnavailable',
    )
  })

  it('settles an active request as cancellation when its last host unmounts', async () => {
    const unsubscribe = subscribePresentationDialog(() => undefined)
    const result = requestPresentationText({ title: 'Rename' })
    unsubscribe()
    await expect(result).resolves.toBeNull()
    expect(getPresentationDialogSnapshot()).toBeNull()
  })

  it('keeps native blocking dialogs out of application source', () => {
    const offenders = sourceFiles(SOURCE_ROOT).flatMap((file) => {
      return hasNativeBlockingDialogCall(file)
        ? [relative(SOURCE_ROOT, file).split(sep).join('/')]
        : []
    })
    expect(offenders).toEqual([])
  })
})

function sourceFiles(root: string): string[] {
  return readdirSync(root)
    .flatMap((name) => {
      const path = join(root, name)
      return statSync(path).isDirectory() ? sourceFiles(path) : [path]
    })
    .filter((path) => extname(path) === '.ts' || extname(path) === '.tsx')
}

function hasNativeBlockingDialogCall(path: string): boolean {
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    extname(path) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      if (
        (ts.isIdentifier(expression) && isBlockingDialogName(expression.text)) ||
        (ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === 'window' &&
          isBlockingDialogName(expression.name.text))
      ) {
        found = true
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function isBlockingDialogName(name: string): boolean {
  return name === 'alert' || name === 'confirm' || name === 'prompt'
}
