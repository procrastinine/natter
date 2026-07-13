import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from 'react'

export type ButtonTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type ButtonAppearance =
  | 'surface'
  | 'solid'
  | 'soft'
  | 'outline'
  | 'ghost'
  | 'plain'
  | 'strip'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon-xs' | 'icon-sm' | 'icon-md' | 'icon-lg'
export type ButtonGeometry = 'default' | 'flush' | 'joined-start' | 'joined-center' | 'joined-end'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: ButtonTone | undefined
  appearance?: ButtonAppearance | undefined
  size?: ButtonSize | undefined
  geometry?: ButtonGeometry | undefined
  busy?: boolean | undefined
  busyLabel?: ReactNode | undefined
  'data-ui'?: string | undefined
  'data-state'?: string | undefined
  'data-tone'?: ButtonTone | undefined
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    type = 'button',
    tone,
    appearance,
    size,
    geometry,
    busy = false,
    busyLabel,
    disabled = false,
    children,
    'aria-busy': ariaBusy,
    'aria-disabled': ariaDisabled,
    'data-state': dataState,
    'data-tone': legacyTone,
    ...props
  },
  ref,
) {
  const effectiveTone = tone ?? legacyTone ?? 'neutral'
  const unavailable = disabled || busy

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={unavailable}
      aria-busy={busy || ariaBusy || undefined}
      aria-disabled={unavailable ? true : ariaDisabled}
      data-control="button"
      data-button-appearance={appearance}
      data-button-tone={effectiveTone}
      data-button-size={size}
      data-button-geometry={geometry}
      data-state={dataState ?? (unavailable ? 'disabled' : undefined)}
      data-tone={tone ?? legacyTone}
    >
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonProps, 'aria-label' | 'size'> {
  'aria-label': string
  size?: 'xs' | 'sm' | 'md' | 'lg' | undefined
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size, 'data-ui': dataUi = 'icon-button', ...props },
  ref,
) {
  const iconSize = size ? (`icon-${size}` as const) : undefined
  return <Button {...props} ref={ref} data-ui={dataUi} {...(iconSize ? { size: iconSize } : {})} />
})
