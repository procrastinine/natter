import type { ProfilePictureRef } from '../../core/global-settings'
import type { Message } from '../../core/types'
import { PersonIcon, RobotIcon } from '../icons/Icon'

export interface ProfileGlyphProps {
  role: Message['role']
  // Override the default picture for the user / assistant glyphs (consumed
  // from global preferences). System / tool / developer fall back to the
  // generic person silhouette since they don't have a meaningful default.
  userPicture?: ProfilePictureRef
  assistantPicture?: ProfilePictureRef
  // When true, the message will be trimmed out of the request by the
  // current context-truncation settings. Surface a dashed ring so the
  // user can see which turns aren't reaching the model.
  excluded?: boolean
  decorative?: boolean
}

const ROLE_LABEL: Record<Message['role'], string> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'System',
  developer: 'Developer',
  tool: 'Tool',
}

function pictureForRole(
  role: Message['role'],
  userPicture: ProfilePictureRef,
  assistantPicture: ProfilePictureRef,
): ProfilePictureRef {
  if (role === 'user') return userPicture
  if (role === 'assistant') return assistantPicture
  return 'default-person'
}

// Circular gutter glyph for each turn — generic SVG silhouette by default
// (person for user, robot for assistant). Per-role color is intentionally
// avoided in the reading area; the silhouette + role label carry the
// identification.
export function ProfileGlyph({
  role,
  userPicture = 'default-person',
  assistantPicture = 'default-robot',
  excluded,
  decorative = false,
}: ProfileGlyphProps) {
  const picture = pictureForRole(role, userPicture, assistantPicture)
  const ariaLabel = excluded ? `${ROLE_LABEL[role]} (excluded from context)` : ROLE_LABEL[role]
  return (
    <span
      data-ui="profile-glyph"
      data-role={role}
      data-picture={picture}
      data-excluded={excluded ? 'true' : undefined}
      {...(decorative
        ? { 'aria-hidden': true as const }
        : {
            'aria-label': ariaLabel,
            title: excluded ? 'Trimmed out of the request by context settings' : undefined,
            role: 'img' as const,
          })}
    >
      {picture === 'default-robot' ? <RobotIcon size={20} /> : <PersonIcon size={20} />}
    </span>
  )
}
