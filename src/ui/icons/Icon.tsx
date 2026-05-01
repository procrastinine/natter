import type { ReactNode, SVGProps } from 'react'

// Single SVG-based icon library (Lucide-style: 24×24 viewBox, stroke 1.6,
// rounded line caps/joins, currentColor everywhere). The whole point is to
// kill the font-glyph icons (✎, ▸, ▾, ⚙︎, ✕, etc.) that the user kept
// catching for vertical-alignment jitter. Memory: feedback_icon_alignment.
//
// All icons accept the same `IconProps` so the consumer can size them
// consistently (default 18 px). Buttons that wrap an Icon should use
// `display: inline-flex; align-items: center; justify-content: center;
// line-height: 1` so the SVG is centered without baseline drift.

interface IconProps {
  size?: number
  className?: string
  strokeWidth?: number
  // Allow rotation (used by ChevronIcon to swap between collapsed and
  // expanded states by rotating ONE glyph instead of swapping `▸`/`▾` font
  // characters that have different vertical metrics).
  rotate?: 0 | 90 | 180 | 270
  ariaLabel?: string
}

interface BaseSvgProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  size?: number
  rotate?: 0 | 90 | 180 | 270
  children: ReactNode
}

function BaseSvg({ size = 18, rotate = 0, children, ...rest }: BaseSvgProps) {
  // Only emit `data-icon-rotate` when an icon actually rotates. Icons
  // without rotation skip the transition rule entirely (see icons.css)
  // so the browser doesn't track them as composited animation targets
  // — that's a real perf win on hover-heavy surfaces.
  const rotateAttr = rotate === 0 ? {} : { 'data-icon-rotate': rotate }
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-icon=""
      aria-hidden="true"
      {...rotateAttr}
      {...rest}
    >
      {children}
    </svg>
  )
}

// Single chevron-right glyph, rotated to express direction. 0 = right
// (collapsed), 90 = down (expanded). This avoids the `▸`/`▾` baseline
// jitter the user flagged.
//
// `data-icon="chevron"` opts the chevron into the rotation transition
// (icons.css). Other icons skip the transition rule entirely so the
// browser doesn't track them for compositor work on every paint.
export function ChevronIcon({ size = 18, rotate = 0, ariaLabel }: IconProps) {
  return (
    <BaseSvg
      size={size}
      rotate={rotate}
      data-icon="chevron"
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
    >
      <polyline points="9 6 15 12 9 18" />
    </BaseSvg>
  )
}

// Pencil — strictly the writing implement (no paper). Drawn as a single
// continuous outline (tip → body → ferrule → eraser) with one bisecting
// line for the ferrule band, so the parts join cleanly with no gap.
// Lucide `pencil` is the reference.
export function PencilIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M4 20l1-4L17 4a2.121 2.121 0 0 1 3 3L8 19l-4 1z" />
      <path d="m14 7 3 3" />
    </BaseSvg>
  )
}

// Pencil-on-paper (Lucide square-pen). Used for the new-chat affordance.
export function NewChatIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L13 13l-4 1 1-4z" />
    </BaseSvg>
  )
}

// Trash can — used for chat-row delete (replaces the previous `×`).
export function TrashIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </BaseSvg>
  )
}

// Two same-size pages stacked. The back page is drawn as an L-shape so it
// doesn't intersect with the front page (no link-icon look) and has no
// opaque fill (stroke-only, so any background shows through). All three
// outer corners of the L are rounded with the same rx as the front page.
export function CopyIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      {/* Back page — L tracing the top, right (partial), left, and bottom
       * (partial) edges, with three outer corners rounded (top-left,
       * top-right, bottom-left). The two inner endpoints (at the front
       * page's top-left corner) terminate as open stubs. */}
      <path d="M15.5 8.5 V5 A1.5 1.5 0 0 0 14 3.5 H5 A1.5 1.5 0 0 0 3.5 5 V14 A1.5 1.5 0 0 0 5 15.5 H8.5" />
      {/* Front page — full rounded rectangle, stroke-only (transparent
       * interior — no white fill so the surface beneath shows through). */}
      <rect x="8.5" y="8.5" width="12" height="12" rx="1.5" fill="none" />
    </BaseSvg>
  )
}

// Reload / regenerate (single semicircular arrow with a chevron tip).
export function ReloadIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <polyline points="3 21 3 16 8 16" />
    </BaseSvg>
  )
}

// `i` inside a circle. Outline-only outer circle (no opaque fill) so any
// background shows through. The tittle (dot above the `i`) is a small
// filled circle — the fill applies only to that tiny dot, not to the
// surrounding body circle, so the main interior stays transparent.
// Slightly thicker stroke so the circle reads cleanly at small sizes.
export function InfoIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} strokeWidth={1.8} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <circle cx="12" cy="12" r="9" fill="none" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <circle cx="12" cy="8" r="0.7" fill="currentColor" stroke="none" />
    </BaseSvg>
  )
}

// Down-arrow into a tray — chat-export-as-txt convention.
export function DownloadIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M12 3v12" />
      <polyline points="7 10 12 15 17 10" />
      <path d="M5 21h14" />
    </BaseSvg>
  )
}

// Filled cog. Uses the canonical Material-Design "settings" path — eight
// teeth + a central disc with a hollow inner circle (the empty hole is
// what makes the eye read it as a gear at any size). Default 20 px.
export function CogIcon({ size = 20, ariaLabel }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      stroke="none"
      focusable="false"
      data-icon=""
      aria-hidden="true"
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
    >
      <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z" />
    </svg>
  )
}

// Close (X). Square hit area enforced by the wrapping button.
export function CloseIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </BaseSvg>
  )
}

