const WORKSPACE_TABLE_KEYS = Object.freeze([
  'chats',
  'messages',
  'childLists',
  'chatBranchCache',
  'attachments',
  'profiles',
  'presets',
  'promptPresets',
  'folders',
  'tags',
  'drafts',
  'keys',
  'settings',
])

const PROMPT_PRESET_KINDS = Object.freeze([
  'system',
  'append',
  'continue-system',
  'continue-user',
  'prefill',
])

const FIXTURE_EPOCH = 1_780_000_000_000
const ACTIVE_CHAT_MESSAGE_COUNT = 96

export const GENERATED_WORKSPACE_FIXTURE_VERSION = 1
export const GENERATED_WORKSPACE_ACTIVE_CHAT_ID = 'generated-startup-active-chat'
export const GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID = `generated-active-message-${String(
  ACTIVE_CHAT_MESSAGE_COUNT - 1,
).padStart(3, '0')}`
export const GENERATED_WORKSPACE_ACTIVE_TERMINAL_MARKER = 'generated startup terminal destination'

export const GENERATED_WORKSPACE_SCALES = Object.freeze({
  control: Object.freeze({
    name: 'control',
    seed: 0x5a17_0001,
    chatCount: 16,
    profileCount: 4,
    presetCount: 12,
    promptPresetCount: 10,
    folderCount: 4,
    tagCount: 8,
  }),
  large: Object.freeze({
    name: 'large',
    seed: 0x5a17_4000,
    chatCount: 4_096,
    profileCount: 256,
    presetCount: 768,
    promptPresetCount: 120,
    folderCount: 4_096,
    tagCount: 4_096,
  }),
})

export function generateWorkspaceFixture(template, scale) {
  assertWorkspaceTemplate(template)
  assertScale(scale)
  const backup = structuredClone(template)
  const baseProfile = backup.payload.profiles[0]
  const basePreset = backup.payload.presets.find(
    (candidate) => candidate.connectionProfileId === baseProfile.id,
  )
  if (!basePreset) throw new Error('GeneratedWorkspaceBasePresetMissing')

  const random = seededRandom(scale.seed)
  const profiles = generateProfiles(baseProfile, scale.profileCount)
  const presets = generatePresets(basePreset, profiles, scale.presetCount)
  const presetsByProfile = indexPresetsByProfile(presets)
  const promptPresets = generatePromptPresets(scale.promptPresetCount)
  const folders = generateFolders(scale.folderCount)
  const tags = generateTags(scale.tagCount)
  const chats = []
  const messages = []

  const active = generateActiveChat(basePreset, folders, tags)
  chats.push(active.chat)
  messages.push(...active.messages)

  for (let index = 1; index < scale.chatCount; index += 1) {
    const profile = profiles[index % profiles.length]
    const candidatePresets = presetsByProfile.get(profile.id) ?? []
    const preset =
      candidatePresets[index % candidatePresets.length] ?? presets[index % presets.length]
    const generated = generateRandomChat({
      index,
      random,
      profile,
      preset,
      folders,
      tags,
    })
    chats.push(generated.chat)
    messages.push(...generated.messages)
  }

  backup.createdAt = FIXTURE_EPOCH
  backup.payload = {
    chats,
    messages,
    childLists: [],
    chatBranchCache: [],
    attachments: [],
    profiles,
    presets,
    promptPresets,
    folders,
    tags,
    drafts: [],
    keys: structuredClone(backup.payload.keys),
    settings: fixtureSettings(backup.payload.settings),
  }
  refreshWorkspaceManifest(backup)
  return backup
}

