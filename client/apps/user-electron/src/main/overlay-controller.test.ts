import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Display } from 'electron'
import type { AppBarAdapter } from './appbar'
import { UserOverlayController } from './overlay-controller'

const display = {
  bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
  workArea: { x: 0, y: 0, width: 1_920, height: 1_040 },
} as Display

const makeWindow = () => ({ setBounds: vi.fn() }) as unknown as BrowserWindow

describe('UserOverlayController', () => {
  it('simulates the overlay without reserving Linux work area', () => {
    const window = makeWindow()
    const appBar: AppBarAdapter = {
      supported: false,
      reserve: vi.fn(),
      release: vi.fn(),
    }
    const controller = new UserOverlayController(window, () => display, appBar)

    expect(controller.initialize()).toMatchObject({
      mode: 'COLLAPSED',
      reservation: 'SIMULATED',
      bounds: { x: 0, y: 0, width: 4, height: 1_040 },
    })
    expect(appBar.reserve).not.toHaveBeenCalled()

    expect(controller.setMode('ENTRY').bounds.width).toBe(320)
    expect(controller.setMode('DETAIL').bounds.width).toBe(1_040)
  })

  it('keeps the Windows reservation at four pixels while expanding', () => {
    const window = makeWindow()
    const reserved = { x: 0, y: 0, width: 4, height: 1_040 }
    const appBar: AppBarAdapter = {
      supported: true,
      reserve: vi.fn(() => reserved),
      release: vi.fn(),
    }
    const controller = new UserOverlayController(window, () => display, appBar)

    controller.initialize()
    const detail = controller.setMode('DETAIL')

    expect(appBar.reserve).toHaveBeenCalledWith(window, display.bounds, 4)
    expect(detail.reservedBounds.width).toBe(4)
    expect(detail.bounds.width).toBe(1_040)

    controller.refresh()
    expect(appBar.reserve).toHaveBeenCalledTimes(2)
    expect(appBar.release).not.toHaveBeenCalled()

    controller.dispose()
    expect(appBar.release).toHaveBeenCalledWith(window)
  })
})
