import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { Modal } from './Modal'

it('focuses the dialog, wraps tab navigation, closes with Escape, and restores focus', () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const onClose = vi.fn()
  const { unmount } = render(
    <Modal title="確認" onClose={onClose} actions={<button>進む</button>}>
      <input aria-label="説明" />
    </Modal>,
  )
  const dialog = screen.getByRole('dialog', { name: '確認' })
  expect(document.activeElement).toBe(dialog)
  fireEvent.keyDown(dialog, { key: 'Tab' })
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: '閉じる' }),
  )
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: '進む' }),
  )
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: '閉じる' }),
  )
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
  unmount()
  expect(document.activeElement).toBe(trigger)
  trigger.remove()
})