export function generatedWorkspaceFixtureStats(backup) {
  assertWorkspaceTemplate(backup)
  const messagesByChat = new Map()
  const childrenByMessage = new Map()
  let bodyTextChars = 0
  let assistantCost = 0
  let assistantPromptTokens = 0
  let assistantCompletionTokens = 0
  let branchedParentCount = 0
  let maxSiblingCount = 0

  for (const message of backup.payload.messages) {
    const chatRows = messagesByChat.get(message.chatId)
    if (chatRows) chatRows.push(message)
    else messagesByChat.set(message.chatId, [message])
    const parentKey = `${message.chatId}:${message.parentId ?? '__root__'}`
    const siblingCount = (childrenByMessage.get(parentKey) ?? 0) + 1
    childrenByMessage.set(parentKey, siblingCount)
    for (const content of message.content) {
      if (content.type === 'text' || content.type === 'output_text') {
        bodyTextChars += content.text.length
      }
    }
    if (message.generation?.usage) {
      assistantCost += message.generation.cost ?? 0
      assistantPromptTokens += message.generation.usage.prompt_tokens ?? 0
      assistantCompletionTokens += message.generation.usage.completion_tokens ?? 0
    }
  }
  for (const count of childrenByMessage.values()) {
    if (count > 1) branchedParentCount += 1
    maxSiblingCount = Math.max(maxSiblingCount, count)
  }
  return Object.freeze({
    chatCount: backup.payload.chats.length,
    messageCount: backup.payload.messages.length,
    profileCount: backup.payload.profiles.length,
    presetCount: backup.payload.presets.length,
    promptPresetCount: backup.payload.promptPresets.length,
    folderCount: backup.payload.folders.length,
    tagCount: backup.payload.tags.length,
    bodyTextChars,
    assistantCost: roundedCost(assistantCost),
    assistantPromptTokens,
    assistantCompletionTokens,
    branchedParentCount,
    maxSiblingCount,
    activeChatMessageCount: messagesByChat.get(GENERATED_WORKSPACE_ACTIVE_CHAT_ID)?.length ?? 0,
  })
}

export function refreshWorkspaceManifest(backup) {
  assertWorkspaceTemplate(backup)
  const counts = {}
  for (const key of WORKSPACE_TABLE_KEYS) counts[key] = backup.payload[key].length
  let attachmentBlobCount = 0
  let attachmentBlobBytes = 0
  for (const bundle of backup.payload.attachments) {
    attachmentBlobCount += bundle.blobs.length
    for (const blob of bundle.blobs) attachmentBlobBytes += blob.sizeBytes
  }
  backup.payload.manifest = {
    version: 1,
    counts,
    attachmentBlobCount,
    attachmentBlobBytes,
  }
  return backup
}

function generateProfiles(baseProfile, count) {
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(baseProfile),
    id: index === 0 ? baseProfile.id : fixtureId('generated-profile', index, count),
    name: `Generated connection ${String(index + 1).padStart(3, '0')}`,
    requestRevision: index % 7,
    createdAt: FIXTURE_EPOCH - count + index,
    updatedAt: FIXTURE_EPOCH - count + index,
    lastUsedAt: FIXTURE_EPOCH - index,
    archived: index > 0 && index % 31 === 0,
  }))
}

function generatePresets(basePreset, profiles, count) {
  return Array.from({ length: count }, (_, index) => {
    const profile = profiles[index % profiles.length]
    return {
      ...structuredClone(basePreset),
      id: index === 0 ? basePreset.id : fixtureId('generated-preset', index, count),
      name: `Generated settings ${String(index + 1).padStart(4, '0')}`,
      connectionProfileId: profile.id,
      settings: fixtureChatSettings(basePreset.settings, profile.id, index),
      createdAt: FIXTURE_EPOCH - count + index,
      updatedAt: FIXTURE_EPOCH - count + index,
      lastUsedAt: FIXTURE_EPOCH - index,
      archived: index > 0 && index % 47 === 0,
    }
  })
}

function indexPresetsByProfile(presets) {
  const rowsByProfile = new Map()
  for (const preset of presets) {
    const rows = rowsByProfile.get(preset.connectionProfileId)
    if (rows) rows.push(preset)
    else rowsByProfile.set(preset.connectionProfileId, [preset])
  }
  return rowsByProfile
}

function generatePromptPresets(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: fixtureId('generated-prompt-preset', index, count),
    kind: PROMPT_PRESET_KINDS[index % PROMPT_PRESET_KINDS.length],
    name: `Generated prompt ${String(index + 1).padStart(3, '0')}`,
    text: `Deterministic prompt preset ${index + 1}: ${'context '.repeat(index % 9)}`,
    createdAt: FIXTURE_EPOCH - count + index,
    updatedAt: FIXTURE_EPOCH - count + index,
    lastUsedAt: FIXTURE_EPOCH - index,
  }))
}

