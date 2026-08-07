import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  conversationMutationTarget,
  generationSubmitTarget,
  reportConversationMutationFailure,
  reportGenerationSubmissionFailure,
  reportGenerationSubmissionPhase,
} from '../../src/app/presentation-interactions'

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
  it('keeps durable temporal ordering behind transaction and lease epoch boundaries', () => {
    const browser = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-repo.ts'), 'utf8'),
    )
    const mutationRuntime = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-mutation-runtime.ts'), 'utf8'),
    )
    const configuration = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-configuration-domain.ts'), 'utf8'),
    )
    const leases = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/stream-leases.ts'), 'utf8'),
    )
    const recovery = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/stream-recovery.ts'), 'utf8'),
    )
    const policy = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/stream-lease-policy.ts'), 'utf8'),
    )
    const ordering = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/transaction-order.ts'), 'utf8'),
    )

    expect(mutationRuntime.match(/new TransactionMessageCreationClock\(\)/gu)).toHaveLength(1)
    expect(mutationRuntime).toContain(
      'clone.createdAt = await messageCreationClock.next(tx, clone.chatId, now)',
    )
    expect(browser).toContain('now - (headers.length - index)')
    expect(mutationRuntime).toContain(
      'next.updatedAt = await nextChatUpdatedAtInTransaction(tx, now)',
    )
    expect(configuration).toContain('updatedAt: await clock.next(tx, now)')
    expect(browser).not.toMatch(/heartbeat\.heartbeatAt <= existing\.heartbeatAt/u)
    expect(leases).toContain('return globalThis.performance.now()')
    expect(recovery).toContain('return globalThis.performance.now()')
    expect(leases).not.toContain('heartbeatSchedulerNow(): number {\n  return Date.now()')
    expect(recovery).not.toContain('leaseSchedulerNow(): number {\n  return Date.now()')
    expect(recovery).toContain('freshnessEpoch === streamLeaseFreshnessEpoch(current)')
    expect(policy).toContain("if (age < 0) return 'future'")
    expect(ordering).toContain("orderBy('updatedAt').last()")
    expect(ordering).toContain("where('[chatId+createdAt+id]')")
    expect(ordering).not.toMatch(/(?:toArray|toCollection)\s*\(/u)
  })

  it('exposes only atomic stream-journal final cleanup', () => {
    const protocol = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/workspace-protocol.ts'), 'utf8'),
    )
    const browser = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-repo.ts'), 'utf8'),
    )
    expect(protocol).toContain("kind: 'stream.finish-cleanup'")
    expect(protocol).not.toContain("kind: 'stream.delete-chunks'")
    expect(browser).not.toContain('deleteStreamChunks(')
  })

  it('centralizes every live stream-lease retirement with its journal chunks', () => {
    const allowed = new Set(['store/stream-journal-storage.ts'])
    const offenders: string[] = []
    const directAliasDelete = /(?<!\.)\b(?:leaseTable|leases)\.(?:bulkDelete|clear|delete)\s*\(/u
    const directTableDelete =
      /\.table\s*<\s*StreamLeaseRow[^>]*>\s*\(\s*['"]streamLeases['"]\s*\)\s*\.delete\s*\(/u
    for (const file of sourceFiles()) {
      const path = rel(file)
      if (path.startsWith('backcompat/') || allowed.has(path)) continue
      const text = withoutComments(readFileSync(file, 'utf8'))
      if (directAliasDelete.test(text) || directTableDelete.test(text)) offenders.push(path)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('keeps configuration writes behind the semantic configuration domain', () => {
    const legacyKinds = [
      'profile.create',
      'profile.update',
      'profile.delete',
      'profile.duplicate',
      'profile.touch',
      'preset.create',
      'preset.update',
      'preset.duplicate',
      'preset.reorder',
      'preset.touch',
      'preset.delete',
      'prompt-preset.put',
      'prompt-preset.update',
      'prompt-preset.delete',
      'prompt-preset.touch',
      'key.put',
      'key.touch',
      'key.replace',
      'key.delete',
      'setting.put',
      'setting.delete',
      'setting.compare-exchange',
    ]
    const protocol = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/workspace-protocol.ts'), 'utf8'),
    )
    const backend = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-repo.ts'), 'utf8'),
    )
    expect(protocol).not.toContain('type ConfigCommand')
    for (const kind of legacyKinds) {
      expect(protocol).not.toMatch(
        new RegExp(`\\bkind\\s*:\\s*['"]${kind.replace('.', '\\.')}['"]`, 'u'),
      )
      expect(backend).not.toMatch(new RegExp(`\\bcase\\s+['"]${kind.replace('.', '\\.')}['"]`, 'u'))
    }
  })

  it('routes every browser configuration operation through one semantic plan executor', () => {
    const configuration = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-configuration-domain.ts'), 'utf8'),
    )
    const browser = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-repo.ts'), 'utf8'),
    )
    expect(configuration.match(/\bcommandMeta\.executeSemanticOperation\s*[<(]/gu)).toHaveLength(14)
    expect(configuration).not.toMatch(/\bcommandMeta\.withLocks\s*\(/u)
    expect(configuration).not.toMatch(/\blocked\.runTransaction\s*\(/u)
    expect(configuration).not.toMatch(/\.transaction\s*\(/u)
    expect(browser).toContain(
      'return this.lockSession.withResourceLocks(resourceNames, async (grant) => {',
    )
    expect(browser).toContain(
      'return this.runTransaction(grant, descriptor.transaction, operation, {',
    )
    expect(configuration).toContain('chatRequestTargetOperationDescriptor')
    expect(configuration).toContain('semanticOperationExactReceiptReplayProofContract')
    expect(configuration).toContain("'chat-preset.apply': applyChatPreset")
  })

  it('uses one controller-owned active configuration target', () => {
    const protocol = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/workspace-protocol.ts'), 'utf8'),
    )
    const controller = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/configuration-controller.ts'), 'utf8'),
    )
    const shell = withoutComments(readFileSync(resolve(SRC_ROOT, 'app/Shell.tsx'), 'utf8'))
    expect(protocol).not.toContain("kind: 'chat.seed'")
    expect(protocol).not.toContain("kind: 'chat-seed'")
    expect(controller).not.toContain('loadChatSeed')
    expect(controller).toContain('type ActiveConfigurationTarget')
    expect(controller).toContain('ConfigurationProjectionLoadState')
    expect(shell).not.toContain('useRepositoryQueryState')
    expect(shell).not.toMatch(/\bgetChat\s*\(/u)
    expect(shell).not.toContain('resolveConfigurationTarget')
    expect(shell).toContain('configurationSession.frame.target')
  })

  it('keeps model-discovery scheduling behind one configuration-owned coordinator', () => {
    const hook = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'hooks/useModelCatalog.ts'), 'utf8'),
    )
    const controller = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/configuration-controller.ts'), 'utf8'),
    )
    const coordinator = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/configuration-discovery-coordinator.ts'), 'utf8'),
    )
    const serviceImporters = sourceFiles()
      .filter((file) =>
        importStatements(withoutComments(readFileSync(file, 'utf8'))).some((statement) =>
          /from ['"][^'"]*discovery-service['"]/u.test(statement),
        ),
      )
      .map(rel)
      .sort()

    expect(serviceImporters).toEqual([
      'store/configuration-discovery-coordinator.ts',
      'store/generation-planning-reader.ts',
    ])
    expect(hook).not.toMatch(/\b(?:AbortController|setTimeout|setInterval|Date\.now)\b/u)
    expect(hook).not.toContain('discovery-service')
    expect(hook).toContain('configurationController.observeDiscoverySurface')
    expect(controller.match(/new ConfigurationDiscoveryCoordinator\s*\(/gu)).toHaveLength(1)
    expect(coordinator.match(/new AbortController\s*\(/gu)).toHaveLength(1)
    expect(coordinator.match(/\bsetTimeout\s*\(/gu)).toHaveLength(1)
    expect(coordinator).not.toMatch(/\bnew Map\s*[<(]/u)
  })

  it('centralizes message-corpus search construction behind the store service', () => {
    const allowed = new Set(['store/message-search-service.ts', 'store/workspace-protocol.ts'])
    const directCorpusQuery = /\bkind\s*:\s*['"]message\.search-corpus['"]/u
    const failures: string[] = []
    for (const file of sourceFiles()) {
      const path = rel(file)
      if (allowed.has(path)) continue
      if (directCorpusQuery.test(withoutComments(readFileSync(file, 'utf8')))) {
        failures.push(path)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('only api/assistant-stream.ts imports and calls generation adapters', () => {
    const allowed = new Set([
      'api/assistant-stream.ts',
      'api/chat-completions.ts',
      'api/gemini-native.ts',
      'api/responses.ts',
      'api/text-completions.ts',
    ])
    const adapterImport =
      /from ['"][^'"]*(chat-completions|gemini-native|responses|text-completions)['"]/u
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

  it('keeps one application planner over the API wire-transform boundary', () => {
    const allowed = new Set([
      'api/request-transforms.ts',
      'core/api-choice.ts',
      'store/request-planning.ts',
      'ui/settings/ParamForm.tsx',
    ])
    const routeOrTransformImport = /from ['"][^'"]*(core\/api-choice|api\/request-transforms)['"]/u
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

  it('captures discovery baselines once at prepare and never re-reads them while planning', () => {
    const protocol = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/workspace-protocol.ts'), 'utf8'),
    )
    const mutationRuntime = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-mutation-runtime.ts'), 'utf8'),
    )
    const reader = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/generation-planning-reader.ts'), 'utf8'),
    )
    const captureStart = mutationRuntime.indexOf('async function captureGenerationPlanningSnapshot')
    const captureEnd = mutationRuntime.indexOf(
      'export async function runBrowserMutation',
      captureStart,
    )
    const capture = mutationRuntime.slice(captureStart, captureEnd)
    expect(protocol).toContain('discovery: {')
    expect(captureStart).toBeGreaterThanOrEqual(0)
    expect(captureEnd).toBeGreaterThan(captureStart)
    expect(capture.match(/readDiscoveryCacheRow\s*\(/gu)).toHaveLength(3)
    expect(reader).toContain('this.snapshot.discovery')
    expect(reader).toContain('baseline: captured')
    expect(reader).not.toContain('readModelsDiscoveryCache')
    expect(reader).not.toContain('readPrivacyDiscoveryCache')
    expect(reader).not.toMatch(/kind\s*:\s*['"]discovery\./u)
  })

  it('keeps prompt estimation on one presentation path and one fresh generation path', () => {
    const callers = (call: RegExp, excluded: ReadonlySet<string>) =>
      sourceFiles()
        .map((file) => ({ file, path: rel(file) }))
        .filter(({ path }) => !excluded.has(path))
        .filter(({ file }) => call.test(withoutComments(readFileSync(file, 'utf8'))))
        .map(({ path }) => path)
        .sort()

    expect(callers(/\bloadSendContextForBranch\s*\(/u, new Set(['store/send-context.ts']))).toEqual(
      [],
    )
    expect(
      callers(/\bloadGenerationContextForBranch\s*\(/u, new Set(['store/send-context.ts'])),
    ).toEqual(['store/generation-engine.ts'])
    expect(
      callers(/\bloadPromptEstimateContextForBranch\s*\(/u, new Set(['store/send-context.ts'])),
    ).toEqual(['store/prompt-estimate-context-controller.ts'])
    expect(
      callers(/\bbuildSettingsPromptSizeEstimateInput\s*\(/u, new Set(['core/prompt-size.ts'])),
    ).toEqual(['ui/settings/ChatModelPanel.tsx'])
    expect(callers(/\bestimatePromptSize\s*\(/u, new Set(['core/prompt-size.ts']))).toEqual([
      'hooks/useStreamStablePromptEstimate.ts',
    ])
    expect(
      callers(
        /\buseDeferredStreamStablePromptEstimate\s*\(/u,
        new Set(['hooks/useStreamStablePromptEstimate.ts']),
      ),
    ).toEqual(['ui/settings/ChatModelPanel.tsx'])

    const panel = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'ui/settings/ChatModelPanel.tsx'), 'utf8'),
    )
    expect(panel).not.toMatch(/composer-draft-state|useComposerContextDraft|draftAttachmentRefs/u)
  })

  it('funnels every generation intent through one exact planning engine', () => {
    const client = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/conversation-command-client.ts'), 'utf8'),
    )
    const engine = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/generation-engine.ts'), 'utf8'),
    )
    const directStarters = sourceFiles()
      .filter((file) => rel(file) !== 'store/generation-engine.ts')
      .filter((file) =>
        /\bgenerationEngine\.start\s*\(/u.test(withoutComments(readFileSync(file, 'utf8'))),
      )
      .map(rel)
      .sort()

    expect(directStarters).toEqual(['store/conversation-command-client.ts'])
    expect(client.match(/\bgenerationEngine\.start\s*\(/gu)).toHaveLength(6)
    expect(client.match(/\bgenerationEngine\.startWhenCapabilitySettles\s*\(/gu)).toHaveLength(6)
    for (const kind of [
      'new-chat-send',
      'send',
      'reply',
      'regenerate',
      'edit-resend',
      'continue',
    ]) {
      expect(client).toMatch(new RegExp(`kind\\s*:\\s*['"]${kind}['"]`, 'u'))
    }
    expect(engine.match(/await resolveAssistantRequestFacts\s*\(/gu)).toHaveLength(1)
    expect(engine.match(/await loadExactPlanningContext\s*\(/gu)).toHaveLength(1)
    expect(
      engine.match(/await prepareAssistantRequestPlanFromContextSelection\s*\(/gu),
    ).toHaveLength(1)
    expect(engine.indexOf('await resolveAssistantRequestFacts(')).toBeLessThan(
      engine.indexOf('await prepareAssistantRequestPlanFromContextSelection('),
    )
    expect(engine).toContain('selectContext: async (frame) =>')
    expect(engine).toContain('return { selectedContext, settings }')
    expect(engine).toContain('const sendContext = plannedRequest.selectedContext')
    expect(engine).toContain('facts: requestFacts')
    expect(engine).toContain('pendingPlanningMessages(')
    expect(engine).not.toContain('draftText:')
    expect(engine.match(/compactGenerationRuntimeIntent\(preparedIntent\)/gu)).toHaveLength(1)
    expect(engine).toContain('generationAdmissionController.takePayload(\n    input.claim,')
    expect(engine).toContain('const preparedIntent = admission.intent')
    expect(engine.indexOf('const preparedIntent = admission.intent')).toBeLessThan(
      engine.indexOf('compactGenerationRuntimeIntent(preparedIntent)'),
    )
  })

  it('keeps existing-chat admission transactional while treating projections only as hints', () => {
    const protocol = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/workspace-protocol.ts'), 'utf8'),
    )
    const admission = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/generation-admission-controller.ts'), 'utf8'),
    )
    const capability = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/generation-capability-controller.ts'), 'utf8'),
    )
    const attemptController = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/attempt-controller.ts'), 'utf8'),
    )
    const browser = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-repo.ts'), 'utf8'),
    )
    const command = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-generation-command-runtime.ts'), 'utf8'),
    )
    const production = sourceFiles()
      .map((file) => withoutComments(readFileSync(file, 'utf8')))
      .join('\n')
    const placementStart = protocol.indexOf('export interface PrepareAttemptPlacementIntent')
    const placementEnd = protocol.indexOf('export type PrepareAttemptInput', placementStart)
    const placement = protocol.slice(placementStart, placementEnd)

    expect(production).not.toContain('GenerationPlanningSeedChanged')
    expect(production).not.toContain('selected-send')
    expect(production).not.toContain('sendSelectedMessage')
    expect(production).not.toContain('presentGenerationIntent')
    expect(protocol).toContain('readonly pathHint: GenerationPromptPathReadHint')
    expect(admission).toContain(
      'material: conversationController.acquirePromptMaterial(workspace, chatId, [])',
    )
    expect(capability).toContain('return existingGenerationCapability(')
    expect(capability).toContain(
      "attemptAdmission.admission(probe.targetAssistantId) === 'occupied'",
    )
    expect(capability).not.toContain(
      "attemptAdmission.admission(probe.targetAssistantId) === 'unknown'",
    )
    expect(admission).toContain('const trackedAttemptFrame = context.attemptAdmission')
    expect(admission).toContain('trackedAttemptFrame?.workspaceId === workspace.workspaceId')
    expect(attemptController).toContain(
      "this.getTargetAdmissionFrame(chatId).admission(messageId) === 'occupied'",
    )
    expect(attemptController).not.toContain(
      "this.getTargetAdmissionFrame(chatId).admission(messageId) !== 'available'",
    )
    expect(browser).toContain('readCurrentGenerationPromptPathFromHint(')
    expect(browser).toContain('(await readBranchPathInTransaction(tx, chatId, leafId))')
    expect(protocol).toContain('readonly target: ActiveBranchIntentTarget')
    expect(browser).toContain('resolveGenerationSendPathInTransaction(')
    expect(browser).toContain('resolvingConversationSelectionTarget(selection)')
    expect(admission).toMatch(/case 'send':[\s\S]*?childSlot: 'append'/u)
    expect(admission).toMatch(/case 'reply':[\s\S]*?childSlot: 'append'/u)
    expect(command).toContain('const currentChat = await ctx.getChat(chatId)')
    expect(command).toContain('const slot = promptPath.slot')
    expect(placementStart).toBeGreaterThanOrEqual(0)
    expect(placementEnd).toBeGreaterThan(placementStart)
    expect(placement).not.toMatch(/\b(?:model|parentId|siblingIndex)\b/u)
  })

  it('routes every UI generation gesture through one owned settling submission', () => {
    const uiGenerationBypasses = sourceFiles()
      .map((file) => ({ file, path: rel(file) }))
      .filter(({ path }) => /^(?:app|hooks|ui)\//u.test(path))
      .filter(({ path }) => path !== 'app/conversation-actions.ts')
      .filter(({ file }) =>
        /(?:conversationActions|requireConversationActions\(\))\.(?:editAndResend|regenerate|continueMessage)\s*\(/u.test(
          withoutComments(readFileSync(file, 'utf8')),
        ),
      )
      .map(({ path }) => path)
      .sort()
    const shell = withoutComments(readFileSync(resolve(SRC_ROOT, 'app/Shell.tsx'), 'utf8'))
    const submitStart = shell.indexOf('const handleSubmit = useCallback(')
    const submitEnd = shell.indexOf('const handleNewChatSubmit = useCallback(', submitStart)
    const submit = shell.slice(submitStart, submitEnd)
    const silentUiNonStarts = sourceFiles()
      .map((file) => ({ path: rel(file), source: withoutComments(readFileSync(file, 'utf8')) }))
      .filter(({ path }) => /^(?:app|ui)\//u.test(path))
      .filter(({ source }) => /\bgenerationNotStarted\s*\(/u.test(source))
      .map(({ path }) => path)
      .sort()
    const readinessPermissionBypasses = sourceFiles()
      .map((file) => ({ path: rel(file), source: withoutComments(readFileSync(file, 'utf8')) }))
      .filter(({ path }) => /^(?:app|ui)\//u.test(path))
      .filter(({ source }) =>
        /\bgenerationCapability(?:Available|CanOwnIntent)\b|(?:generation|editResend|regenerate|continue)Capability\.state\s*===\s*['"]ready['"]/u.test(
          source,
        ),
      )
      .map(({ path }) => path)
      .sort()
    const message = withoutComments(readFileSync(resolve(SRC_ROOT, 'ui/chat/Message.tsx'), 'utf8'))
    const messageActions = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'ui/chat/MessageActions.tsx'), 'utf8'),
    )
    const branchInspector = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'ui/chat/BranchTreeInspector.tsx'), 'utf8'),
    )
    const inlineEditor = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'ui/chat/InlineEditor.tsx'), 'utf8'),
    )
    const messageList = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'ui/chat/MessageList.tsx'), 'utf8'),
    )
    const branchTree = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'ui/chat/BranchTreeView.tsx'), 'utf8'),
    )

    expect(uiGenerationBypasses).toEqual([])
    expect(silentUiNonStarts).toEqual([])
    expect(readinessPermissionBypasses).toEqual([])
    expect(message).not.toContain('availability?.blocksReplacement')
    expect(branchInspector).not.toContain('availability?.blocksReplacement')
    expect(message).not.toContain('saveAndSendDisabled')
    expect(branchInspector).not.toContain('saveAndSendDisabled')
    expect(messageActions).not.toMatch(/\b(?:regeneration|continuation)Disabled\b/u)
    expect(inlineEditor).not.toContain('saveAndSendDisabled')
    expect(inlineEditor).toContain('disabled={uploadingAttachments}')
    expect(messageList).not.toMatch(/\bgenerationCapabilityFrame\b|\.capability\s*\(/u)
    expect(branchTree).not.toMatch(/\bgenerationCapabilityFrame\b|\.capability\s*\(/u)
    expect(shell.match(/\bownGenerationSubmission\s*\(/gu)).toHaveLength(6)
    expect(shell.match(/\bgenerationSubmitTarget\s*\(/gu)).toHaveLength(4)
    expect(shell).not.toMatch(/\bownGenerationSubmission\s*\(\s*generationSubmitTarget\s*\(/u)
    expect(shell).not.toMatch(/\b(?:readonly\s+)?admit\b|\badmit\s*\(\s*\)/u)
    expect(submit).toContain(
      'const target = conversationController.captureGenerationTarget(activeChatId)',
    )
    expect(submit).toContain(
      'sendMessageWhenCapabilitySettles(\n            activeChatId,\n            target,',
    )
    expect(submit).not.toContain('activeBranchTailId')
    const submissionOwner = shell.slice(
      shell.indexOf('const ownGenerationSubmission'),
      shell.indexOf('const cancelGenerationSubmission'),
    )
    expect(submissionOwner.indexOf('await action({')).toBeGreaterThanOrEqual(0)
    expect(submissionOwner.indexOf('await action({')).toBeLessThan(
      submissionOwner.indexOf("reportPhase(id, 'admitted')"),
    )
    expect(shell).toContain('editAndResendWhenCapabilitySettles(')
    expect(shell).toContain('regenerateWhenCapabilitySettles(')
    expect(shell).toContain('continueMessageWhenCapabilitySettles(')
  })

  it('owns conversation mutations in Shell instead of split surface presenters', () => {
    const owners = sourceFiles()
      .map((file) => ({ path: rel(file), source: withoutComments(readFileSync(file, 'utf8')) }))
      .filter(({ source }) =>
        /\busePresentationInteraction\s*\(\s*conversationMutationInteraction/u.test(source),
      )
      .map(({ path }) => path)
      .sort()
    const messageList = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'ui/chat/MessageList.tsx'), 'utf8'),
    )

    expect(owners).toEqual(['app/Shell.tsx'])
    expect(messageList).toContain('runConversationMutation: ConversationMutationRunner')
    expect(messageList).not.toContain('conversationMutationInteraction')
    expect(conversationMutationTarget({ kind: 'delete', chatId: 'chat-1' })).toBe(
      conversationMutationTarget({
        kind: 'fork',
        chatId: 'chat-1',
        messageId: 'message-1',
      }),
    )
  })

  it('keeps edit presentation retention out of the authoritative workspace lifetime', () => {
    const actions = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'app/conversation-actions.ts'), 'utf8'),
    )
    const start = actions.indexOf('function beginMessageEditSession(')
    const end = actions.indexOf('export interface ConversationImportInput', start)
    const editSession = actions.slice(start, end)
    const client = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/conversation-command-client.ts'), 'utf8'),
    )

    expect(editSession).toContain('conversationController.claimTranscriptRetention({')
    expect(editSession).toContain('workspaceFence,')
    expect(editSession).not.toMatch(/\brunWorkspace(?:Action|ActionAtFence|Read)\s*\(/u)
    expect(client).toContain("runWorkspaceAction(\n    'message-edit',")
  })

  it('owns every generation gesture at one chat-level target', () => {
    const editTarget = generationSubmitTarget({
      chatId: 'chat-1',
      action: 'edit-resend',
      messageId: 'user-1',
    })
    const regenerateTarget = generationSubmitTarget({
      chatId: 'chat-1',
      action: 'regenerate',
      messageId: 'assistant-1',
    })
    const continueTarget = generationSubmitTarget({
      chatId: 'chat-1',
      action: 'continue',
      messageId: 'assistant-2',
    })

    expect(editTarget).toBe(regenerateTarget)
    expect(regenerateTarget).toBe(continueTarget)
    expect(
      generationSubmitTarget({
        chatId: 'chat-2',
        action: 'composer',
      }),
    ).not.toBe(editTarget)
  })

  it('emits a correlated console diagnostic for every preparation failure', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(
        reportGenerationSubmissionFailure({
          claimId: 41,
          target: 'chat:chat-1:message:user-1:edit-resend',
          failure: { message: 'Workspace preparation failed.', tone: 'danger' },
        }),
      ).toEqual({
        message: 'Workspace preparation failed.',
        diagnosticId: 'generation-submit-41',
      })
      expect(error).toHaveBeenCalledWith(
        '[generation-submit][generation-submit-41]',
        expect.objectContaining({
          target: 'chat:chat-1:message:user-1:edit-resend',
          message: 'Workspace preparation failed.',
          tone: 'danger',
        }),
      )
      reportConversationMutationFailure({
        claimId: 43,
        target: 'chat:chat-1:structure',
        failure: { message: 'Delete transaction failed.', tone: 'danger' },
      })
      expect(error).toHaveBeenCalledWith(
        '[conversation-mutation][conversation-mutation-43]',
        expect.objectContaining({
          target: 'chat:chat-1:structure',
          message: 'Delete transaction failed.',
          tone: 'danger',
        }),
      )
    } finally {
      error.mockRestore()
    }
  })

  it('reports the exact preparation boundary without adding an admission gate', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      reportGenerationSubmissionPhase({
        claimId: 42,
        target: 'chat:chat-1:message:user-1:edit-resend',
        phase: 'waiting',
        owner: 'prompt-path',
      })
      reportGenerationSubmissionPhase({
        claimId: 42,
        target: 'chat:chat-1:message:user-1:edit-resend',
        phase: 'repository-requested',
      })

      expect(info).toHaveBeenNthCalledWith(
        1,
        '[generation-submit][generation-submit-42]',
        expect.objectContaining({
          phase: 'waiting',
          owner: 'prompt-path',
        }),
      )
      expect(info).toHaveBeenNthCalledWith(
        2,
        '[generation-submit][generation-submit-42]',
        expect.objectContaining({
          phase: 'repository-requested',
        }),
      )
    } finally {
      info.mockRestore()
    }
  })

  it('keeps saved template sources in point-addressed rows outside compatibility envelopes', () => {
    const allowedLegacySetting = new Set([
      'backcompat/import-export.ts',
      'backcompat/saved-text-template-rows.ts',
      'core/text-templates.ts',
      'store/browser-import-export.ts',
    ])
    const legacySettingOffenders: string[] = []
    for (const file of sourceFiles()) {
      const path = rel(file)
      if (allowedLegacySetting.has(path)) continue
      if (readFileSync(file, 'utf8').includes('global:text-templates:v1')) {
        legacySettingOffenders.push(path)
      }
    }
    expect(legacySettingOffenders).toEqual([])

    const browser = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'store/browser-repo.ts'), 'utf8'),
    )
    const selectionStart = browser.indexOf('private async getConfigurationActiveSelection')
    const selectionEnd = browser.indexOf(
      'private async getConfigurationActiveModel',
      selectionStart,
    )
    const selection = browser.slice(selectionStart, selectionEnd)
    expect(selection).toContain("table<SavedTextTemplate, TextTemplateId>('textTemplates').get")
    expect(selection).not.toMatch(/textTemplates[^\n]*(?:toArray|toCollection)/u)
    const captureStart = browser.indexOf('private async captureGenerationPlanningSnapshot')
    const captureEnd = browser.indexOf('private async getExactMessagePresentations', captureStart)
    expect(browser.slice(captureStart, captureEnd)).not.toContain("'textTemplates'")
  })

  it('compiles text templates once and renders through one append-only writer', () => {
    const templates = withoutComments(
      readFileSync(resolve(SRC_ROOT, 'core/text-templates.ts'), 'utf8'),
    )
    const renderStart = templates.indexOf('function renderTemplateString')
    const tokenizeStart = templates.indexOf('function tokenizeTemplate', renderStart)
    const executeStart = templates.indexOf('function renderTemplateNodes', tokenizeStart)
    const expressionCompileStart = templates.indexOf(
      'function compileTemplateExpression',
      executeStart,
    )
    const execute = templates.slice(executeStart, expressionCompileStart)
    const expressionExecuteStart = templates.indexOf(
      'function evaluateTemplateExpression',
      expressionCompileStart,
    )
    const expressionExecuteEnd = templates.indexOf(
      'function isProjectedTemplateMessage',
      expressionExecuteStart,
    )
    const expressionExecute = templates.slice(expressionExecuteStart, expressionExecuteEnd)

    expect(renderStart).toBeGreaterThanOrEqual(0)
    expect(tokenizeStart).toBeGreaterThan(renderStart)
    expect(executeStart).toBeGreaterThan(tokenizeStart)
    expect(expressionCompileStart).toBeGreaterThan(executeStart)
    expect(expressionExecuteStart).toBeGreaterThan(expressionCompileStart)
    expect(expressionExecuteEnd).toBeGreaterThan(expressionExecuteStart)
    expect(
      templates.slice(renderStart, tokenizeStart).match(/tokenizeTemplate\s*\(/gu),
    ).toHaveLength(1)
    expect(
      templates.slice(renderStart, tokenizeStart).match(/compileTemplate\s*\(/gu),
    ).toHaveLength(1)
    expect(execute).not.toMatch(/\b(?:tokenizeTemplate|compileTemplate)\s*\(/u)
    expect(execute).not.toContain('...context')
    expect(execute).toContain('context.variables.push(undefined)')
    expect(expressionExecute).not.toMatch(/\b(?:tokenizeTemplate|compileTemplate)\s*\(/u)
    expect(expressionExecute).not.toMatch(/\+=/u)
    expect(expressionExecute).toContain('appendTemplateExpression(value, context, writer)')
  })

  it('keeps provider and remote-output fetches behind the API transport boundary', () => {
    const failures: string[] = []
    for (const file of sourceFiles()) {
      const path = rel(file)
      if (path.startsWith('api/')) continue
      if (/\bfetch\s*\(/u.test(withoutComments(readFileSync(file, 'utf8')))) failures.push(path)
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
