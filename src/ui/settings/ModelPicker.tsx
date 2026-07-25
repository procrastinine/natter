// Inline model picker inside the Chat Settings → Model tab.
//
// UI:
// - Search input. Typing anything auto-switches to the All list.
// - Tabs: Recent / All (no Featured / Favorites; pinned models are the
//   replacement for Featured, surfaced at the top of every list).
// - Pin row: the pinned models, shown first and reorderable with ↑/↓.
//   Each row has a filled/empty star toggle to pin / unpin.
// - List rows: single-line (id · pricing · context) with the current
//   chat model highlighted. Virtualized via @tanstack/react-virtual so
//   300+ OpenRouter rows stay fluid.
//
// For small, non-OpenRouter connections (local llama.cpp, a single OpenAI
// key pointed at one model) the extra scaffolding is noise. When the live
// list is short the picker collapses to a plain list: no Recent/All
// tabs, no "shift-click pins on preset" footer, no search box. Pin stars
// stay (pins are workspace-wide).

import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../core/global-settings'
import type { Chat, ModelListEntry } from '../../core/types'
import { useConfigurationPreferences } from '../../hooks/useConfigurationPreferences'
import type { UseModelsResult } from '../../hooks/useModelCatalog'
import {
  clearRecentModels,
  movePinnedModel,
  setPinnedModel,
} from '../../store/preferences-application'
import { Button, IconButton } from '../primitives/Button'

// Below this threshold, the picker collapses to a plain list. OpenRouter's ~350
// models and OpenAI direct's ~20 bundled entries stay above it; a local
// llama.cpp with one or two loaded models falls below.
const COMPACT_MODEL_COUNT = 10

type PickerTab = 'recent' | 'all'

interface ModelPickerProps {
  chat: Chat
  modelsResult: UseModelsResult
  onPick: (modelId: string) => void | Promise<void>
  onPickForPreset?: (modelId: string) => void | Promise<void>
}