function generateFolders(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: fixtureId('generated-folder', index, count),
    name: `Generated folder ${String(index + 1).padStart(2, '0')}`,
    color: fixtureColor(index),
    sortIndex: index,
    createdAt: FIXTURE_EPOCH - count + index,
    updatedAt: FIXTURE_EPOCH - count + index,
    lastUsedAt: FIXTURE_EPOCH - index,
  }))
}

function generateTags(count) {
  return Array.from({ length: count }, (_, index) => {
    const name = `Generated tag ${String(index + 1).padStart(3, '0')}`
    return {
      id: fixtureId('generated-tag', index, count),
      name,
      nameLower: name.toLocaleLowerCase(),
      color: fixtureColor(index + 7),
      createdAt: FIXTURE_EPOCH - count + index,
      updatedAt: FIXTURE_EPOCH - count + index,
      lastUsedAt: FIXTURE_EPOCH - index,
    }
  })
}

function generateActiveChat(basePreset, folders, tags) {
  const messages = []
  let parentId = null
  let totalCostUsd = 0
  let wordCount = 0
  for (let index = 0; index < ACTIVE_CHAT_MESSAGE_COUNT; index += 1) {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const id = `generated-active-message-${String(index).padStart(3, '0')}`
    const marker =
      index === ACTIVE_CHAT_MESSAGE_COUNT - 1
        ? GENERATED_WORKSPACE_ACTIVE_TERMINAL_MARKER
        : `generated active history ${index}`
    const text =
      index === ACTIVE_CHAT_MESSAGE_COUNT - 1
        ? `${'terminal '.repeat(18_000)}${marker}`
        : index % 11 === 0
          ? `${marker}\n\n${'long active context line\n'.repeat(320)}`
          : `${marker} ${'short '.repeat(index % 7)}`
    const message = fixtureMessage({
      chatId: GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
      id,
      parentId,
      siblingIndex: 0,
      index,
      depth: index,
      role,
      text,
      model: basePreset.settings.model,
      createdAt: FIXTURE_EPOCH + index,
    })
    messages.push(message)
    parentId = id
    totalCostUsd += message.generation?.cost ?? 0
    wordCount += textWordCount(text)
  }
  return {
    messages,
    chat: fixtureChat({
      id: GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
      index: 0,
      title: 'Generated startup active chat',
      preset: basePreset,
      folderId: folders[0]?.id ?? null,
      tags: tags.slice(0, Math.min(3, tags.length)).map((tag) => tag.id),
      previewText: messages[0].content[0].text.slice(0, 240),
      leafId: GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH + ACTIVE_CHAT_MESSAGE_COUNT - 1,
      wordCount,
      totalCostUsd,
      pinned: true,
    }),
  }
}

