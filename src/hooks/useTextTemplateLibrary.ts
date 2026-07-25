import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { SavedTextTemplate, SavedTextTemplateCatalogRow } from '../core/text-templates'
import type { TextTemplateId } from '../core/types'
import {
  configurationController,
  currentActiveConfigurationSelection,
} from '../store/configuration-controller'

const EMPTY_TEXT_TEMPLATE_LIBRARY: readonly SavedTextTemplateCatalogRow[] = Object.freeze([])

export interface TextTemplateLibrarySelection {
  readonly catalog: readonly SavedTextTemplateCatalogRow[]
  readonly selected: SavedTextTemplate | undefined
}

export function useTextTemplateLibrary(
  templateId: TextTemplateId | null,
): TextTemplateLibrarySelection {
  const snapshot = useSyncExternalStore(
    configurationController.subscribe,
    configurationController.getSnapshot,
    configurationController.getSnapshot,
  )
  useEffect(() => configurationController.demandTextTemplateCatalog(), [])
  return useMemo(() => {
    const catalog = snapshot.frame.textTemplates ?? EMPTY_TEXT_TEMPLATE_LIBRARY
    if (!templateId) return Object.freeze({ catalog, selected: undefined })
    const row = catalog.find((candidate) => candidate.id === templateId)
    const selection = currentActiveConfigurationSelection(snapshot.frame)?.value.textTemplate
    const pending = configurationController.pendingTextTemplateConfig(templateId)
    const config =
      pending?.config ?? (selection?.templateId === templateId ? selection.config : null)
    return Object.freeze({
      catalog,
      selected:
        row && config
          ? Object.freeze({
              ...row,
              config: structuredClone(config),
            })
          : undefined,
    })
  }, [snapshot, templateId])
}
