const STREAM_JOURNAL_FRAMES_BACKFILL_KEY = 'backfill:stream-journal-frames-v83'

interface V83SettingsMarkerRow {
  readonly key: string
  readonly value: true
}

export function streamJournalFramesBackfillMarker(): V83SettingsMarkerRow {
  return { key: STREAM_JOURNAL_FRAMES_BACKFILL_KEY, value: true }
}
