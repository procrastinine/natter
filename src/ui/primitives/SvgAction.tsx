import type { KeyboardEvent, ReactNode, SVGProps } from 'react'

interface SvgActionProps
  extends Omit<
    SVGProps<SVGGElement>,
    'aria-disabled' | 'aria-label' | 'children' | 'onClick' | 'onKeyDown' | 'role' | 'tabIndex'
  > {
  label: string
  disabled?: boolean
  children: ReactNode
  onActivate: () => void
}

export function SvgAction({
  label,
  disabled = false,
  children,
  onActivate,
  ...props
}: SvgActionProps) {
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (disabled || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onActivate()
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: SVG has no native button; this wrapper centralizes the complete keyboard contract.
    <g
      {...props}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label}
      onClick={disabled ? undefined : onActivate}
      onKeyDown={handleKeyDown}
    >
      {children}
    </g>
  )
}
