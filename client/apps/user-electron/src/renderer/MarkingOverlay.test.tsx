import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MarkingOverlay } from './MarkingOverlay'
import type { DesktopMark } from '../shared/marking-overlay'

it('draws marks in normalized desktop coordinates and removes them on clear', () => {
  let receive!: (marks: DesktopMark[]) => void
  const unsubscribe = vi.fn()
  const bridge = {
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