function generateRandomChat({ index, random, profile, preset, folders, tags }) {
  const chatId = fixtureId('generated-chat', index, 4_096)
  const messageCount = 4 + random.int(5)
  const messages = []
  const messageById = new Map()
  const depths = new Map()
  const nextSiblingIndex = new Map()
  let activeTip = null
  let totalCostUsd = 0
  let wordCount = 0
  const createdAt = FIXTURE_EPOCH - index * 10_000

  for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
    let parentId = null
    if (messageIndex > 0) {
      const parentChoice = random.next()
      if (parentChoice < 0.7 && activeTip !== null) {
        parentId = activeTip
      } else if (parentChoice < 0.94) {
        const earliest = Math.max(0, messages.length - 10)
        parentId = messages[earliest + random.int(messages.length - earliest)].id
      }
    }
    const parent = parentId === null ? null : messageById.get(parentId)
    const role = parent?.role === 'user' ? 'assistant' : 'user'
    const siblingKey = parentId ?? '__root__'
    const siblingIndex = nextSiblingIndex.get(siblingKey) ?? 0
    nextSiblingIndex.set(siblingKey, siblingIndex + 1)
    const depth = parentId === null ? 0 : (depths.get(parentId) ?? 0) + 1
    const id = `${chatId}-message-${String(messageIndex).padStart(2, '0')}`
    const lengthClass = random.int(101)
    const text =
      lengthClass === 0
        ? `generated long message ${index}:${messageIndex}\n${'large deterministic body '.repeat(
            420,
          )}`
        : lengthClass < 15
          ? `generated medium message ${index}:${messageIndex} ${'medium context '.repeat(48)}`
          : `generated short message ${index}:${messageIndex} ${'x'.repeat(random.int(120))}`
    const message = fixtureMessage({
      chatId,
      id,
      parentId,
      siblingIndex,
      index: messageIndex,
      depth,
      role,
      text,
      model: preset.settings.model,
      createdAt: createdAt + messageIndex,
    })
    messages.push(message)
    messageById.set(id, message)
    depths.set(id, depth)
    activeTip = id
    totalCostUsd += message.generation?.cost ?? 0
    wordCount += textWordCount(text)
  }

  const tagCount = tags.length === 0 ? 0 : random.int(4)
  const selectedTags = []
  for (let tagIndex = 0; tagIndex < tagCount; tagIndex += 1) {
    const id = tags[(index * 3 + tagIndex * 17) % tags.length].id
    if (!selectedTags.includes(id)) selectedTags.push(id)
  }
  const firstUser = messages.find((message) => message.role === 'user')
  return {
    messages,
    chat: fixtureChat({
      id: chatId,
      index,
      title: `Generated chat ${String(index + 1).padStart(4, '0')}`,
      preset: { ...preset, settings: { ...preset.settings, profileId: profile.id } },
      folderId: folders.length === 0 ? null : folders[index % folders.length].id,
      tags: selectedTags,
      previewText: firstUser?.content[0]?.text.slice(0, 240) ?? '',
      leafId: messages.at(-1).id,
      createdAt,
      updatedAt: createdAt + messageCount - 1,
      wordCount,
      totalCostUsd,
      pinned: index % 127 === 0,
      archived: index % 29 === 0,
    }),
  }
}

function fixtureChat({
  id,
  index,
  title,
  preset,
  folderId,
  tags,
  previewText,
  leafId,
  createdAt,
  updatedAt,
  wordCount,
  totalCostUsd,
  pinned,
  archived = false,
}) {
  return {
    id,
    title,
    titleStatus: 'manual',
    createdAt,
    updatedAt,
    lastViewedAt: index === 0 ? FIXTURE_EPOCH + 1_000_000 : updatedAt,
    wordCount,
    totalCostUsd: roundedCost(totalCostUsd),
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings: structuredClone(preset.settings),
    presetId: preset.id,
    lastUpdatedLeafId: leafId,
    lastBranchUpdatedAt: updatedAt,
    archived,
    pinned,
    folderId,
    tags,
    previewText,
  }
}

function fixtureMessage({
  chatId,
  id,
  parentId,
  siblingIndex,
  index,
  depth,
  role,
  text,
  model,
  createdAt,
}) {
  const message = {
    id,
    chatId,
    parentId,
    siblingIndex,
    turnId: `${chatId}-turn-${String(index).padStart(3, '0')}`,
    turnIndex: depth,
    createdAt,
    role,
    origin: role === 'assistant' ? 'generated' : 'user',
    nodeVersion: 0,
    deleted: false,
    content: [{ type: role === 'assistant' ? 'output_text' : 'text', text }],
  }
  if (role !== 'assistant') return message
  const promptTokens = 24 + ((index * 17 + depth * 5) % 2_000)
  const completionTokens = Math.max(1, Math.ceil(text.length / 4))
  const reasoningTokens = (index * 13 + depth) % Math.max(2, completionTokens)
  const cost = roundedCost(promptTokens * 0.000_000_2 + completionTokens * 0.000_000_6)
  return {
    ...message,
    generation: {
      id: `generated-generation-${id}`,
      model,
      requestedModel: model,
      provider: 'Generated Fixture Provider',
      apiUsed: 'chat',
      delivery: 'streaming',
      status: 'done',
      integrity: 'clean',
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
          cached_tokens: Math.floor(promptTokens / 3),
        },
        completion_tokens_details: {
          reasoning_tokens: reasoningTokens,
          accepted_prediction_tokens: Math.floor(completionTokens / 7),
          rejected_prediction_tokens: index % 3,
        },
        cost,
        cost_details: {
          upstream_inference_cost: roundedCost(cost * 0.8),
          upstream_inference_prompt_cost: roundedCost(promptTokens * 0.000_000_15),
          upstream_inference_completions_cost: roundedCost(completionTokens * 0.000_000_45),
        },
      },
      cost,
      costSource: 'stream',
      startedAt: createdAt - 420,
      firstTextAt: createdAt - 360,
      reasoningStartedAt: createdAt - 390,
      reasoningFinishedAt: createdAt - 370,
      finishedAt: createdAt - 1,
      finishReason: 'stop',
    },
  }
}

