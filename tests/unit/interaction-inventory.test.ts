import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const TEST_ROOT = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(TEST_ROOT, '../..')
const SOURCE_ROOT = join(PROJECT_ROOT, 'src')

interface InteractionArea {
  readonly name: string
  readonly sources: readonly string[]
  readonly stylesheets: readonly string[]
}

const IMPLEMENTED_INTERACTION_AREAS = [
  {
    name: 'workspace shell',
    sources: ['app/Shell.tsx', 'app/WorkspaceBootstrap.tsx'],
    stylesheets: ['shell.css', 'sidebar.css', 'header.css', 'manager.css', 'primitives.css'],
  },
  {
    name: 'attachment composition',
    sources: [
      'ui/attachments/AttachmentDraftTray.tsx',
      'ui/attachments/AttachmentPicker.tsx',
      'ui/attachments/AttachmentPreview.tsx',
      'ui/attachments/AttachmentRefChips.tsx',
    ],
    stylesheets: ['composer.css', 'manager.css', 'messages.css', 'rendering.css', 'primitives.css'],
  },
  {
    name: 'notices and blocking dialogs',
    sources: [
      'ui/chat/BannerTray.tsx',
      'ui/chat/ConfirmDeleteDialog.tsx',
      'ui/chat/EmptyState.tsx',
      'ui/chat/PrefillSettingsPrompt.tsx',
      'ui/chat/ToastTray.tsx',
      'ui/chat/ZeroEligibleModal.tsx',
    ],
    stylesheets: [
      'banners.css',
      'branching.css',
      'modals.css',
      'forms.css',
      'primitives.css',
      'settings-pane.css',
      'shell.css',
    ],
  },
  {
    name: 'branch navigation and tree editing',
    sources: [
      'ui/chat/BranchControls.tsx',
      'ui/chat/BranchTreeInspector.tsx',
      'ui/chat/BranchTreeView.tsx',
      'ui/chat/EditTreeToolbar.tsx',
      'ui/chat/TreeDensityToggle.tsx',
    ],
    stylesheets: ['branching.css', 'messages.css', 'forms.css', 'primitives.css'],
  },
  {
    name: 'chat and connection header',
    sources: [
      'ui/chat/ChatHeader.tsx',
      'ui/chat/FocusModeToggle.tsx',
      'ui/chat/HeaderPrivacyBadge.tsx',
      'ui/header/ConnectionDeleteDialog.tsx',
      'ui/header/ConnectionHeader.tsx',
    ],
    stylesheets: [
      'header.css',
      'privacy.css',
      'modals.css',
      'forms.css',
      'primitives.css',
      'shell.css',
    ],
  },
  {
    name: 'message actions and disclosures',
    sources: [
      'ui/chat/InlineEditor.tsx',
      'ui/chat/Message.tsx',
      'ui/chat/MessageActions.tsx',
      'ui/chat/MessageContent.tsx',
      'ui/chat/MessageList.tsx',
      'ui/chat/ReasoningBlock.tsx',
      'ui/chat/ToolEvidenceBlock.tsx',
    ],
    stylesheets: ['messages.css', 'reasoning.css', 'tools.css', 'forms.css', 'primitives.css'],
  },
  {
    name: 'rendered content actions',
    sources: ['ui/chat/CitationLink.tsx', 'ui/chat/CodeBlock.tsx', 'ui/chat/MarkdownView.tsx'],
    stylesheets: ['rendering.css', 'banners.css', 'primitives.css'],
  },
  {
    name: 'composer and import',
    sources: ['ui/chat/Composer.tsx', 'ui/chat/ImportModal.tsx'],
    stylesheets: ['branching.css', 'composer.css', 'modals.css', 'forms.css', 'primitives.css'],
  },
  {
    name: 'transcript scrolling',
    sources: ['ui/chat/ScrollRegion.tsx'],
    stylesheets: ['shell.css', 'messages.css', 'motion.css', 'primitives.css'],
  },
  {
    name: 'settings shell',
    sources: [
      'ui/settings/ChatModelPanel.tsx',
      'ui/settings/GeneralSettings.tsx',
      'ui/settings/GlobalSettingsModal.tsx',
    ],
    stylesheets: ['settings-pane.css', 'modals.css', 'forms.css', 'primitives.css'],
  },
  {
    name: 'generation and routing settings',
    sources: [
      'ui/settings/CachingPanel.tsx',
      'ui/settings/ContextPanel.tsx',
      'ui/settings/LlamaServerSection.tsx',
      'ui/settings/ModelPicker.tsx',
      'ui/settings/ParamForm.tsx',
      'ui/settings/PrivacySection.tsx',
      'ui/settings/PromptPresetEditor.tsx',
      'ui/settings/PromptsTab.tsx',
      'ui/settings/ProviderPicker.tsx',
      'ui/settings/TextTemplateSection.tsx',
    ],
    stylesheets: [
      'settings-pane.css',
      'pickers.css',
      'privacy.css',
      'reasoning.css',
      'forms.css',
      'primitives.css',
    ],
  },
  {
    name: 'global appearance and performance settings',
    sources: [
      'ui/settings/AppearanceSettings.tsx',
      'ui/settings/ImageAllowlistPanel.tsx',
      'ui/settings/InfoDisclosure.tsx',
      'ui/settings/PerformanceSettings.tsx',
      'ui/settings/RenderingSettings.tsx',
    ],
    stylesheets: [
      'settings-pane.css',
      'rendering.css',
      'pickers.css',
      'forms.css',
      'primitives.css',
    ],
  },
  {
    name: 'connection management',
    sources: ['ui/settings/ConnectionsSettings.tsx'],
    stylesheets: ['manager.css', 'modals.css', 'forms.css', 'primitives.css'],
  },
  {
    name: 'sidebar catalog',
    sources: ['ui/sidebar/ChatList.tsx'],
    stylesheets: ['sidebar.css', 'forms.css', 'primitives.css'],
  },
  {
    name: 'storage administration',
    sources: ['ui/storage/StorageChatsSurface.tsx', 'ui/storage/StorageView.tsx'],
    stylesheets: ['manager.css', 'banners.css', 'rendering.css', 'forms.css', 'primitives.css'],
  },
] as const satisfies readonly InteractionArea[]

