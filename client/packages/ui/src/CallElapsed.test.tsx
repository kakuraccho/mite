import { act, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CallElapsed } from './CallElapsed'

it('derives elapsed time from the original call start across rendering and restoration', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-09T00:10:03Z'))
  try {
    const { rerender, unmount } = render(
      <CallElapsed startedAt="2026-09-09T00:00:00Z" />,
    )
    expect(screen.getByText(/10:03/)).toBeTruthy()
    act(() => vi.advanceTimersByTime(2000))
    rerender(<CallElapsed startedAt="2026-09-09T00:00:00Z" />)
    expect(screen.getByText(/10:05/)).toBeTruthy()
    unmount()
    render(<CallElapsed startedAt="2026-09-09T00:00:00Z" />)
    expect(screen.getByText(/10:05/)).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})
