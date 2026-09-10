import { describe, expect, it } from 'vitest'
import {
  calculateOverlayBounds,
  detailOverlayWidth,
  overlayCollapsedWidth,
} from './overlay'

const reserved = { x: 0, y: 40, width: 4, height: 1_040 }

describe('user overlay geometry', () => {
  it('reserves and displays only four pixels while collapsed', () => {
    expect(calculateOverlayBounds(reserved, 1_920, 'COLLAPSED')).toEqual({
      ...reserved,
      width: overlayCollapsedWidth,
    })
  })

  it('opens the entry panel without changing the reserved rectangle', () => {
    expect(calculateOverlayBounds(reserved, 1_920, 'ENTRY')).toEqual({
      ...reserved,
      width: 320,
    })
    expect(reserved.width).toBe(4)
  })

  it('uses an adaptive detail width within the primary display', () => {
    expect(detailOverlayWidth(1_920)).toBe(1_040)
    expect(detailOverlayWidth(1_366)).toBe(847)
    expect(detailOverlayWidth(640)).toBe(640)
  })
})

it('fits floating guides into small primary work areas, including negative monitor coordinates', async () => {
  const { calculateGuideBounds } = await import('./overlay')
  expect(
    calculateGuideBounds(
      { x: -500, y: -200, width: 500, height: 400 },
      { x: 2000, y: 2000, width: 560, height: 720 },
    ),
  ).toEqual({ x: -500, y: -200, width: 500, height: 400 })
})