// Stop — a filled rounded square (media-player convention). Used in the
// Composer's Send-button slot while a stream is in flight; clicking it
// aborts the stream.
export function StopIcon({ size = 16, ariaLabel }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      stroke="none"
      focusable="false"
      data-icon=""
      aria-hidden="true"
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
    >
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  )
}

// Generic person silhouette — default user profile glyph. Filled.
export function PersonIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} strokeWidth={1.5} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M4.6 20a8 8 0 0 1 14.8 0" />
    </BaseSvg>
  )
}

// Branch / fork — three dots connected by a Y-shaped path. Used on the
// per-message "Branch this chat from here" action; there is NO per-
// message in-tree branch action in Phase 8.1 (forking creates a new
// chat, which is the user's mental model for "branch").
export function BranchIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8" />
      <path d="M6 13c0-2 2-4 4-4h4" />
    </BaseSvg>
  )
}

// Eye — open eye used for the focus-mode toggle.
export function EyeIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </BaseSvg>
  )
}

// Eye-off — the open-eye with a slash, used when focus mode is ON so
// the toggle reads as "turn off focus mode."
export function EyeOffIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a3 3 0 0 0 3.8 3.8" />
      <path d="M9.9 5.3A10 10 0 0 1 22 12a15 15 0 0 1-2.2 3" />
      <path d="M6.1 6.1A15 15 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.5-1.1" />
    </BaseSvg>
  )
}

// Edit-tree — four connected nodes (parent + 3 children) for the
// "Edit tree mode" toggle in the chat header. Distinct from the pencil
// used by title-edit + per-message edit so the two modes don't blur.
export function EditTreeIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="5" cy="18" r="1.8" />
      <circle cx="12" cy="18" r="1.8" />
      <circle cx="19" cy="18" r="1.8" />
      <path d="M12 7v3" />
      <path d="M12 10H5v6" />
      <path d="M12 10v6" />
      <path d="M12 10h7v6" />
    </BaseSvg>
  )
}

// Prefill — quote-mark glyph with a small assistant-text caret. Surfaces
// the "compose an assistant prefix the model continues from" affordance
// in the composer and inline editor.
export function PrefillIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M5 6h7M5 10h11M5 14h9" />
      <path d="M16.5 13l3 3-3 3" />
    </BaseSvg>
  )
}

// Insert marker — a small + with a divider, used for insert-before /
// insert-after in Edit tree mode.
export function InsertIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </BaseSvg>
  )
}

export function PaperclipIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M21.4 11.6 12 21a6 6 0 0 1-8.5-8.5l9.8-9.8a4 4 0 0 1 5.7 5.7l-9.8 9.8a2 2 0 1 1-2.8-2.8l9.4-9.4" />
    </BaseSvg>
  )
}

export function MessageSquareIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </BaseSvg>
  )
}

export function DatabaseIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
      <path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </BaseSvg>
  )
}

export function FileIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </BaseSvg>
  )
}

export function UploadIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M12 21V9" />
      <polyline points="7 14 12 9 17 14" />
      <path d="M5 5h14" />
    </BaseSvg>
  )
}

export function SearchIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </BaseSvg>
  )
}

export function PlusIcon({ size = 18, strokeWidth = 1.6, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} strokeWidth={strokeWidth} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </BaseSvg>
  )
}

export function FolderIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h4l2 2.5h6A2.5 2.5 0 0 1 20.5 9v8A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z" />
      <path d="M3.5 9h17" />
    </BaseSvg>
  )
}

export function TagIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M20 13.5 13.5 20 4 10.5V4h6.5z" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </BaseSvg>
  )
}

export function ArchiveIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <rect x="4" y="4" width="16" height="4" rx="1" />
      <path d="M5.5 8v10A2 2 0 0 0 7.5 20h9a2 2 0 0 0 2-2V8" />
      <path d="M9 12h6" />
    </BaseSvg>
  )
}

export function UnarchiveIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M4 4h16v4H4z" />
      <path d="M5.5 8v10A2 2 0 0 0 7.5 20h9a2 2 0 0 0 2-2V8" />
      <path d="M12 17v-6" />
      <path d="m8.8 14.2 3.2-3.2 3.2 3.2" />
    </BaseSvg>
  )
}

export function SortIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <path d="M7 4v16" />
      <polyline points="4 7 7 4 10 7" />
      <path d="M17 20V4" />
      <polyline points="14 17 17 20 20 17" />
    </BaseSvg>
  )
}

export function MoreVerticalIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none" />
    </BaseSvg>
  )
}

// Paper-plane arrow — Save & Send action on the inline editor.
export function SendIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <polygon points="3 20 20 12 3 4 7 12" fill="currentColor" stroke="none" />
    </BaseSvg>
  )
}

// Padlock — privacy surface. Closed/open variant picks the visual. See
// `plan/09-privacy.md §9.11`.
export function LockIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <rect x="5.5" y="10.5" width="13" height="10" rx="1.8" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </BaseSvg>
  )
}

export function LockOpenIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <rect x="5.5" y="10.5" width="13" height="10" rx="1.8" />
      <path d="M8 10.5V7.5a4 4 0 0 1 7.8-1" />
    </BaseSvg>
  )
}

// Generic robot silhouette — default assistant profile glyph.
export function RobotIcon({ size = 18, ariaLabel }: IconProps) {
  return (
    <BaseSvg size={size} strokeWidth={1.5} {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}>
      <rect x="5" y="8" width="14" height="11" rx="2.4" />
      <path d="M12 8V5" />
      <circle cx="12" cy="3.6" r="1" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none" />
      <line x1="9.5" y1="17" x2="14.5" y2="17" />
      <line x1="3" y1="13" x2="5" y2="13" />
      <line x1="19" y1="13" x2="21" y2="13" />
    </BaseSvg>
  )
}