const SOURCE_BEHAVIOR_TESTS = {
  'app/Shell.tsx': ['unit/shell.test.tsx'],
  'app/WorkspaceBootstrap.tsx': ['unit/workspace-bootstrap.test.tsx'],
  'ui/attachments/AttachmentDraftTray.tsx': ['unit/composer.test.tsx'],
  'ui/attachments/AttachmentPicker.tsx': ['unit/attachment-picker.test.tsx'],
  'ui/attachments/AttachmentPreview.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/attachments/AttachmentRefChips.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/chat/BannerTray.tsx': ['unit/live-regions.test.tsx', 'unit/notice-actions.test.tsx'],
  'ui/chat/BranchControls.tsx': ['unit/branch-controls-accessibility.test.tsx'],
  'ui/chat/BranchTreeInspector.tsx': ['unit/branch-tree-inspector.test.tsx'],
  'ui/chat/BranchTreeView.tsx': ['unit/branch-tree-view.test.tsx', 'e2e/branch-tree.spec.ts'],
  'ui/chat/ChatHeader.tsx': ['unit/chat-header-import-export.test.tsx'],
  'ui/chat/CitationLink.tsx': ['unit/citation-link.test.tsx'],
  'ui/chat/CodeBlock.tsx': ['unit/code-block.test.tsx'],
  'ui/chat/Composer.tsx': ['unit/composer.test.tsx', 'e2e/composer.spec.ts'],
  'ui/chat/ConfirmDeleteDialog.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/chat/EditTreeToolbar.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/chat/EmptyState.tsx': ['unit/empty-state.test.tsx'],
  'ui/chat/FocusModeToggle.tsx': ['unit/shell.test.tsx', 'e2e/focus-mode-layout.spec.ts'],
  'ui/chat/HeaderPrivacyBadge.tsx': ['e2e/advanced-generation-routing.spec.ts'],
  'ui/chat/ImportModal.tsx': ['unit/import-modal.test.tsx'],
  'ui/chat/InlineEditor.tsx': ['unit/message-actions.test.tsx', 'e2e/branch-tree.spec.ts'],
  'ui/chat/MarkdownView.tsx': ['unit/markdown-view.test.tsx', 'e2e/markdown.spec.ts'],
  'ui/chat/Message.tsx': ['unit/message-header.test.tsx'],
  'ui/chat/MessageActions.tsx': ['unit/message-actions.test.tsx'],
  'ui/chat/MessageContent.tsx': ['unit/message-content.test.tsx'],
  'ui/chat/MessageList.tsx': [
    'unit/message-list-performance.test.tsx',
    'unit/message-list-prepend-anchor.test.tsx',
  ],
  'ui/chat/PrefillSettingsPrompt.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/chat/ReasoningBlock.tsx': ['unit/message-header.test.tsx', 'e2e/reasoning-ui.spec.ts'],
  'ui/chat/ScrollRegion.tsx': ['unit/scroll-region.test.tsx', 'e2e/scroll.spec.ts'],
  'ui/chat/ToastTray.tsx': ['unit/live-regions.test.tsx', 'unit/notice-actions.test.tsx'],
  'ui/chat/ToolEvidenceBlock.tsx': [
    'unit/branch-tree-inspector.test.tsx',
    'e2e/advanced-generation-routing.spec.ts',
  ],
  'ui/chat/TreeDensityToggle.tsx': ['e2e/branch-tree.spec.ts'],
  'ui/chat/ZeroEligibleModal.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/header/ConnectionDeleteDialog.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/header/ConnectionHeader.tsx': ['unit/connection-header.test.tsx'],
  'ui/settings/AppearanceSettings.tsx': ['unit/appearance-settings.test.tsx'],
  'ui/settings/CachingPanel.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/settings/ChatModelPanel.tsx': ['unit/shell.test.tsx'],
  'ui/settings/ConnectionsSettings.tsx': [
    'unit/connections-settings.test.tsx',
    'e2e/connection-manager.spec.ts',
  ],
  'ui/settings/ContextPanel.tsx': ['unit/context-panel.test.tsx'],
  'ui/settings/GeneralSettings.tsx': ['unit/general-settings.test.tsx'],
  'ui/settings/GlobalSettingsModal.tsx': ['unit/shell.test.tsx'],
  'ui/settings/ImageAllowlistPanel.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/settings/InfoDisclosure.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/settings/LlamaServerSection.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/settings/ModelPicker.tsx': ['e2e/advanced-generation-routing.spec.ts'],
  'ui/settings/ParamForm.tsx': ['unit/param-form.test.tsx', 'unit/param-form-api-mode.test.tsx'],
  'ui/settings/PerformanceSettings.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/settings/PrivacySection.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/settings/PromptPresetEditor.tsx': ['unit/prompt-preset-editor.test.tsx'],
  'ui/settings/PromptsTab.tsx': ['unit/interaction-surfaces.test.tsx'],
  'ui/settings/ProviderPicker.tsx': [
    'unit/privacy-policies.test.tsx',
    'e2e/advanced-generation-routing.spec.ts',
  ],
  'ui/settings/RenderingSettings.tsx': ['unit/rendering-settings.test.tsx'],
  'ui/settings/TextTemplateSection.tsx': ['e2e/advanced-generation-routing.spec.ts'],
  'ui/sidebar/ChatList.tsx': ['unit/chat-list-preferences.test.tsx', 'e2e/sidebar.spec.ts'],
  'ui/storage/StorageView.tsx': ['unit/storage-view.test.tsx', 'e2e/storage-reclamation.spec.ts'],
  'ui/storage/StorageChatsSurface.tsx': [
    'unit/storage-view.test.tsx',
    'e2e/storage-reclamation.spec.ts',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>

const USER_EVENT_ATTRIBUTES = new Set([
  'onChange',
  'onClick',
  'onContextMenu',
  'onDoubleClick',
  'onDragEnd',
  'onDragEnter',
  'onDragLeave',
  'onDragOver',
  'onDragStart',
  'onDrop',
  'onInput',
  'onKeyDown',
  'onKeyUp',
  'onMouseDown',
  'onMouseEnter',
  'onMouseLeave',
  'onMouseUp',
  'onPointerCancel',
  'onPointerDown',
  'onPointerMove',
  'onPointerUp',
  'onSubmit',
  'onTouchCancel',
  'onTouchEnd',
  'onTouchMove',
  'onTouchStart',
])

const INTERACTIVE_INTRINSICS = new Set([
  'a',
  'button',
  'details',
  'form',
  'input',
  'select',
  'summary',
  'textarea',
])

const INTERACTIVE_COMPONENTS = new Set([
  'Button',
  'ConfirmDialog',
  'Dialog',
  'IconButton',
  'SvgAction',
])

const USER_DOM_EVENTS = new Set([
  'click',
  'contextmenu',
  'dblclick',
  'dragend',
  'dragenter',
  'dragleave',
  'dragover',
  'dragstart',
  'drop',
  'input',
  'keydown',
  'keyup',
  'mousedown',
  'mouseup',
  'pointercancel',
  'pointerdown',
  'pointermove',
  'pointerup',
  'scroll',
  'scrollend',
  'submit',
  'touchcancel',
  'touchend',
  'touchmove',
  'touchstart',
  'wheel',
])

const BEHAVIOR_EVIDENCE =
  /\b(?:fireEvent|userEvent)\s*\.\s*[A-Za-z]+\s*\(|\.\s*(?:check|clear|click|dblclick|dispatchEvent|dragAndDrop|dragTo|fill|focus|hover|press|pressSequentially|selectOption|setChecked|setInputFiles|tap|type|uncheck)\s*\(/u

function walk(dir: string, suffix: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stats = statSync(path)
    if (stats.isDirectory()) files.push(...walk(path, suffix))
    else if (path.endsWith(suffix)) files.push(path)
  }
  return files
}

function containsImplementedInteraction(path: string): boolean {
  const source = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    const eventName = ts.isCallExpression(node) ? node.arguments[0] : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addEventListener' &&
      eventName !== undefined &&
      ts.isStringLiteral(eventName) &&
      USER_DOM_EVENTS.has(eventName.text)
    ) {
      found = true
      return
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile)
      if (INTERACTIVE_INTRINSICS.has(tag) || INTERACTIVE_COMPONENTS.has(tag)) {
        found = true
        return
      }
      for (const attribute of node.attributes.properties) {
        if (
          ts.isJsxAttribute(attribute) &&
          USER_EVENT_ATTRIBUTES.has(attribute.name.getText(sourceFile))
        ) {
          found = true
          return
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function collectSemanticHooks(path: string): readonly string[] {
  const source = readFileSync(path, 'utf8')
  const hooks = new Set<string>()
  for (const match of source.matchAll(/\bdata-(?:control|ui)\s*=\s*["']([^"']+)["']/gu)) {
    const hook = match[1]
    if (hook) hooks.add(hook)
  }
  return [...hooks]
}

function styleOwnsHook(source: string, hook: string): boolean {
  const escaped = hook.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`\\[data-(?:control|ui)=["']${escaped}["']\\]`, 'u').test(source)
}

function sourcePath(relativePath: string): string {
  return join(SOURCE_ROOT, relativePath)
}

function stylePath(filename: string): string {
  return join(SOURCE_ROOT, 'styles', filename)
}

function testPath(relativePath: string): string {
  return join(PROJECT_ROOT, 'tests', relativePath)
}

function componentName(source: string): string {
  return basename(source, '.tsx')
}

function sourceSpecificHooks(
  source: string,
  hookOwners: ReadonlyMap<string, ReadonlySet<string>>,
): readonly string[] {
  return collectSemanticHooks(sourcePath(source)).filter((hook) => hookOwners.get(hook)?.size === 1)
}

function importedComponentNames(testFile: string, source: string): readonly string[] {
  const testSource = readFileSync(testFile, 'utf8')
  const sourceFile = ts.createSourceFile(
    testFile,
    testSource,
    ts.ScriptTarget.Latest,
    true,
    testFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const sourceWithoutExtension = sourcePath(source).replace(/\.tsx$/u, '')
  const imports = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause
    ) {
      continue
    }
    const resolvedImport = resolve(dirname(testFile), statement.moduleSpecifier.text).replace(
      /\.(?:ts|tsx|js|jsx)$/u,
      '',
    )
    if (resolvedImport !== sourceWithoutExtension) continue
    if (statement.importClause.name) imports.add(statement.importClause.name.text)
    const bindings = statement.importClause.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) imports.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) imports.add(element.name.text)
    }
  }
  return [...imports]
}

