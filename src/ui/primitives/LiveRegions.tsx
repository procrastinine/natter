import { useEffect, useState } from 'react'
import type { Announcement, AnnouncementPriority } from '../../store/presentation-contracts'
import { useAnnouncementStore } from '../../store/zustand/announcementStore'

const ANNOUNCEMENT_DWELL_MS = 1_000

function LiveRegionLane({
  priority,
  announcement,
}: {
  priority: AnnouncementPriority
  announcement: Announcement | undefined
}) {
  const consume = useAnnouncementStore((state) => state.consume)
  const [spokenText, setSpokenText] = useState('')

  useEffect(() => {
    setSpokenText('')
    if (!announcement) return
    let disposed = false
    let consumeTimer: number | null = null
    const revealFrame = window.requestAnimationFrame(() => {
      if (disposed) return
      setSpokenText(announcement.text)
      consumeTimer = window.setTimeout(
        () => consume(priority, announcement.id),
        ANNOUNCEMENT_DWELL_MS,
      )
    })
    return () => {
      disposed = true
      window.cancelAnimationFrame(revealFrame)
      if (consumeTimer !== null) window.clearTimeout(consumeTimer)
    }
  }, [announcement, consume, priority])

  return (
    <div
      data-ui="visually-hidden"
      data-role="live-region"
      data-priority={priority}
      role={priority === 'assertive' ? 'alert' : 'status'}
      aria-live={priority}
      aria-atomic="true"
    >
      {spokenText}
    </div>
  )
}

export function LiveRegions() {
  const polite = useAnnouncementStore((state) => state.polite[0])
  const assertive = useAnnouncementStore((state) => state.assertive[0])
  return (
    <>
      <LiveRegionLane priority="polite" announcement={polite} />
      <LiveRegionLane priority="assertive" announcement={assertive} />
    </>
  )
}