function fixtureChatSettings(base, profileId, index) {
  const settings = structuredClone(base)
  settings.profileId = profileId
  settings.systemPrompt = `Generated settings system prompt ${index + 1}`
  settings.appendPrompt = index % 5 === 0 ? `Generated append ${index + 1}` : ''
  settings.sampling = {
    ...settings.sampling,
    temperature: Number(((index % 11) / 10).toFixed(1)),
    seed: index,
  }
  settings.metadata = {
    fixture: 'large-workspace-startup',
    settingsIndex: String(index),
  }
  for (const key of [
    'systemPromptPresetId',
    'appendPromptPresetId',
    'continueSystemPromptPresetId',
    'continueUserPromptPresetId',
    'defaultPrefillPresetId',
  ]) {
    delete settings[key]
  }
  return settings
}

function fixtureSettings(rows) {
  const settings = new Map(rows.map((row) => [row.key, structuredClone(row)]))
  settings.set('global:message-initial-render-work', {
    key: 'global:message-initial-render-work',
    value: 10,
  })
  settings.set('global:message-render-window-load-mode', {
    key: 'global:message-render-window-load-mode',
    value: 'manual',
  })
  settings.set('global:sidebar-render-window-size', {
    key: 'global:sidebar-render-window-size',
    value: 50,
  })
  return [...settings.values()]
}

function fixtureId(prefix, index, count) {
  return `${prefix}-${String(index).padStart(String(Math.max(1, count - 1)).length, '0')}`
}

function fixtureColor(index) {
  const hue = (index * 47) % 360
  return `hsl(${hue} 62% 48%)`
}

function textWordCount(value) {
  return value.trim() === '' ? 0 : value.trim().split(/\s+/u).length
}

function roundedCost(value) {
  return Number(value.toFixed(9))
}

function seededRandom(seed) {
  let state = seed >>> 0
  return Object.freeze({
    next() {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) / 0x1_0000_0000
    },
    int(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`GeneratedWorkspaceRandomLimitInvalid:${limit}`)
      }
      return Math.floor(this.next() * limit)
    },
  })
}

function assertWorkspaceTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GeneratedWorkspaceTemplateInvalid')
  }
  if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
    throw new Error('GeneratedWorkspacePayloadInvalid')
  }
  for (const key of WORKSPACE_TABLE_KEYS) {
    if (!Array.isArray(value.payload[key])) {
      throw new Error(`GeneratedWorkspaceTableMissing:${key}`)
    }
  }
  if (value.payload.profiles.length < 1) throw new Error('GeneratedWorkspaceBaseProfileMissing')
  if (value.payload.presets.length < 1) throw new Error('GeneratedWorkspaceBasePresetMissing')
}

function assertScale(scale) {
  for (const key of [
    'seed',
    'chatCount',
    'profileCount',
    'presetCount',
    'promptPresetCount',
    'folderCount',
    'tagCount',
  ]) {
    if (!Number.isSafeInteger(scale[key]) || scale[key] < (key.endsWith('Count') ? 1 : 0)) {
      throw new Error(`GeneratedWorkspaceScaleInvalid:${key}`)
    }
  }
  if (scale.presetCount < scale.profileCount) {
    throw new Error('GeneratedWorkspaceScaleRequiresPresetPerProfile')
  }
}
