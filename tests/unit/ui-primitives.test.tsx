import { fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode, useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Button, IconButton } from '../../src/ui/primitives/Button'
import { ConfirmDialog } from '../../src/ui/primitives/ConfirmDialog'
import { Dialog } from '../../src/ui/primitives/Dialog'

function FocusDialog({
  onClose,
  closeOnEscape,
  closeOnScrim,
}: {
  onClose: () => void
  closeOnEscape?: boolean
  closeOnScrim?: boolean
}) {
  const preferredFocusRef = useRef<HTMLButtonElement | null>(null)

  return (
    <Dialog
      onClose={onClose}
      overlayUi="test-dialog-overlay"
      scrimUi="test-dialog-scrim"
      surfaceUi="test-dialog"
      ariaLabel="Test dialog"
      scrimLabel="Dismiss test dialog"
      initialFocusRef={preferredFocusRef}
      {...(closeOnEscape === undefined ? {} : { closeOnEscape })}
      {...(closeOnScrim === undefined ? {} : { closeOnScrim })}
    >
      <Button>First</Button>
      <Button ref={preferredFocusRef}>Preferred</Button>
      <Button>Last</Button>
    </Dialog>
  )
}

function MissingIconButtonNameContract() {
  // @ts-expect-error IconButton requires an accessible name.
  return <IconButton>×</IconButton>
}
void MissingIconButtonNameContract

describe('Button', () => {
  it('defaults to a non-submitting button and preserves the caller data-ui hook', () => {
    render(<Button data-ui="existing-action">Save</Button>)

    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveAttribute('data-control', 'button')
    expect(button).toHaveAttribute('data-ui', 'existing-action')
  })

  it('emits visual appearance, size, and geometry attributes only when explicit', () => {
    render(
      <>
        <Button>Default</Button>
        <Button tone="success" appearance="soft" size="sm" geometry="flush">
          Explicit
        </Button>
      </>,
    )

    const defaultButton = screen.getByRole('button', { name: 'Default' })
    expect(defaultButton).not.toHaveAttribute('data-button-appearance')
    expect(defaultButton).not.toHaveAttribute('data-button-size')
    expect(defaultButton).not.toHaveAttribute('data-button-geometry')

    const explicitButton = screen.getByRole('button', { name: 'Explicit' })
    expect(explicitButton).toHaveAttribute('data-button-tone', 'success')
    expect(explicitButton).toHaveAttribute('data-tone', 'success')
    expect(explicitButton).toHaveAttribute('data-button-appearance', 'soft')
    expect(explicitButton).toHaveAttribute('data-button-size', 'sm')
    expect(explicitButton).toHaveAttribute('data-button-geometry', 'flush')
  })

  it('uses the busy label only while busy and exposes busy as disabled', () => {
    render(
      <>
        <Button busy busyLabel="Saving…">
          Save
        </Button>
        <Button disabled busyLabel="Deleting…">
          Delete
        </Button>
        <Button busy>Keep original label</Button>
      </>,
    )

    const busy = screen.getByRole('button', { name: 'Saving…' })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveAttribute('data-state', 'disabled')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()

    const disabled = screen.getByRole('button', { name: 'Delete' })
    expect(disabled).toBeDisabled()
    expect(disabled).not.toHaveAttribute('aria-busy')
    expect(screen.queryByRole('button', { name: 'Deleting…' })).toBeNull()

    expect(screen.getByRole('button', { name: 'Keep original label' })).toBeDisabled()
  })
})

describe('IconButton', () => {
  it('outputs the required accessible name and preserves an explicit data-ui hook', () => {
    render(
      <IconButton aria-label="Open settings" data-ui="settings-action" size="sm">
        <span aria-hidden="true">⚙</span>
      </IconButton>,
    )

    const button = screen.getByRole('button', { name: 'Open settings' })
    expect(button).toHaveAttribute('aria-label', 'Open settings')
    expect(button).toHaveAttribute('data-ui', 'settings-action')
    expect(button).toHaveAttribute('data-button-size', 'icon-sm')
  })

  it('uses the shared icon-button hook without forcing a visual size', () => {
    render(<IconButton aria-label="Close">×</IconButton>)

    const button = screen.getByRole('button', { name: 'Close' })
    expect(button).toHaveAttribute('data-ui', 'icon-button')
    expect(button).not.toHaveAttribute('data-button-size')
  })
})

describe('Dialog', () => {
  it('portals the overlay to the document body so contained feature surfaces cannot clip it', () => {
    const view = render(<FocusDialog onClose={() => {}} />)

    expect(view.container).toBeEmptyDOMElement()
    expect(document.body.querySelector('[data-control="dialog-overlay"]')).toBeInTheDocument()
  })

  it('focuses the requested control, wraps Tab in both directions, and restores focus', () => {
    const launcher = document.createElement('button')
    launcher.textContent = 'Launcher'
    document.body.append(launcher)
    launcher.focus()

    const view = render(<FocusDialog onClose={() => {}} />)
    const first = screen.getByRole('button', { name: 'First' })
    const preferred = screen.getByRole('button', { name: 'Preferred' })
    const last = screen.getByRole('button', { name: 'Last' })

    expect(preferred).toHaveFocus()

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(first).toHaveFocus()

    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()

    view.unmount()
    expect(launcher).toHaveFocus()
    launcher.remove()
  })

  it('closes on Escape unless the policy disables it', () => {
    const onClose = vi.fn()
    const view = render(<FocusDialog onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    view.rerender(<FocusDialog onClose={onClose} closeOnEscape={false} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes from the scrim only when the policy allows it', () => {
    const onClose = vi.fn()
    const view = render(<FocusDialog onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss test dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    view.rerender(<FocusDialog onClose={onClose} closeOnScrim={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss test dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('ConfirmDialog', () => {
  it('maps confirmation semantics to a danger solid flush action', () => {
    render(
      <ConfirmDialog
        title="Delete chat?"
        confirmLabel="Delete"
        onCancel={() => {}}
        onConfirm={() => {}}
      >
        <DialogCopy />
      </ConfirmDialog>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Delete chat?' })
    expect(dialog).toBeInTheDocument()

    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(confirm).toHaveAttribute('data-role', 'confirm')
    expect(confirm).toHaveAttribute('data-button-tone', 'danger')
    expect(confirm).toHaveAttribute('data-button-appearance', 'solid')
    expect(confirm).toHaveAttribute('data-button-geometry', 'flush')

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toHaveAttribute('data-role', 'cancel')
    expect(cancel).toHaveAttribute('data-button-appearance', 'plain')
    expect(cancel).toHaveAttribute('data-button-geometry', 'flush')
  })
})

function DialogCopy(): ReactNode {
  return <p>Deleting cannot be undone.</p>
}
