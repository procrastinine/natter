function command(owners, status = 'reachable', gap = undefined) {
  return Object.freeze({
    owners: Object.freeze([...owners]),
    status,
    ...(gap ? { gap } : {}),
  })
}

export const CONFIGURATION_COMMANDS = Object.freeze({
  'chat-preset.apply': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.applyChatPreset',
  ]),
  'chat-preset.create': command(
    [],
    'gap',
    'Declared and handled, but no production ingress constructs the standalone create operation.',
  ),
  'chat-preset.create-and-link': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.createAndLinkChatPreset',
  ]),
  'chat-preset.delete': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.deleteChatPreset',
  ]),
  'chat-preset.duplicate': command(
    [],
    'gap',
    'Declared and handled preset duplication has no production constructor despite the product duplication requirement.',
  ),
  'chat-preset.move': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.moveChatPreset',
  ]),
  'chat-preset.save': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.saveChatPreset',
  ]),
  'chat-preset.set-archived': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.archiveChatPreset',
    'src/store/configuration-domain.ts#createConfigurationApplication.unarchiveChatPreset',
  ]),
  'chat-preset.touch': command(
    [],
    'gap',
    'Declared and handled preset recency mutation has no production constructor or proven replacement.',
  ),
  'chat-preset.update': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.renameChatPreset',
  ]),
  'chat.resolve-model': command(
    [],
    'gap',
    'The pending profile-switch resolution command is declared and handled but never constructed in production.',
  ),
  'chat.settings-fields-patch': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.patchChatSettingsFields',
  ]),
  'chat.settings-patch': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.patchChatSettings',
  ]),
  'chat.settings-replace': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.replaceChatSettings',
  ]),
  'chat.switch-profile': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.switchChatProfile',
  ]),
  'connection.create': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.createConnection',
  ]),
  'connection.delete': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.deleteConnection',
  ]),
  'connection.duplicate': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.duplicateConnection',
  ]),
  'connection.edit': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.archiveConnection',
    'src/store/configuration-domain.ts#createConfigurationApplication.editConnection',
    'src/store/configuration-domain.ts#createConfigurationApplication.unarchiveConnection',
  ]),
  'connection.touch': command(['src/ui/header/ConnectionHeader.tsx#ConnectionHeader']),
  'global-preference.delete': command(
    [],
    'gap',
    'The generic delete operation is handled but no production preference surface constructs it.',
  ),
  'global-preference.set': command(['src/store/global-settings.ts#writeGlobalPreference']),
  'image-allowlist.add': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.addImageOrigin',
  ]),
  'image-allowlist.remove': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.removeImageOrigin',
  ]),
  'install-secret.ensure': command(['src/store/keys.ts#getOrCreateInstallSecret.initialize']),
  'key.delete': command(['src/store/keys.ts#deleteKey.remove']),
  'key.material-replace': command(['src/store/keys.ts#changePassphrase.change']),
  'key.put': command(['src/store/keys.ts#createKey.create']),
  'key.touch': command(['src/store/keys.ts#touchLastUsedAt']),
  'pinned-model.clear': command(
    [],
    'gap',
    'The bulk clear operation is declared and handled but has no production ingress.',
  ),
  'pinned-model.move': command(['src/store/global-settings.ts#movePinnedModel']),
  'pinned-model.set-membership': command(['src/store/global-settings.ts#setPinnedModel']),
  'prompt-preset.create-and-pin': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.createAndPinPromptPreset',
  ]),
  'prompt-preset.delete': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.deletePromptPreset',
  ]),
  'prompt-preset.load-and-pin': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.loadPromptPreset',
  ]),
  'prompt-preset.local-commit': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.commitPromptText',
  ]),
  'prompt-preset.overwrite-and-pin': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.overwriteAndPinPromptPreset',
  ]),
  'prompt-preset.put': command(
    [],
    'gap',
    'The generic prompt-preset put operation is declared and handled but has no production constructor.',
  ),
  'prompt-preset.rename': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.renamePromptPreset',
  ]),
  'prompt-preset.touch': command(
    [],
    'gap',
    'The prompt-preset recency operation is declared and handled but has no production constructor.',
  ),
  'prompt-preset.update': command(
    [],
    'gap',
    'The generic prompt-preset patch is declared and handled but no production surface constructs it.',
  ),
  'recent-model.bump': command(
    [],
    'gap',
    'Recent-model insertion is declared and handled but no production event constructs it.',
  ),
  'recent-model.clear': command(['src/store/global-settings.ts#clearRecentModels']),
  'rendering-preferences.patch': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.patchRenderingPreferences',
  ]),
  'sample-prompts.set-dismissed': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.setSamplePromptsDismissed',
  ]),
  'sidebar-preference.set-folder-collapsed': command([
    'src/store/sidebar-preferences.ts#setSidebarFolderCollapsed',
  ]),
  'sidebar-preference.set-sort': command(['src/store/sidebar-preferences.ts#writeSidebarSortMode']),
  'text-template.create': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.createTextTemplate',
  ]),
  'text-template.create-and-select': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.createAndSelectTextTemplate',
  ]),
  'text-template.delete': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.deleteTextTemplate',
  ]),
  'text-template.update': command([
    'src/store/configuration-domain.ts#createConfigurationApplication.updateTextTemplate',
  ]),
})

export const CONFIGURATION_OPTIMISTIC_STAGE_VARIANTS = Object.freeze([
  'chat.settings-fields-patch',
  'chat.settings-patch',
  'chat.settings-replace',
  'chat.switch-profile',
  'global-preference.set',
  'prompt-preset.local-commit',
  'rendering-preferences.patch',
  'sidebar-preference.set-folder-collapsed',
  'sidebar-preference.set-sort',
  'text-template.create-and-select',
  'text-template.update',
])