export function ModelPicker({ chat, modelsResult, onPick, onPickForPreset }: ModelPickerProps) {
  const [tab, setTab] = useState<PickerTab>('recent')
  const [searchRaw, setSearchRaw] = useState('')
  const search = useDeferredValue(searchRaw)

  // Search auto-switches to All — the Recent list is empty for most
  // queries, so sticking on it would hide results and look like a bug.
  const lastSearchRef = useRef('')
  useEffect(() => {
    if (search.trim().length > 0 && lastSearchRef.current !== search) {
      setTab('all')
    }
    lastSearchRef.current = search
  }, [search])

  const { models, loading, retained, error, refresh } = modelsResult
  const currentModel = chat.settings.model
  const compact = models.length > 0 && models.length <= COMPACT_MODEL_COUNT

  // Pinned + recent model ids come from global prefs (workspace-wide).
  // Exact preference deltas publish through the workspace repository so other
  // tabs see them without this tab replacing a concurrently changed array.
  const prefs = useConfigurationPreferences()?.global ?? DEFAULT_GLOBAL_PREFERENCES
  const pinnedModels = prefs.pinnedModels
  const pinnedSet = useMemo(() => new Set(pinnedModels), [pinnedModels])
  const recents = prefs.recentModels

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    const out: ModelListEntry[] = []
    for (const m of models) {
      const hay = `${m.id} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase()
      if (hay.includes(q)) out.push(m)
    }
    return out
  }, [models, search])

  const hasRecentRows = useMemo(() => {
    const ids = new Set(filtered.map((row) => row.id))
    return recents.some((id) => ids.has(id))
  }, [filtered, recents])

  useEffect(() => {
    if (compact) return
    if (search.trim() !== '') return
    if (tab !== 'recent') return
    if (!hasRecentRows) {
      setTab('all')
    }
  }, [compact, search, tab, hasRecentRows])

  const listRows = useMemo(() => {
    const byId = new Map(filtered.map((m) => [m.id, m]))
    const out: ModelListEntry[] = []
    const seen = new Set<string>()
    // Compact mode is just the flat live list; no recents/pins sorting so
    // a local server showing "1 of 1 · ⇧-click pins on preset" stops
    // pretending it's OpenRouter with 350 models to navigate.
    if (compact) {
      for (const m of filtered) {
        if (!seen.has(m.id)) out.push(m)
      }
      return out
    }
    if (tab === 'recent' && search.trim() === '') {
      for (const id of recents) {
        const m = byId.get(id)
        if (m && !seen.has(id)) {
          out.push(m)
          seen.add(id)
        }
      }
      // Append un-used pins after recents so the "featured" selection is
      // still visible on a fresh chat with no recent history.
      for (const id of pinnedModels) {
        const m = byId.get(id)
        if (m && !seen.has(id)) {
          out.push(m)
          seen.add(id)
        }
      }
    } else {
      for (const id of pinnedModels) {
        const m = byId.get(id)
        if (m && !seen.has(id)) {
          out.push(m)
          seen.add(id)
        }
      }
      for (const m of filtered) {
        if (!seen.has(m.id)) out.push(m)
      }
    }
    return out
  }, [compact, filtered, pinnedModels, recents, tab, search])

  const listRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: listRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 48,
    overscan: 8,
  })

  const togglePin = useCallback(
    async (modelId: string) => {
      await setPinnedModel(modelId, !pinnedSet.has(modelId))
    },
    [pinnedSet],
  )

  const movePin = useCallback(async (modelId: string, delta: 1 | -1) => {
    await movePinnedModel(modelId, delta)
  }, [])

  const clearRecentHistory = useCallback(async () => {
    await clearRecentModels()
  }, [])

  const handlePick = useCallback(
    (modelId: string, withShift: boolean) => {
      if (withShift && onPickForPreset) {
        void onPickForPreset(modelId)
      } else {
        void onPick(modelId)
      }
    },
    [onPick, onPickForPreset],
  )

  return (
    <div
      data-ui="model-picker"
      data-compact={compact ? 'true' : undefined}
      data-presentation={retained ? 'retained' : 'current'}
      inert={retained || undefined}
      aria-busy={loading}
    >
      <div data-ui="model-picker-search">
        <input
          data-ui="model-picker-search-input"
          type="search"
          value={searchRaw}
          onChange={(e) => setSearchRaw(e.target.value)}
          placeholder={compact ? 'Filter…' : 'Search models…'}
          aria-label="Search models"
        />
        <IconButton
          type="button"
          data-ui="icon-button"
          onClick={() => refresh()}
          aria-label="Reload models"
          title="Reload models"
          aria-busy={loading}
        >
          <ReloadIcon />
        </IconButton>
      </div>
      {compact ? null : (
        <div data-ui="model-picker-tabs">
          <div data-ui="model-picker-tablist" role="tablist">
            {(['recent', 'all'] as const).map((t) => (
              <Button
                key={t}
                type="button"
                role="tab"
                data-ui="picker-tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
              >
                {t === 'recent' ? 'Recent' : 'All'}
              </Button>
            ))}
          </div>
          {tab === 'recent' && recents.length > 0 ? (
            <Button
              type="button"
              data-ui="picker-tab-action"
              onClick={() => void clearRecentHistory()}
            >
              Clear history
            </Button>
          ) : null}
        </div>
      )}
      <div data-ui="model-picker-list" ref={listRef}>
        {listRows.length === 0 ? (
          <p data-ui="helper" data-tone={error ? 'danger' : undefined}>
            {loading ? 'Loading…' : error ? `Could not load models: ${error}` : 'No matches.'}
          </p>
        ) : (
          <div
            data-ui="model-picker-list-inner"
            ref={(el) => {
              if (!el) return
              el.style.setProperty('--list-total-h', `${rowVirtualizer.getTotalSize()}px`)
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = listRows[virtualRow.index]
              if (!row) return null
              const isPinned = pinnedSet.has(row.id)
              const isCurrent = currentModel === row.id
              return (
                <div
                  key={row.id}
                  data-ui="picker-row"
                  data-current={isCurrent ? 'true' : undefined}
                  data-pinned={isPinned ? 'true' : undefined}
                  ref={(el) => {
                    if (!el) return
                    el.style.setProperty('--row-h', `${virtualRow.size}px`)
                    el.style.setProperty('--row-y', `${virtualRow.start}px`)
                  }}
                >
                  <Button
                    type="button"
                    data-ui="picker-row-pick"
                    onClick={(e) => handlePick(row.id, e.shiftKey)}
                    title={row.name ?? row.id}
                  >
                    <ModelRow row={row} />
                  </Button>
                  {isPinned ? (
                    <div data-ui="picker-row-pin-actions">
                      <IconButton
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        aria-label="Move pin up"
                        title="Move pin up"
                        onClick={() => void movePin(row.id, -1)}
                      >
                        ↑
                      </IconButton>
                      <IconButton
                        type="button"
                        data-ui="icon-button"
                        data-compact
                        aria-label="Move pin down"
                        title="Move pin down"
                        onClick={() => void movePin(row.id, 1)}
                      >
                        ↓
                      </IconButton>
                    </div>
                  ) : null}
                  <IconButton
                    type="button"
                    data-ui="icon-button"
                    data-compact
                    data-pinned={isPinned ? 'true' : undefined}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? 'Unpin model' : 'Pin model'}
                    title={isPinned ? 'Unpin' : 'Pin'}
                    onClick={() => void togglePin(row.id)}
                  >
                    <StarIcon filled={isPinned} />
                  </IconButton>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <footer data-ui="model-picker-footer">
        <span data-ui="helper">
          {compact
            ? `${models.length} model${models.length === 1 ? '' : 's'} detected`
            : `${listRows.length} of ${models.length} · ⇧-click pins on preset`}
        </span>
      </footer>
    </div>
  )
}

function ModelRow({ row }: { row: ModelListEntry }) {
  const pricingLabel = useMemo(() => {
    const pp = Number(row.pricing?.prompt)
    if (!Number.isFinite(pp)) return ''
    return `$${(pp * 1_000_000).toFixed(2)}/M`
  }, [row.pricing?.prompt])
  const ctxLabel = row.contextLength
    ? row.contextLength >= 1_000_000
      ? `${(row.contextLength / 1_000_000).toFixed(1)}M ctx`
      : `${Math.round(row.contextLength / 1000)}k ctx`
    : ''
  // Two lines: line 1 is the full model id (never truncated mid-scroll
  // because the actions sit in a separate flex track outside this child);
  // line 2 is pricing + context. Kept compact because the row height is
  // budgeted at ~44px total.
  return (
    <>
      <span data-ui="picker-row-id" title={row.id}>
        {row.id}
      </span>
      <span data-ui="picker-row-stats">
        {pricingLabel ? <span>{pricingLabel}</span> : null}
        {ctxLabel ? <span>{ctxLabel}</span> : null}
      </span>
    </>
  )
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="14" height="14">
      <path
        d="M8 1.5l2 4.3 4.7.5-3.5 3.2 1 4.6L8 11.7l-4.2 2.4 1-4.6L1.3 6.3l4.7-.5z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ReloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="14" height="14">
      <path
        d="M3 8a5 5 0 0 1 9-3.2M13 8a5 5 0 0 1-9 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M12 2.5V5h-2.5M4 13.5V11h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
