import { act, render, screen, within } from '@testing-library/react'
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
  const chord = within(screen.getByLabelText('案内しているキー'))
  expect(chord.getByText('Ctrl').tagName).toBe('KBD')
  expect(chord.getByText('C').tagName).toBe('KBD')
  expect(
    screen
      .getByRole('img')
      .querySelector('[data-key="Ctrl"]')
      ?.getAttribute('data-pressed'),
  ).toBe('true')
  expect(
    screen
      .getByRole('img')
      .querySelector('[data-key="C"]')
      ?.getAttribute('data-pressed'),
  ).toBe('true')
  expect(
    screen
      .getByRole('img')
      .querySelector('[data-key="V"]')
      ?.getAttribute('data-pressed'),
  ).toBe('false')
  act(() =>
    receive({
      mode: 'KEYBOARD',
      keys: [],
      buttons: 0,
      x: 0.5,
      y: 0.5,
      expiresAt: Date.now() + 2000,
    }),
  )
  expect(screen.queryByLabelText('家族のキーボード操作')).toBeNull()
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
  expect(screen.getByLabelText('家族のマウス操作').textContent).toContain(
    '左ボタンの操作',
  )
  expect(screen.getByLabelText('家族のカーソル').style.left).toBe('25%')
  act(() =>
    receive({
      mode: 'CURSOR_MOUSE',
      keys: [],
      buttons: 0,
      x: 0.3,
      y: 0.8,
      expiresAt: Date.now() + 2000,
    }),
  )
  expect(screen.queryByLabelText('家族のマウス操作')).toBeNull()
  expect(screen.getByLabelText('家族のカーソル').style.left).toBe('30%')
  act(() => receive(null))
  expect(screen.queryByLabelText('家族のカーソル')).toBeNull()
  expect(screen.queryByLabelText('家族のマウス操作')).toBeNull()
})
