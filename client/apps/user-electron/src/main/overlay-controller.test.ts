import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Display } from 'electron'
import type { AppBarAdapter } from './appbar'
import {
  UserOverlayController,
  collapseOverlayOnBlur,
} from './overlay-controller'

const display = {
  bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
  workArea: { x: 0, y: 0, width: 1_920, height: 1_040 },
} as Display

const makeWindow = () =>
  ({
    setBounds: vi.fn(),
    setMovable: vi.fn(),
    getBounds: vi.fn(() => ({ x: 100, y: 100, width: 560, height: 720 })),
  }) as unknown as BrowserWindow

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

it('collapses on external focus loss and notifies the renderer without releasing its AppBar', () => {
  let blur!: () => void
  const window = {
    setBounds: vi.fn(),
    setMovable: vi.fn(),
    on: vi.fn((_event, callback) => {
      blur = callback
    }),
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow
  const appBar: AppBarAdapter = {
    supported: false,
    reserve: vi.fn(),
    release: vi.fn(),
  }
  const controller = new UserOverlayController(window, () => display, appBar)
  controller.initialize()
  collapseOverlayOnBlur(window, controller)
  controller.setMode('DETAIL')
  blur()
  expect(window.setBounds).toHaveBeenLastCalledWith(
    expect.objectContaining({ width: 4 }),
    false,
  )
  expect(window.webContents.send).toHaveBeenLastCalledWith('overlay:collapsed')
  expect(appBar.release).not.toHaveBeenCalled()
  expect(controller.setMode('DETAIL').bounds.width).toBe(1040)
})

it('keeps the guide on top after blur, remembers its dragged position and restores the edge after closing', () => {
  let blur!: () => void
  let bounds = { x: 0, y: 0, width: 4, height: 1040 }
  const window = {
    setBounds: vi.fn((next) => {
      bounds = next
    }),
    getBounds: vi.fn(() => bounds),
    setMovable: vi.fn(),
    on: vi.fn((_event, callback) => {
      blur = callback
    }),
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow
  const appBar: AppBarAdapter = {
    supported: true,
    reserve: vi.fn(() => ({ x: 0, y: 0, width: 4, height: 1040 })),
    release: vi.fn(),
  }
  const controller = new UserOverlayController(window, () => display, appBar)
  controller.initialize()
  collapseOverlayOnBlur(window, controller)
  expect(controller.setMode('GUIDE').bounds).toEqual({
    x: 1336,
    y: 24,
    width: 560,
    height: 720,
  })
  expect(window.setMovable).toHaveBeenLastCalledWith(true)
  blur()
  expect(controller.mode).toBe('GUIDE')
  expect(window.webContents.send).not.toHaveBeenCalled()
  bounds = { ...bounds, x: 400, y: 100 }
  controller.keepGuideInWorkArea()
  expect(controller.refresh().bounds).toMatchObject({ x: 400, y: 100 })
  expect(controller.setMode('DETAIL').bounds.width).toBe(1040)
  expect(window.setMovable).toHaveBeenLastCalledWith(false)
  expect(controller.setMode('GUIDE').bounds).toMatchObject({ x: 400, y: 100 })
  bounds = { ...bounds, x: -100, y: 1500 }
  controller.keepGuideInWorkArea()
  expect(bounds).toMatchObject({ x: 0, y: 320 })
  expect(appBar.release).not.toHaveBeenCalled()
  expect(controller.setMode('COLLAPSED').bounds.width).toBe(4)
  controller.dispose()
  expect(appBar.release).toHaveBeenCalledOnce()
})
