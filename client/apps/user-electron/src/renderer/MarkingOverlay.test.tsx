import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MarkingOverlay } from './MarkingOverlay'
import type { DesktopMark, DesktopGuidance } from '../shared/marking-overlay'

it('draws marks in normalized desktop coordinates and removes them on clear', () => {
  let receive!: (marks: DesktopMark[]) => void
  const unsubscribe = vi.fn()
  const bridge = {
    onGuidanceChanged: vi.fn(() => () => {}),
    onMarksChanged: (listener: typeof receive) => {
      receive = listener
      return unsubscribe
    },
  }
  const { unmount } = render(<MarkingOverlay bridge={bridge} />)
  act(() =>
    receive([
      { id: 'mark_01', x: 0.42, y: 0.31, expiresAt: Date.now() + 2000 },
    ]),
  )
  const mark = screen.getByLabelText('家族が示している場所')
  expect(mark.style.left).toBe('42%')
  expect(mark.style.top).toBe('31%')
  act(() => receive([]))
  expect(screen.queryByLabelText('家族が示している場所')).toBeNull()
  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})

it('renders simultaneous keys and pressed mouse buttons in the independent desktop overlay', () => {
  let receive!: (guidance: DesktopGuidance | null) => void
  const bridge = {
    onMarksChanged: vi.fn(() => () => {}),
    onGuidanceChanged: (listener: typeof receive) => {
      receive = listener
      return () => {}
    },
  }
  render(<MarkingOverlay bridge={bridge} />)
  act(() =>
    receive({
      mode: 'KEYBOARD',
      keys: ['Ctrl', 'C'],
      buttons: 0,
      x: 0.5,
      y: 0.5,
      expiresAt: Date.now() + 2000,
    }),
  )
  expect(screen.getByText('Ctrl').tagName).toBe('KBD')
  expect(screen.getByText('C').tagName).toBe('KBD')
  act(() =>
    receive({
      mode: 'CURSOR_MOUSE',
      keys: [],
      buttons: 1,
      x: 0.25,
      y: 0.75,
      expiresAt: Date.now() + 2000,
    }),
  )
  expect(screen.queryByText('Ctrl')).toBeNull()
  expect(screen.getByText('左ボタンを押しています')).toBeTruthy()
  expect(screen.getByLabelText('家族のカーソル').style.left).toBe('25%')
  act(() => receive(null))
  expect(screen.queryByLabelText('家族のカーソル')).toBeNull()
  expect(screen.queryByText('左ボタンを押しています')).toBeNull()
})