function testCases(testFile: string): readonly string[] {
  const source = readFileSync(testFile, 'utf8')
  const sourceFile = ts.createSourceFile(
    testFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    testFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const cases: string[] = []
  const localFunctions = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      localFunctions.set(statement.name.text, statement.getText(sourceFile))
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        localFunctions.set(declaration.name.text, declaration.getText(sourceFile))
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : null
      const callback = node.arguments.find(
        (argument): argument is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument),
      )
      if ((name === 'it' || name === 'test') && callback) {
        cases.push(node.getText(sourceFile))
        return
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return cases.map((testCase) => {
    let expanded = testCase
    const included = new Set<string>()
    let changed = true
    while (changed) {
      changed = false
      for (const [name, body] of localFunctions) {
        if (included.has(name)) continue
        if (!new RegExp(`\\b${name.replace(/[$]/gu, '\\$&')}\\s*\\(`, 'u').test(expanded)) {
          continue
        }
        included.add(name)
        expanded = `${expanded}\n${body}`
        changed = true
      }
    }
    return expanded
  })
}

function testCaseLinksSource(
  testCase: string,
  importedNames: readonly string[],
  hooks: readonly string[],
): boolean {
  if (
    importedNames.some((name) => {
      const escaped = name.replace(/[$]/gu, '\\$&')
      return new RegExp(`(?:<\\s*${escaped}\\b|\\b${escaped}\\s*\\()`, 'u').test(testCase)
    })
  ) {
    return true
  }
  return hooks.some(
    (hook) =>
      testCase.includes(`data-ui="${hook}"`) ||
      testCase.includes(`data-ui='${hook}'`) ||
      testCase.includes(`data-control="${hook}"`) ||
      testCase.includes(`data-control='${hook}'`),
  )
}

describe('implemented interaction inventory', () => {
  it('assigns every implemented feature interaction to exactly one ownership area', () => {
    const discovered = walk(join(SOURCE_ROOT, 'app'), '.tsx')
      .concat(walk(join(SOURCE_ROOT, 'ui'), '.tsx'))
      .filter((path) => !path.includes(`${join('ui', 'primitives')}/`))
      .filter(containsImplementedInteraction)
      .map((path) => relative(SOURCE_ROOT, path))
      .sort()
    const declared = IMPLEMENTED_INTERACTION_AREAS.flatMap((area) => area.sources).sort()

    expect(declared).toEqual([...new Set(declared)])
    expect(declared).toEqual(discovered)
  })

  it('binds every area to real semantic surfaces and declared stylesheet owners', () => {
    const failures: string[] = []
    for (const area of IMPLEMENTED_INTERACTION_AREAS) {
      const styles = area.stylesheets.map((filename) => readFileSync(stylePath(filename), 'utf8'))
      for (const source of area.sources) {
        const hooks = collectSemanticHooks(sourcePath(source))
        if (hooks.length === 0) {
          failures.push(`${area.name}: ${source} has no static data-ui/data-control surface`)
          continue
        }
        if (!hooks.some((hook) => styles.some((style) => styleOwnsHook(style, hook)))) {
          failures.push(
            `${area.name}: ${source} has no surface owned by ${area.stylesheets.join(', ')}`,
          )
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('binds every implemented interaction source to named behavioral evidence', () => {
    const failures: string[] = []
    const declared = IMPLEMENTED_INTERACTION_AREAS.flatMap((area) => area.sources).sort()
    expect(Object.keys(SOURCE_BEHAVIOR_TESTS).sort()).toEqual(declared)
    const hookOwners = new Map<string, Set<string>>()
    for (const source of declared) {
      for (const hook of collectSemanticHooks(sourcePath(source))) {
        const owners = hookOwners.get(hook) ?? new Set<string>()
        owners.add(source)
        hookOwners.set(hook, owners)
      }
    }

    for (const source of declared) {
      const behaviorTests = SOURCE_BEHAVIOR_TESTS[source] as readonly string[] | undefined
      if (!behaviorTests || behaviorTests.length === 0) {
        failures.push(`${source}: no behavior tests declared`)
        continue
      }
      const hooks = sourceSpecificHooks(source, hookOwners)
      const hasEvidence = behaviorTests.some((path) => {
        const absoluteTestPath = testPath(path)
        const importedNames = importedComponentNames(absoluteTestPath, source)
        return testCases(absoluteTestPath).some(
          (testCase) =>
            BEHAVIOR_EVIDENCE.test(testCase) && testCaseLinksSource(testCase, importedNames, hooks),
        )
      })
      if (!hasEvidence) {
        failures.push(
          `${source} (${componentName(source)}; hooks: ${hooks.join(', ') || 'none'}): ${behaviorTests.join(', ')}`,
        )
      }
    }
    expect(failures).toEqual([])
  })
})
