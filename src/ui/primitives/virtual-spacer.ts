import { type RefObject, useLayoutEffect, useRef } from 'react'

export const VIRTUAL_SPACER_HEIGHT_PROPERTY = '--virtual-spacer-height'

export function useVirtualSpacerHeight<Element extends HTMLElement>(
  height: number,
): RefObject<Element | null> {
  const ref = useRef<Element>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const boundedHeight = Number.isFinite(height) ? Math.max(0, height) : 0
    element.style.setProperty(VIRTUAL_SPACER_HEIGHT_PROPERTY, `${boundedHeight}px`)
  }, [height])
  return ref
}
